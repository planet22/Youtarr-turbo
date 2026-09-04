/**
 * server/modules/tsRemuxCache.js
 *
 * Browsers' native <video> element has no MPEG-TS demuxer - Chrome/Firefox
 * reject a .ts source outright, and even Safari only accepts .ts inside an
 * HLS playlist, never as a plain progressive source - so a library file
 * whose container is .ts (produced by the NZB/Sonarr grab pipeline's ffmpeg
 * remux, or a finalized raw-buffer/hls-buffer download) can't play in
 * Youtarr's in-app player at all, regardless of what Content-Type header is
 * sent with it.
 *
 * These are already-finished, static files - not a live stream - so the fix
 * is a one-time, on-disk container remux (-c copy, no re-encode: just
 * repackaging the exact same video/audio bitstream into MP4) rather than
 * anything touching the live HLS session machinery. The result is a normal,
 * fully seekable MP4 file served like any other cached video.
 *
 * Cache entries are keyed by source path + size + mtime, so replacing or
 * re-downloading the source file invalidates the old remux automatically.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const logger = require('../logger');
const configModule = require('./configModule');

const REMUX_CACHE_DIR = path.join(configModule.directoryPath, '.youtarr_ytstream_cache', 'ts-remux');
const REMUX_TIMEOUT_MS = 5 * 60 * 1000;

// Dedupes concurrent requests for the same file (e.g. a player's initial
// GET and its immediate Range-based follow-up) onto a single ffmpeg run.
const inFlight = new Map();

function cacheKeyFor(filePath, stat) {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  return `${hash}-${stat.size}-${Math.round(stat.mtimeMs)}.mp4`;
}

/**
 * @param {string} filePath a real, on-disk .ts file
 * @returns {Promise<string|null>} path to a seekable .mp4 remux of it, or
 *   null if ffmpeg failed (caller should fall back to serving the .ts as-is)
 */
async function ensureSeekableMp4(filePath) {
  const stat = await fs.promises.stat(filePath);
  const cachePath = path.join(REMUX_CACHE_DIR, cacheKeyFor(filePath, stat));

  if (fs.existsSync(cachePath)) {
    logger.debug({ filePath, cachePath }, 'ytstream: .ts -> .mp4 remux already cached, skipping ffmpeg');
    return cachePath;
  }
  if (inFlight.has(cachePath)) {
    logger.debug({ filePath, cachePath }, 'ytstream: .ts -> .mp4 remux already in flight, joining it instead of starting a second one');
    return inFlight.get(cachePath);
  }

  const work = (async () => {
    await fs.promises.mkdir(REMUX_CACHE_DIR, { recursive: true });
    const tempPath = `${cachePath}.tmp-${process.pid}`;
    logger.debug({ filePath, cachePath, tempPath }, 'ytstream: starting .ts -> .mp4 remux');
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-y', '-loglevel', 'error',
          '-i', filePath,
          '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn',
          '-c', 'copy',
          '-movflags', '+faststart',
          '-f', 'mp4',
          tempPath,
        ]);
        let stderr = '';
        ff.stderr.on('data', (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
          ff.kill('SIGKILL');
          reject(new Error('ffmpeg remux timed out'));
        }, REMUX_TIMEOUT_MS);
        ff.on('error', (err) => { clearTimeout(timer); reject(err); });
        ff.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`ffmpeg remux exited ${code}: ${stderr.slice(-500)}`));
        });
      });
      await fs.promises.rename(tempPath, cachePath);
      logger.info({ filePath, cachePath }, 'ytstream: remuxed a .ts library file to a seekable .mp4 for in-app playback');
      return cachePath;
    } catch (err) {
      logger.warn({ err, filePath }, 'ytstream: .ts -> .mp4 remux failed; in-app player will fall back to the raw .ts');
      await fs.promises.unlink(tempPath).catch(() => {});
      return null;
    }
  })();

  inFlight.set(cachePath, work);
  try {
    return await work;
  } finally {
    inFlight.delete(cachePath);
  }
}

/**
 * Non-generating lookup: returns an already-finalized remux if one exists,
 * without ever triggering ffmpeg. For request paths that must never block on
 * a fresh remux (probes, real-time playback) - they should prefer this
 * result when present and just fall back to serving the original .ts
 * otherwise, same as if this module didn't exist for that request.
 * @param {string} filePath a real, on-disk .ts file
 * @returns {string|null} the cached .mp4 path if it already exists, else null
 */
function findExistingSeekableMp4(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cachePath = path.join(REMUX_CACHE_DIR, cacheKeyFor(filePath, stat));
    return fs.existsSync(cachePath) ? cachePath : null;
  } catch {
    return null;
  }
}

module.exports = { ensureSeekableMp4, findExistingSeekableMp4 };
