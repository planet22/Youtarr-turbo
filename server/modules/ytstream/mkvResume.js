/**
 * server/modules/ytstream/mkvResume.js
 *
 * Resume support for the MKV variant of mode=hls-byterange (Plain file). A
 * Matroska file is a header followed by self-contained Clusters, each with
 * an absolute timecode, so a cached partial can be extended by plain byte
 * splicing - no ffmpeg/ffprobe step:
 *
 *   base   = header + the clusters of the partial that lie before the seam
 *   resume = a fresh encode started AT the seam (yt-dlp --download-sections
 *            from a cluster that begins on a video keyframe, -copyts, so its
 *            cluster timecodes are absolute too)
 *   result = base + the resume file's clusters (its own header, and the Cues
 *            written when it finished, are left out)
 *
 * The seam is chosen from the base side (a keyframe-led cluster at least
 * RESUME_OVERLAP_SECONDS before the partial's end, so its untrustworthy tail
 * is dropped) and then verified against what the resume pass really wrote:
 * its first cluster must start where the base was cut. A resume that doesn't
 * line up is rejected and never installed.
 *
 * Pure functions over file paths; no session state.
 */
const fs = require('fs');
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;
const ID_CRC32 = 0xbf;
const ID_VOID = 0xec;

// ffmpeg writes the video as track 1 (the encode maps 0:v:0 first).
const VIDEO_TRACK_NUMBER = 1;
const KEYFRAME_FLAG = 0x80;
const DEFAULT_TIMECODE_SCALE_NS = 1000000; // 1 ms per tick
const MAX_ID_BYTES = 4;
const MAX_SIZE_BYTES = 8;
const HEADER_PEEK_BYTES = 32;
const CLUSTER_PEEK_BYTES = 48;
// ffmpeg puts a CRC-32 (and possibly a Void) ahead of a cluster's Timecode.
const MAX_ELEMENTS_BEFORE_TIMECODE = 4;
const MAX_CLUSTER_CHILDREN_SCANNED = 64;
const MAX_BLOCK_GROUP_SCAN_BYTES = 64 * 1024;
const COPY_HIGH_WATER_MARK = 4 * 1024 * 1024;

// Same overlap the mp4 resume uses: the partial's last stretch is the least
// trustworthy, and the resume re-covers it.
const RESUME_OVERLAP_SECONDS = 12;
const MIN_RESUMABLE_SECONDS = 30;
// The resume pass is told to start a hair AFTER the seam keyframe so ffmpeg's
// "keyframe at or before the target" lands on that keyframe, not the previous
// one (cluster timecodes are rounded to whole ms).
const SEEK_NUDGE_SECONDS = 0.05;
// How far the resume file's first cluster may sit from the seam: an audio
// packet can lead the keyframe by a frame or so; a whole GOP would mean the
// seek landed on the wrong keyframe.
const SEAM_TOLERANCE_MS = 500;
const MIN_GAIN_SECONDS = 1;

