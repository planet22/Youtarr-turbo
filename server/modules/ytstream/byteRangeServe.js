/**
 * server/modules/ytstream/byteRangeServe.js
 *
 * Range-serving helpers for byteRangeHlsMode.js's growing-file sessions:
 * the shared "wait until the encode has grown past the requested byte"
 * polling loop, and the resume-aware virtual-file range mapping used while
 * a resumed encode is still running (cached base file + growing resume
 * file presented as one file).
 */
const fs = require('fs');
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');
const { parseSingleRange, pipeFileToResponse } = require('./rangeFileServe');
const { isInZeroTail } = require('./byteRangeDeclaredLength');
const { getServableResumeBytes } = require('./mkvResume');

// A Range request landing past the current size can mean (a) the encode
// just hasn't reached that byte YET (wait, then serve for real instead of a
// hard 416 that errors the player) or (b) the encode is FINISHED and the
// byte genuinely doesn't exist (a real out-of-range request).
const SEEK_WAIT_TIMEOUT_MS = 45000;
const SEEK_WAIT_POLL_INTERVAL_MS = 500;

function statSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

/**
 * True for ffmpeg/ffprobe's own HTTP client (`Lavf/<version>`), i.e. Jellyfin
 * probing or transcoding the stream server-side rather than a browser
 * playing it. There is no protocol-level difference between the two kinds
 * of request - same GET, same Range header - so the User-Agent is the only
 * reliable tell.
 */
function isFfmpegClient(req) {
  const userAgent = (req.headers && req.headers['user-agent']) || '';
  return /^Lavf\//i.test(String(userAgent));
}

/**
 * If `req` carries a Range header whose start offset is beyond the current
 * size, polls for the encode to grow past it. Only waits while the encode
 * is genuinely still running; once `isDone()` is true there's nothing left
 * to wait for, so an out-of-range request really is out of range.
 *
 * @param {import('express').Request} req
 * @param {object} opts
 * @param {() => number} opts.getSize - current servable size in bytes
 * @param {() => boolean} opts.isDone - true once nothing more will be written
 * @param {() => boolean} opts.isFailed
 * @param {object} opts.logContext - merged into every log line (sessionKey, youtubeId)
 */
async function waitForRangeAvailable(req, { getSize, isDone, isFailed, logContext }) {
  const rangeHeader = req.headers.range;
  if (!rangeHeader) return;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match || match[1] === '') return; // malformed, or a suffix range ("bytes=-500") - not this helper's concern
  const requestedStart = Number(match[1]);
  if (!Number.isFinite(requestedStart)) return;

  let currentSize = getSize();
  if (currentSize > requestedStart) return; // already satisfiable

  const startedAt = Date.now();
  const deadline = startedAt + SEEK_WAIT_TIMEOUT_MS;
  streamDebug(
    { ...logContext, requestedStart, currentSize },
    'ytstream: hls-byterange requested range is past the current file size - waiting for the encode to catch up'
  );
  for (;;) {
    if (isDone()) {
      logger.info(
        { ...logContext, requestedStart, currentSize },
        'ytstream: hls-byterange encode has already finished and this range still does not exist - genuinely out of range'
      );
      return;
    }
    if (isFailed() || Date.now() >= deadline) {
      logger.warn(
        { ...logContext, requestedStart, currentSize, failed: isFailed(), timedOut: Date.now() >= deadline },
        'ytstream: hls-byterange gave up waiting for the requested range to become available'
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SEEK_WAIT_POLL_INTERVAL_MS));
    currentSize = getSize();
    if (currentSize > requestedStart) {
      logger.info(
        { ...logContext, requestedStart, currentSize, waitedMs: Date.now() - startedAt },
        'ytstream: hls-byterange requested range became available after waiting'
      );
      return;
    }
  }
}

/**
 * Maps a client Range header onto the virtual file `base ++ stream`.
 * Never straddles two physical files in one response: a range starting in
 * the base file is capped at the base file's last byte (the client just
 * issues its next Range request for the rest), mirroring how a live-growing
 * session already caps `end` to the current size regardless of what the
 * client asked for. A missing Range header is treated as `bytes=0-`.
 *
 * @returns {null | {source: 'base'|'stream', srcStart: number, srcEnd: number, start: number, end: number, total: number}}
 *   null when the range is unparseable or starts past the virtual end (416).
 */
function resolveVirtualRange({ rangeHeader, baseSize, streamSize }) {
  const total = baseSize + streamSize;
  if (total <= 0) return null;
  const range = parseSingleRange(rangeHeader || 'bytes=0-', total);
  if (!range) return null;
  if (range.start < baseSize) {
    const srcEnd = Math.min(range.end, baseSize - 1);
    return { source: 'base', srcStart: range.start, srcEnd, start: range.start, end: srcEnd, total };
  }
  return {
    source: 'stream',
    srcStart: range.start - baseSize,
    srcEnd: range.end - baseSize,
    start: range.start,
    end: range.end,
    total,
  };
}

