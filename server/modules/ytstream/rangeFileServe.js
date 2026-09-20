/**
 * server/modules/ytstream/rangeFileServe.js
 *
 * Minimal HTTP Range/206 Partial Content support for serving a single real
 * file on disk. New, standalone helper for the two experimental playback
 * modes (byteRangeHlsMode.js, downloadCacheMode.js) - the existing HLS asset
 * route (hlsEngine.js's createHlsAssetRouteHandler) never needed this
 * because it always sends whole per-segment files, so there was nothing to
 * reuse; writing it fresh here also means these experimental modes don't
 * depend on (and can't regress) that existing route.
 *
 * Only single-range requests are handled (`bytes=start-end`,
 * `bytes=start-`, `bytes=-suffixLength`) - every real player/HLS client
 * this app targets only ever sends one range per request. A multi-range
 * request is treated as if no Range header were sent (whole-file 200).
 */
const fs = require('fs');
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');

function parseSingleRange(rangeHeader, fileSize) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return null;

  let start;
  let end;
  if (startStr === '') {
    // Suffix form: "bytes=-500" means "the last 500 bytes".
    const suffixLength = Number(endStr);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? fileSize - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

/**
 * Pipes `fileStream` into `res`, reporting the bytes actually read for the
 * response as they go (`onBytesSent`) and releasing the file handle when the
 * client goes away. `onServed`-style callbacks report the length a response
 * WOULD send - a player that opens `bytes=0-` and aborts after a few MB makes
 * that a wild overcount, so byte counters use this instead.
 */
function pipeFileToResponse(fileStream, res, onBytesSent) {
  if (onBytesSent) fileStream.on('data', (chunk) => onBytesSent(chunk.length));
  res.on('close', () => fileStream.destroy());
  fileStream.pipe(res);
}

/**
 * @param {string} filePath - real path on disk, already resolved/validated by the caller.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} contentType
 * @param {(bytes: number) => void} [onServed] - called once, synchronously,
 *   with the number of bytes about to be sent (the real response
 *   Content-Length) - callers use this to feed activeStreams.js's byte
 *   counter (see byteRangeHlsMode.js/downloadCacheMode.js), same as
 *   hlsEngine.js's own asset route does for its segment files.
 * @param {(bytes: number) => void} [onBytesSent] - called for each chunk
 *   actually read for the response, so it stops when the client disconnects
 *   (unlike onServed, which reports the requested length up front).
 */
function serveFileWithRangeSupport(filePath, req, res, contentType, onServed, onBytesSent) {
  streamDebug({ filePath, range: req.headers.range || null }, 'ytstream: serveFileWithRangeSupport - request received');
  fs.stat(filePath, (statErr, stat) => {
    if (statErr) {
      logger.warn({ err: statErr.message, filePath }, 'ytstream: serveFileWithRangeSupport - file not found');
      res.status(404).send('File not found');
      return;
    }

    const range = req.headers.range ? parseSingleRange(req.headers.range, stat.size) : null;
    if (req.headers.range && !range) {
      streamDebug({ filePath, range: req.headers.range, fileSize: stat.size }, 'ytstream: serveFileWithRangeSupport - unparseable/unsupported Range header, responding 416');
      res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
      return;
    }

    res.set({ 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    if (!range) {
      streamDebug({ filePath, fileSize: stat.size }, 'ytstream: serveFileWithRangeSupport - no Range header, serving whole file (200)');
      res.set('Content-Length', String(stat.size));
      res.status(200);
      if (onServed) onServed(stat.size);
      pipeFileToResponse(fs.createReadStream(filePath), res, onBytesSent);
      return;
    }

    const rangeLength = range.end - range.start + 1;
    streamDebug({ filePath, fileSize: stat.size, start: range.start, end: range.end, rangeLength }, 'ytstream: serveFileWithRangeSupport - serving Range request (206)');
    res.set({
      'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'Content-Length': String(rangeLength),
    });
    res.status(206);
    if (onServed) onServed(rangeLength);
    const fileStream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    fileStream.on('error', (err) => {
      logger.warn({ err, filePath }, 'ytstream: serveFileWithRangeSupport - error reading file');
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    pipeFileToResponse(fileStream, res, onBytesSent);
  });
}

module.exports = { serveFileWithRangeSupport, parseSingleRange, pipeFileToResponse };
