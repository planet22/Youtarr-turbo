/**
 * server/modules/ytstream/byteRangeResume.js
 *
 * Resume/extend support for byteRangeHlsMode.js's stealth cache
 * (`ytstream.byteRangeResumeCache`): given a partial cached encode, work out
 * where to resume from, and stitch a resumed encode's new tail onto the
 * cached head using stream-copy passes only (no re-encode).
 *
 * Nothing here touches session state - callers (byteRangeHlsMode.js) hand
 * in file paths and get a result back, which keeps the planning logic pure
 * and unit-testable without ffmpeg.
 *
 * Every ffprobe/ffmpeg step is best-effort: any failure returns
 * `{ ok: false, reason }` and the caller leaves the existing cache entry
 * untouched - a stitch must never install something worse than what's
 * already cached.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('../../logger');

// Deliberate overlap (two 6s segments): the cached file's last fragment may
// have been cut mid-write, so resume re-covers it instead of trusting it,
// and there is real overlapping content to align the seam against.
const RESUME_OVERLAP_SECONDS = 12;
// Below this a resume saves nothing worth the extra machinery.
const MIN_RESUMABLE_DURATION_SECONDS = 30;
// The seam is cut this far before the cached file's real end, so the (least
// trustworthy) final stretch of the cached file is never relied on.
const SEAM_MARGIN_SECONDS = 2;
// A stitched result must be at least this much longer than what's already
// cached, else it isn't worth installing.
const MIN_GAIN_SECONDS = 1;
// Allowed disagreement between the stitched file's measured duration and
// what the resume pass alone implies (keyframe snap, muxer rounding).
const DURATION_TOLERANCE_SECONDS = 4;
const FFPROBE_TIMEOUT_MS = 2 * 60 * 1000;
const FFMPEG_STEP_TIMEOUT_MS = 10 * 60 * 1000;
const PROCESS_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
// Same fragmented shape as the cached files themselves (an HLS single_file
// fmp4), so a stitched entry is served exactly like a fresh one.
const FRAGMENTED_MP4_ARGS = ['-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'];
// Top-level boxes after which the file is at a clean cut point. Deliberately
// excludes 'moof': a moof without its mdat is a dangling half-fragment.
const BOX_TYPE_MOOF = 'moof';

/**
 * @param {number|null|undefined} cachedDurationSeconds
 * @returns {number|null} where the resume pass should start (seconds since
 *   the start of the whole video), or null when the cached entry is too
 *   short/unknown to be worth resuming.
 */
function computeResumeFromSeconds(cachedDurationSeconds) {
  if (!Number.isFinite(cachedDurationSeconds) || cachedDurationSeconds < MIN_RESUMABLE_DURATION_SECONDS) return null;
  return Math.max(0, cachedDurationSeconds - RESUME_OVERLAP_SECONDS);
}

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: PROCESS_MAX_BUFFER_BYTES, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

/**
 * Parses `ffprobe -show_entries packet=pts_time,duration_time,flags -of csv=p=0`
 * output. Returns null when no usable packet line exists.
 * @returns {{startTime: number, endTime: number, keyframeTimes: number[]} | null}
 */
function parsePacketScan(stdout) {
  let startTime = Infinity;
  let endTime = -Infinity;
  const keyframeTimes = [];
  for (const line of String(stdout || '').split('\n')) {
    const [ptsStr, durStr, flags = ''] = line.trim().split(',');
    const pts = Number(ptsStr);
    if (ptsStr === undefined || ptsStr === '' || !Number.isFinite(pts)) continue;
    const duration = Number(durStr);
    startTime = Math.min(startTime, pts);
    endTime = Math.max(endTime, pts + (Number.isFinite(duration) ? duration : 0));
    if (flags.includes('K')) keyframeTimes.push(pts);
  }
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  keyframeTimes.sort((a, b) => a - b);
  return { startTime, endTime, keyframeTimes };
}

/**
 * Scans a file's video packets for its real first/last timestamp and
 * keyframe positions. A packet scan rather than `format=duration`, because
 * a fragmented MP4 written without an index (which is what the HLS
 * single_file muxer produces) commonly reports its duration as N/A.
 * Never throws; null on any failure (no ffprobe, corrupt file, timeout).
 */