/** @returns {{value: number, length: number} | null} an EBML element ID at `at` */
function readId(buf, at) {
  if (at >= buf.length) return null;
  const first = buf[at];
  if (first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > MAX_ID_BYTES || at + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + buf[at + i];
  return { value, length };
}

/** @returns {{value: number, length: number, unknown: boolean} | null} an EBML size vint at `at` */
function readSize(buf, at) {
  if (at >= buf.length) return null;
  const first = buf[at];
  if (first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > MAX_SIZE_BYTES || at + length > buf.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + buf[at + i];
    if (buf[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: allOnes };
}

function readElementHeader(buf, at) {
  const id = readId(buf, at);
  if (!id) return null;
  const size = readSize(buf, at + id.length);
  if (!size) return null;
  return { id: id.value, headerLength: id.length + size.length, size: size.value, unknownSize: size.unknown };
}

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function readUint(buf, at, length) {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + buf[at + i];
  return value;
}

/** @returns {number|null} the cluster's own Timecode (ticks) from its first bytes, null when not written yet */
function readClusterTimecode(fd, dataStart) {
  const buf = readAt(fd, dataStart, CLUSTER_PEEK_BYTES);
  let at = 0;
  for (let i = 0; i < MAX_ELEMENTS_BEFORE_TIMECODE; i += 1) {
    const child = readElementHeader(buf, at);
    if (!child) return null;
    if (child.id === ID_TIMECODE) {
      if (at + child.headerLength + child.size > buf.length) return null;
      return readUint(buf, at + child.headerLength, child.size);
    }
    if (child.id !== ID_CRC32 && child.id !== ID_VOID) return null;
    at += child.headerLength + child.size;
  }
  return null;
}

/**
 * Whether the first VIDEO block of a cluster is a keyframe - i.e. whether
 * a decoder can start at this cluster's first video frame.
 */
function clusterStartsWithVideoKeyframe(fd, dataStart, dataEnd) {
  let pos = dataStart;
  for (let scanned = 0; scanned < MAX_CLUSTER_CHILDREN_SCANNED && pos < dataEnd; scanned += 1) {
    const buf = readAt(fd, pos, HEADER_PEEK_BYTES);
    const child = readElementHeader(buf, 0);
    if (!child || child.unknownSize) return false;
    if (child.id === ID_SIMPLE_BLOCK) {
      const track = readSize(buf, child.headerLength);
      if (track && track.value === VIDEO_TRACK_NUMBER) {
        const flags = buf[child.headerLength + track.length + 2];
        return flags !== undefined && (flags & KEYFRAME_FLAG) !== 0;
      }
    } else if (child.id === ID_BLOCK_GROUP && child.size <= MAX_BLOCK_GROUP_SCAN_BYTES) {
      const group = readAt(fd, pos + child.headerLength, child.size);
      let inner = 0;
      let isVideo = false;
      let hasReference = false;
      while (inner < group.length) {
        const item = readElementHeader(group, inner);
        if (!item) break;
        if (item.id === ID_BLOCK) {
          const track = readSize(group, inner + item.headerLength);
          isVideo = !!track && track.value === VIDEO_TRACK_NUMBER;
        } else if (item.id === ID_REFERENCE_BLOCK) {
          hasReference = true;
        }
        inner += item.headerLength + item.size;
      }
      if (isVideo) return !hasReference;
    }
    pos += child.headerLength + child.size;
  }
  return false;
}

function readTimecodeScale(fd, dataStart, size) {
  const info = readAt(fd, dataStart, Math.min(size, 512));
  let at = 0;
  while (at < info.length) {
    const child = readElementHeader(info, at);
    if (!child) break;
    if (child.id === ID_TIMECODE_SCALE) return readUint(info, at + child.headerLength, child.size);
    at += child.headerLength + child.size;
  }
  return DEFAULT_TIMECODE_SCALE_NS;
}

/**
 * Walks a Matroska file's top level: the header, then Clusters until the
 * first non-cluster element (Cues, Tags...), an open (unknown-size) cluster,
 * or a truncated one - none of which are counted.
 *
 * @param {string} filePath
 * @param {{firstClusterOnly?: boolean, startOffset?: number|null}} [options]
 *   `firstClusterOnly`: stop as soon as the first cluster's start is found (its
 *   timecode may still be unwritten: `timecode` null). `startOffset`: continue
 *   a previous scan from its `nextOffset` instead of re-reading the header.
 * @returns {{ok: true, fileSize: number, timecodeScale: number, clusters: Array<{offset: number, end: number, timecode: number, startsWithKeyframe: boolean}>, firstClusterOffset: number|null, firstClusterTimecode: number|null, nextOffset: number|null} | {ok: false, reason: string}}
 *   `nextOffset`: where an incremental scan should pick up (null until a cluster has been seen)
 */
function scanMkv(filePath, { firstClusterOnly = false, startOffset = null } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    let pos = 0;
    let timecodeScale = DEFAULT_TIMECODE_SCALE_NS;
    let firstClusterOffset = null;
    let firstClusterTimecode = null;
    if (startOffset !== null) {
      pos = startOffset;
      firstClusterOffset = startOffset;
    } else {
      const head = readAt(fd, 0, HEADER_PEEK_BYTES);
      const ebml = readElementHeader(head, 0);
      if (!ebml || ebml.id !== ID_EBML) return { ok: false, reason: 'not a Matroska file (no EBML header)' };
      pos = ebml.headerLength + ebml.size;
      const segment = readElementHeader(readAt(fd, pos, HEADER_PEEK_BYTES), 0);
      if (!segment || segment.id !== ID_SEGMENT) return { ok: false, reason: 'no Segment after the EBML header' };
      pos += segment.headerLength;
    }
    const clusters = [];
    while (pos < fileSize) {
      const buf = readAt(fd, pos, HEADER_PEEK_BYTES);
      const element = readElementHeader(buf, 0);
      if (!element) break;
      const dataStart = pos + element.headerLength;
      if (element.id === ID_CLUSTER) {
        if (firstClusterOffset === null) {
          firstClusterOffset = pos;
          firstClusterTimecode = readClusterTimecode(fd, dataStart);
          if (firstClusterOnly) break;
        }
        if (element.unknownSize) break;
        const end = dataStart + element.size;
        if (end > fileSize) break;
        const timecode = readClusterTimecode(fd, dataStart);
        if (timecode === null) break;
        clusters.push({ offset: pos, end, timecode, startsWithKeyframe: clusterStartsWithVideoKeyframe(fd, dataStart, end) });
        pos = end;
        continue;
      }
      if (clusters.length > 0 || firstClusterOffset !== null) break; // Cues/Tags after the clusters
      if (element.unknownSize) break;
      if (element.id === ID_INFO) timecodeScale = readTimecodeScale(fd, dataStart, element.size);
      pos = dataStart + element.size;
    }
    return { ok: true, fileSize, timecodeScale, clusters, firstClusterOffset, firstClusterTimecode, nextOffset: firstClusterOffset !== null ? pos : null };
  } catch (err) {
    return { ok: false, reason: `cannot scan file: ${err.message}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Picks where to cut a cached partial: the last cluster that starts on a
 * video keyframe and lies at least `overlapSeconds` before the partial's
 * last complete cluster. Everything from that cluster on is dropped and
 * re-encoded by the resume pass.
 *
 * @param {ReturnType<typeof scanMkv>} scan
 * @returns {{ok: true, cutOffset: number, seamMs: number, resumeFromSeconds: number, cachedEndSeconds: number, keptClusters: number} | {ok: false, reason: string}}
 */
function pickResumePoint(scan, { overlapSeconds = RESUME_OVERLAP_SECONDS, minSeconds = MIN_RESUMABLE_SECONDS } = {}) {
  if (!scan.ok) return { ok: false, reason: scan.reason };
  if (scan.timecodeScale !== DEFAULT_TIMECODE_SCALE_NS) return { ok: false, reason: `unsupported TimecodeScale ${scan.timecodeScale}` };
  const { clusters } = scan;
  if (clusters.length < 2) return { ok: false, reason: 'fewer than two complete clusters' };
  const lastMs = clusters[clusters.length - 1].timecode;
  const limitMs = lastMs - overlapSeconds * 1000;
  for (let i = clusters.length - 1; i >= 1; i -= 1) {
    const cluster = clusters[i];
    if (cluster.timecode > limitMs || !cluster.startsWithKeyframe) continue;
    if (cluster.timecode < minSeconds * 1000) break;
    return {
      ok: true,
      cutOffset: cluster.offset,
      seamMs: cluster.timecode,
      resumeFromSeconds: cluster.timecode / 1000 + SEEK_NUDGE_SECONDS,
      cachedEndSeconds: lastMs / 1000,
      keptClusters: i,
    };
  }
  return { ok: false, reason: 'no keyframe-led cluster far enough before the end of the partial' };
}

/**
 * Where the resume file's first cluster starts and what timecode it carries.
 * @returns {{ok: true, clusterOffset: number, timecodeMs: number} | {ok: false, retry: boolean, reason: string}}
 *   `retry` while the resume pass hasn't written its first cluster yet
 */
function findResumeSeam(filePath) {
  const scan = scanMkv(filePath, { firstClusterOnly: true });
  if (!scan.ok) return { ok: false, retry: true, reason: scan.reason };
  if (scan.firstClusterOffset === null || scan.firstClusterTimecode === null) return { ok: false, retry: true, reason: 'first cluster not written yet' };
  return { ok: true, clusterOffset: scan.firstClusterOffset, timecodeMs: scan.firstClusterTimecode };
}

/**
 * Live view of a resume session's seam: once the resume file has its first
 * cluster, checks it starts where the base was cut and records how many of
 * its bytes to skip (its own header). Updates `state` on the session's
 * `resumeBaseCopy.mkv`: 'pending' -> 'ok' | 'mismatch'. Never throws.
 * @returns {'pending'|'ok'|'mismatch'}
 */
function refreshLiveSeam(session) {
  const seam = session.resumeBaseCopy && session.resumeBaseCopy.mkv;
  if (!seam || seam.state !== 'pending') return seam ? seam.state : 'ok';
  const found = findResumeSeam(session.streamPath);
  if (!found.ok) return 'pending';
  const offsetMs = found.timecodeMs - seam.seamMs;
  seam.firstTimecodeMs = found.timecodeMs;
  if (Math.abs(offsetMs) > SEAM_TOLERANCE_MS) {
    seam.state = 'mismatch';
    logger.warn(
      { sessionKey: session.key, youtubeId: session.youtubeId, expectedSeamMs: seam.seamMs, resumeFirstClusterMs: found.timecodeMs, offsetMs },
      'ytstream: hls-byterange mkv resume does not line up with the cached base - the resume pass started at a different point than the seam'
    );
    return 'mismatch';
  }
  seam.streamSkip = found.clusterOffset;
  seam.state = 'ok';
  logger.info(
    { sessionKey: session.key, youtubeId: session.youtubeId, seamMs: seam.seamMs, resumeFirstClusterMs: found.timecodeMs, offsetMs, streamSkip: found.clusterOffset, baseBytes: session.resumeBaseCopy.size },
    'ytstream: hls-byterange mkv resume seam verified - serving cached base then the resume pass'
  );
  return 'ok';
}

/** @returns {number} how many bytes of the resume file are servable as the continuation of the base */
function getServableResumeBytes(session, fileSize) {
  const seam = session.resumeBaseCopy && session.resumeBaseCopy.mkv;
  if (!seam) return fileSize;
  if (refreshLiveSeam(session) !== 'ok') return 0;
  return Math.max(0, fileSize - seam.streamSkip);
}

/**
 * What the Streaming page's progress popup shows for an mkv session: the
 * clusters written so far (start time + size of each, read from the file
 * itself - scanned incrementally across polls), how far the encode has got
 * in time, and the declared final size. Never throws.
 */
function getMkvProgress(session) {
  const seam = session.resumeBaseCopy && session.resumeBaseCopy.mkv;
  const state = session.mkvClusterIndex || (session.mkvClusterIndex = { nextOffset: null, clusters: [] });
  // A resume file's clusters only count once its seam has been verified.
  if (!seam || refreshLiveSeam(session) === 'ok') {
    const scan = scanMkv(session.streamPath, { startOffset: state.nextOffset });
    if (scan.ok) {
      state.clusters.push(...scan.clusters);
      state.nextOffset = scan.nextOffset;
    }
  }
  const { clusters } = state;
  return {
    durationSeconds: session.durationSeconds || null,
    declaredTotalBytes: session.declaredTotal,
    encodedSeconds: clusters.length ? clusters[clusters.length - 1].timecode / 1000 : (seam ? seam.seamMs / 1000 : null),
    clusterStartsMs: clusters.map((cluster) => cluster.timecode),
    clusterBytes: clusters.map((cluster) => cluster.end - cluster.offset),
    cachedBytes: seam ? session.resumeBaseCopy.size : 0,
    resumeSeamMs: seam ? seam.seamMs : null,
    resumeState: seam ? seam.state : null,
  };
}

function appendRange(sourcePath, start, endExclusive, destination) {
  return new Promise((resolve, reject) => {
    if (endExclusive <= start) { resolve(); return; }
    const source = fs.createReadStream(sourcePath, { start, end: endExclusive - 1, highWaterMark: COPY_HIGH_WATER_MARK });
    source.on('error', reject);
    source.on('end', resolve);
    source.pipe(destination, { end: false });
  });
}

/**
 * Splices the resume pass's clusters onto the cached base and validates the
 * result. On any problem nothing is left at `outPath`.
 *
 * @param {object} args
 * @param {string} args.basePath - the base snapshot, already cut at the seam
 * @param {string} args.resumePath - the resume pass's own output
 * @param {string} args.outPath
 * @param {number} args.seamMs - timecode of the cluster the base was cut at
 * @param {number} args.previousDurationSeconds - the cached partial's end before this resume
 * @returns {Promise<{ok: true, durationSeconds: number, clusters: number} | {ok: false, reason: string, permanent: boolean}>}
 *   `permanent`: the resume can never line up (do not try again from this partial)
 */
async function stitchMkvResume({ basePath, resumePath, outPath, seamMs, previousDurationSeconds }) {
  const fail = (reason, permanent = false) => {
    fs.rmSync(outPath, { force: true });
    return { ok: false, reason, permanent };
  };
  try {
    const resumeScan = scanMkv(resumePath);
    if (!resumeScan.ok) return fail(`resume file unreadable: ${resumeScan.reason}`);
    if (resumeScan.clusters.length === 0) return fail('resume pass wrote no complete cluster');
    const first = resumeScan.clusters[0];
    const offsetMs = first.timecode - seamMs;
    if (Math.abs(offsetMs) > SEAM_TOLERANCE_MS) {
      return fail(`resume pass began ${offsetMs} ms from the seam (first cluster at ${first.timecode} ms, seam ${seamMs} ms)`, true);
    }
    const last = resumeScan.clusters[resumeScan.clusters.length - 1];
    if (last.timecode / 1000 < previousDurationSeconds + MIN_GAIN_SECONDS) {
      return fail(`resume pass only reached ${(last.timecode / 1000).toFixed(1)}s, no further than the cached ${previousDurationSeconds.toFixed(1)}s`);
    }
    const baseScan = scanMkv(basePath);
    if (!baseScan.ok) return fail(`base unreadable: ${baseScan.reason}`, true);

    const destination = fs.createWriteStream(outPath);
    const finished = new Promise((resolve, reject) => { destination.on('finish', resolve); destination.on('error', reject); });
    try {
      await appendRange(basePath, 0, baseScan.fileSize, destination);
      await appendRange(resumePath, first.offset, last.end, destination);
    } finally {
      destination.end();
    }
    await finished;

    const outScan = scanMkv(outPath);
    const expectedClusters = baseScan.clusters.length + resumeScan.clusters.length;
    if (!outScan.ok || outScan.clusters.length !== expectedClusters) {
      return fail(`spliced file has ${outScan.ok ? outScan.clusters.length : 0} clusters, expected ${expectedClusters}`, true);
    }
    for (let i = 1; i < outScan.clusters.length; i += 1) {
      if (outScan.clusters[i].timecode < outScan.clusters[i - 1].timecode) return fail(`cluster timecodes go backwards at cluster ${i}`, true);
    }
    streamDebug(
      { baseClusters: baseScan.clusters.length, resumeClusters: resumeScan.clusters.length, seamMs, offsetMs, endSeconds: last.timecode / 1000 },
      'ytstream: hls-byterange mkv resume spliced'
    );
    return { ok: true, durationSeconds: last.timecode / 1000, clusters: outScan.clusters.length };
  } catch (err) {
    logger.warn({ err: err.message }, 'ytstream: hls-byterange mkv resume splice failed');
    return fail(`splice failed: ${err.message}`);
  }
}

module.exports = {
  RESUME_OVERLAP_SECONDS,
  SEAM_TOLERANCE_MS,
  scanMkv,
  pickResumePoint,
  findResumeSeam,
  refreshLiveSeam,
  getServableResumeBytes,
  getMkvProgress,
  stitchMkvResume,
};