/**
 * Serves one Range request for a session that advertised its final size up
 * front (session.declaredTotal - see byteRangeDeclaredLength.js). The
 * response carries the declared total in Content-Range, but only the bytes
 * written so far are sent (capped, never waited for here: the caller has
 * already waited for the range's START to exist, and a client just issues
 * its next Range request for the rest). A start that still isn't written
 * answers 416, same as today's behavior for a start past the file.
 */
function serveDeclaredRange(session, req, res, onServed, onBytesSent) {
  const total = session.declaredTotal;
  const written = statSize(session.streamPath);
  const range = parseSingleRange(req.headers.range || 'bytes=0-', total);
  // The file's last bytes are guaranteed zeros (see byteRangeDeclaredLength.js):
  // end-of-file probes are answered at once, whether or not the encode has
  // reached them.
  // Not for mkv: a Matroska tail of raw zeros isn't valid elements, and its
  // seek search reads real cluster data, so those reads just wait.
  if (range && !session.isMkv && isInZeroTail(range.start, total)) {
    const length = range.end - range.start + 1;
    streamDebug(
      { sessionKey: session.key, range: req.headers.range || null, start: range.start, end: range.end, total, written, bytes: length },
      'ytstream: hls-byterange declared-length serve - answering an end-of-file probe from the known zero tail without waiting (206)'
    );
    res.set({
      'Content-Type': session.contentType || 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
      'Content-Length': String(length),
    });
    res.status(206);
    if (onServed) onServed(length);
    if (onBytesSent) onBytesSent(length);
    res.end(Buffer.alloc(length));
    return;
  }
  if (!range || range.start >= written) {
    streamDebug(
      { sessionKey: session.key, range: req.headers.range || null, total, written },
      'ytstream: hls-byterange declared-length serve - range not available (yet), responding 416'
    );
    res.status(416).set('Content-Range', `bytes */${total}`).end();
    return;
  }
  const end = Math.min(range.end, written - 1);
  const length = end - range.start + 1;
  // Always 206 (even without a Range header): the response is capped at what
  // exists, so it is never the whole declared file.
  res.set({
    'Content-Type': session.contentType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${range.start}-${end}/${total}`,
    'Content-Length': String(length),
  });
  res.status(206);
  if (onServed) onServed(length);
  const fileStream = fs.createReadStream(session.streamPath, { start: range.start, end });
  fileStream.on('error', (err) => {
    logger.warn({ err, filePath: session.streamPath, sessionKey: session.key }, 'ytstream: hls-byterange declared-length serve - error reading file');
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  pipeFileToResponse(fileStream, res, onBytesSent);
}

/** Serves one Range request from a resume session's virtual file - see resolveVirtualRange. */
function serveResumeAwareRange(session, req, res, onServed, onBytesSent) {
  const baseSize = session.resumeBaseCopy.size;
  // mkv resume: only the resume file's clusters continue the base (its own
  // header is skipped), and nothing of it is servable until its first cluster
  // has been checked against the seam - see mkvResume.getServableResumeBytes.
  const mkvSeam = session.resumeBaseCopy.mkv || null;
  const streamSize = getServableResumeBytes(session, statSize(session.streamPath));
  const resolved = resolveVirtualRange({ rangeHeader: req.headers.range, baseSize, streamSize });
  if (!resolved) {
    streamDebug(
      { sessionKey: session.key, range: req.headers.range || null, baseSize, streamSize },
      'ytstream: hls-byterange resume serve - unparseable or out-of-range Range header, responding 416'
    );
    res.status(416).set('Content-Range', `bytes */${baseSize + streamSize}`).end();
    return;
  }
  const filePath = resolved.source === 'base' ? session.resumeBaseCopy.path : session.streamPath;
  const length = resolved.srcEnd - resolved.srcStart + 1;
  const skip = mkvSeam && resolved.source === 'stream' ? mkvSeam.streamSkip : 0;
  streamDebug(
    { sessionKey: session.key, source: resolved.source, start: resolved.start, end: resolved.end, total: resolved.total, streamSkip: skip },
    'ytstream: hls-byterange resume serve - serving Range request (206)'
  );
  // Always 206 (even for a request with no Range header): the response is
  // capped at the base file's end, so it is never the whole virtual file.
  res.set({
    'Content-Type': session.contentType || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${resolved.start}-${resolved.end}/${resolved.total}`,
    'Content-Length': String(length),
  });
  res.status(206);
  if (onServed) onServed(length);
  const fileStream = fs.createReadStream(filePath, { start: resolved.srcStart + skip, end: resolved.srcEnd + skip });
  fileStream.on('error', (err) => {
    logger.warn({ err, filePath, sessionKey: session.key }, 'ytstream: hls-byterange resume serve - error reading file');
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  pipeFileToResponse(fileStream, res, onBytesSent);
}

module.exports = { waitForRangeAvailable, resolveVirtualRange, serveResumeAwareRange, serveDeclaredRange, isFfmpegClient, statSize };