async function scanVideoPackets(filePath) {
  try {
    const stdout = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time,flags', '-of', 'csv=p=0', filePath],
      FFPROBE_TIMEOUT_MS
    );
    return parsePacketScan(stdout);
  } catch (err) {
    logger.warn({ err: err.message, filePath }, 'ytstream: hls-byterange packet scan failed');
    return null;
  }
}

/** @returns {Promise<number|null>} the file's real end time in seconds, or null if it can't be determined. */
async function probeDurationSeconds(filePath) {
  const scan = await scanVideoPackets(filePath);
  return scan && scan.endTime > 0 ? scan.endTime : null;
}

/**
 * Decides where to cut the cached head and where to start the resumed tail.
 *
 * The resume file's timestamps are either absolute (`-copyts` survived
 * through the fmp4 muxer, first packet near `resumeFromSeconds`) or
 * re-zeroed (first packet near 0) - detected by which the first packet is
 * closer to. The cut lands on the LAST resume keyframe at or before the
 * cached head's real end minus SEAM_MARGIN_SECONDS: cutting the tail on a
 * keyframe means neither a gap nor duplicated frames at the seam.
 *
 * @param {object} args
 * @param {{startTime: number, endTime: number}} args.baseScan
 * @param {{startTime: number, endTime: number, keyframeTimes: number[]}|null} args.resumeScan
 * @param {number} args.resumeFromSeconds
 * @returns {{ok: true, cutAbsSeconds: number, trimStartRelSeconds: number, expectedEndSeconds: number, absoluteMode: boolean} | {ok: false, reason: string}}
 */
function planSeam({ baseScan, resumeScan, resumeFromSeconds }) {
  if (!baseScan) return { ok: false, reason: 'cached base file could not be scanned' };
  if (!resumeScan || resumeScan.keyframeTimes.length === 0) return { ok: false, reason: 'resume file has no video keyframes' };

  const absoluteMode = resumeFromSeconds > 1 && Math.abs(resumeScan.startTime - resumeFromSeconds) < resumeScan.startTime;
  const toAbs = (fileTime) => (absoluteMode ? fileTime : fileTime + resumeFromSeconds);

  const limitAbs = baseScan.endTime - SEAM_MARGIN_SECONDS;
  let cutKeyframe = null;
  for (const keyframeTime of resumeScan.keyframeTimes) {
    if (toAbs(keyframeTime) > limitAbs) break;
    cutKeyframe = keyframeTime;
  }
  if (cutKeyframe === null) {
    return { ok: false, reason: 'no resume keyframe at or before the cached file end - would leave a gap' };
  }
  return {
    ok: true,
    absoluteMode,
    cutAbsSeconds: toAbs(cutKeyframe),
    trimStartRelSeconds: cutKeyframe - resumeScan.startTime,
    expectedEndSeconds: toAbs(resumeScan.endTime),
  };
}

/**
 * Walks a file's top-level MP4 boxes and returns the byte offset just past
 * the last COMPLETE one (never just past a moof - see BOX_TYPE_MOOF). A
 * session cut off mid-write can leave a truncated final box; trimming to
 * this offset leaves a well-formed file.
 * @returns {number}
 */
function findCompleteBoxEnd(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    let lastGood = 0;
    while (offset + 8 <= fileSize) {
      const bytesRead = fs.readSync(fd, header, 0, 16, offset);
      if (bytesRead < 8) break;
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) {
        if (bytesRead < 16) break;
        boxSize = Number(header.readBigUInt64BE(8));
      } else if (boxSize === 0) {
        return fileSize; // box runs to EOF by definition
      }
      if (boxSize < 8 || offset + boxSize > fileSize) break;
      offset += boxSize;
      if (type !== BOX_TYPE_MOOF) lastGood = offset;
    }
    return lastGood;
  } finally {
    fs.closeSync(fd);
  }
}

// ffconcat single-quoted path: a literal ' is written as '\'' (close quote,
// escaped quote, reopen quote).
const CONCAT_QUOTE = '\'';
const CONCAT_ESCAPED_QUOTE = '\'\\\'\'';

function quoteConcatPath(filePath) {
  return CONCAT_QUOTE + filePath.split(CONCAT_QUOTE).join(CONCAT_ESCAPED_QUOTE) + CONCAT_QUOTE;
}

/**
 * Stitches a resume pass's output onto the cached base file:
 *   1. base  -> part1 (stream copy, cut at the seam)
 *   2. resume -> part2 (stream copy, starting exactly on the seam keyframe)
 *   3. concat demuxer over part1+part2 -> `outPath` (fragmented MP4)
 * then validates the result before reporting success. On any failure the
 * partial `outPath` is removed and `{ ok: false, reason }` returned.
 *
 * @param {object} args
 * @param {string} args.basePath - snapshot of the cached partial file
 * @param {string} args.resumePath - the resume pass's own output file
 * @param {string} args.workDir - scratch dir for intermediate parts
 * @param {string} args.outPath - where the stitched file is written (same filesystem as its final destination)
 * @param {number} args.resumeFromSeconds - where the resume pass was told to start
 * @param {number} args.previousDurationSeconds - the cached entry's recorded duration
 * @returns {Promise<{ok: true, durationSeconds: number} | {ok: false, reason: string}>}
 */
async function stitchResumeFiles({ basePath, resumePath, workDir, outPath, resumeFromSeconds, previousDurationSeconds }) {
  const fail = (reason) => {
    fs.rmSync(outPath, { force: true });
    return { ok: false, reason };
  };
  try {
    const [baseScan, resumeScan] = await Promise.all([scanVideoPackets(basePath), scanVideoPackets(resumePath)]);
    const plan = planSeam({ baseScan, resumeScan, resumeFromSeconds });
    if (!plan.ok) return fail(plan.reason);
    if (plan.expectedEndSeconds < previousDurationSeconds + MIN_GAIN_SECONDS) {
      return fail(`resume pass only reached ${plan.expectedEndSeconds.toFixed(1)}s, no further than the cached ${previousDurationSeconds.toFixed(1)}s`);
    }

    const part1 = path.join(workDir, 'part1.mp4');
    const part2 = path.join(workDir, 'part2.mp4');
    const list = path.join(workDir, 'concat.txt');

    await run('ffmpeg', ['-y', '-v', 'error', '-i', basePath, '-t', String(plan.cutAbsSeconds - baseScan.startTime), '-c', 'copy', ...FRAGMENTED_MP4_ARGS, part1], FFMPEG_STEP_TIMEOUT_MS);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(plan.trimStartRelSeconds), '-i', resumePath, '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...FRAGMENTED_MP4_ARGS, part2], FFMPEG_STEP_TIMEOUT_MS);
    fs.writeFileSync(list, `ffconcat version 1.0\nfile ${quoteConcatPath(part1)}\nfile ${quoteConcatPath(part2)}\n`);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...FRAGMENTED_MP4_ARGS, outPath], FFMPEG_STEP_TIMEOUT_MS);

    const outDuration = await probeDurationSeconds(outPath);
    if (outDuration === null) return fail('stitched file could not be probed');
    if (outDuration < previousDurationSeconds + MIN_GAIN_SECONDS) {
      return fail(`stitched file (${outDuration.toFixed(1)}s) is not longer than the cached one (${previousDurationSeconds.toFixed(1)}s)`);
    }
    if (Math.abs(outDuration - plan.expectedEndSeconds) > DURATION_TOLERANCE_SECONDS) {
      return fail(`stitched duration ${outDuration.toFixed(1)}s disagrees with the expected ${plan.expectedEndSeconds.toFixed(1)}s - seam looks broken`);
    }
    logger.info(
      { cutAbsSeconds: plan.cutAbsSeconds, absoluteMode: plan.absoluteMode, outDuration, previousDurationSeconds },
      'ytstream: hls-byterange stitched resume onto cached base'
    );
    return { ok: true, durationSeconds: outDuration };
  } catch (err) {
    logger.warn({ err: err.message, stderr: err.stderr }, 'ytstream: hls-byterange stitch step failed');
    return fail(`stitch step failed: ${err.message}`);
  }
}

module.exports = {
  RESUME_OVERLAP_SECONDS,
  computeResumeFromSeconds,
  parsePacketScan,
  scanVideoPackets,
  probeDurationSeconds,
  planSeam,
  findCompleteBoxEnd,
  quoteConcatPath,
  stitchResumeFiles,
};
