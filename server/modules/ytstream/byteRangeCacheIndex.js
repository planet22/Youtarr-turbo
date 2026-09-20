/**
 * server/modules/ytstream/byteRangeCacheIndex.js
 *
 * Directory-level view of mode=hls-byterange's stealth cache
 * (`.byterange-cache/<sessionKeyHash>.mp4` + `<sessionKeyHash>.json`
 * sidecar, written by byteRangeHlsMode.js). The filenames are a hash of the
 * playback params, so the sidecar's `youtubeId` is the only way to map an
 * entry back to a video - which is what lets untrackedBufferCache.js's
 * list/stat/delete/sweep helpers (and through them the Library page's
 * stealth-cache indicators) treat these entries like hls-buffer's own hidden
 * cache. Kept separate from that hls-buffer directory on purpose: hls-buffer
 * playback serves whatever it finds there as a finished file, which must
 * never be a partial byte-range entry.
 *
 * Every identifiable entry is reported, complete or not: a partial one
 * (sidecar `complete === false`, e.g. an encode cut off early) is flagged
 * `partial: true` so the Library page can mark it as not a full copy.
 * Delete/sweep act on every file in the directory regardless.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../../logger');
const { YTSTREAM_CACHE_DIR } = require('./paths');

const PERSISTENT_CACHE_DIR = path.join(YTSTREAM_CACHE_DIR, '.byterange-cache');
const META_EXT = '.json';
// `.mkv` for entries written by Container = MKV; those made before mkv had
// its own extension are `.mp4`, so both are recognised.
const FILE_EXTS = ['.mp4', '.mkv'];
// An in-progress encode is written straight into this directory as
// `<key>.partial-<random>.mp4` (ytstream.hlsStorageLocation=cache; keeps the
// .mp4 extension for ffmpeg) and only renamed to `<key>.mp4` once it is safe
// to serve - see byteRangeHlsMode.js. Never counted as a cached entry.
const PARTIAL_MARKER = '.partial-';
// A partial modified more recently than this belongs to a live encode:
// bulk clear/delete must not pull it out from under a running session.
const FRESH_PARTIAL_MS = 10 * 60 * 1000;

/** True for a finished cache entry's data file (`<key>.mp4` / `<key>.mkv`), not a sidecar, temp file or in-progress partial. */
function isEntryFile(name) {
  return FILE_EXTS.some((ext) => name.endsWith(ext)) && !name.includes(PARTIAL_MARKER);
}

function isFreshPartial(name, stat) {
  return name.includes(PARTIAL_MARKER) && Date.now() - stat.mtimeMs < FRESH_PARTIAL_MS;
}

function readMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<Array<{youtubeId: string, size: number, mtime: string, filePath: string, partial: boolean}>>}
 *   one row per identifiable cache entry (a video cached at several
 *   quality/transcode combinations yields one row per combination).
 */
async function listByteRangeCacheEntries() {
  if (!fs.existsSync(PERSISTENT_CACHE_DIR)) return [];
  const names = await fs.promises.readdir(PERSISTENT_CACHE_DIR);
  const results = [];
  for (const name of names) {
    if (path.extname(name) !== META_EXT) continue;
    const meta = readMeta(path.join(PERSISTENT_CACHE_DIR, name));
    if (!meta || typeof meta.youtubeId !== 'string') continue;
    const baseName = path.basename(name, META_EXT);
    for (const ext of FILE_EXTS) {
      const filePath = path.join(PERSISTENT_CACHE_DIR, `${baseName}${ext}`);
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;
        results.push({ youtubeId: meta.youtubeId, size: stat.size, mtime: stat.mtime.toISOString(), filePath, partial: meta.complete === false });
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') logger.warn({ err, filePath }, 'ytstream: failed to stat one byte-range cache entry while listing');
      }
    }
  }
  return results;
}

/** Deletes one cache entry's files (data, sidecar, any persist/stitch temp leftovers sharing its base name). */
async function deleteEntryFiles(baseName) {
  let deletedFiles = 0;
  let freedBytes = 0;
  const names = await fs.promises.readdir(PERSISTENT_CACHE_DIR);
  for (const name of names) {
    if (!name.startsWith(`${baseName}.`)) continue;
    const filePath = path.join(PERSISTENT_CACHE_DIR, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (isFreshPartial(name, stat)) continue;
      await fs.promises.unlink(filePath);
      if (isEntryFile(name)) deletedFiles += 1;
      freedBytes += stat.size;
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err, filePath }, 'ytstream: failed to delete one byte-range cache file');
    }
  }
  return { deletedFiles, freedBytes };
}

/**
 * Deletes every byte-range cache entry (complete or partial) recorded for a
 * video. Entries with no `youtubeId` in their sidecar can't be attributed
 * to a video and are left alone.
 * @returns {Promise<{deletedFiles: number, freedBytes: number}>}
 */
async function deleteByteRangeCacheForVideo(youtubeId) {
  const totals = { deletedFiles: 0, freedBytes: 0 };
  if (!fs.existsSync(PERSISTENT_CACHE_DIR)) return totals;
  const names = await fs.promises.readdir(PERSISTENT_CACHE_DIR);
  for (const name of names) {
    if (path.extname(name) !== META_EXT) continue;
    const meta = readMeta(path.join(PERSISTENT_CACHE_DIR, name));
    if (!meta || meta.youtubeId !== youtubeId) continue;
    const result = await deleteEntryFiles(path.basename(name, META_EXT));
    totals.deletedFiles += result.deletedFiles;
    totals.freedBytes += result.freedBytes;
  }
  return totals;
}

/** @returns {Promise<{fileCount: number, totalBytes: number}>} cached-video count plus every byte in the directory, for the aggregate cache stats. */
async function getByteRangeCacheTotals() {
  let fileCount = 0;
  let totalBytes = 0;
  if (!fs.existsSync(PERSISTENT_CACHE_DIR)) return { fileCount, totalBytes };
  for (const name of await fs.promises.readdir(PERSISTENT_CACHE_DIR)) {
    try {
      const stat = await fs.promises.stat(path.join(PERSISTENT_CACHE_DIR, name));
      if (!stat.isFile()) continue;
      if (isEntryFile(name)) fileCount += 1; // sidecars/temp/in-progress files add bytes, not entries
      totalBytes += stat.size;
    } catch { /* removed mid-scan - ignore */ }
  }
  return { fileCount, totalBytes };
}

/**
 * Deletes every file in the directory older than `cutoffMs` (mtime) - the
 * byte-range counterpart of sweepExpiredUntrackedBufferCache's loop, using
 * the same TTL. `protectLivePartials` additionally spares in-progress
 * encodes (see isFreshPartial) - for user-initiated "clear everything".
 * @returns {Promise<{deleted: number, freedBytes: number}>}
 */
async function sweepExpiredByteRangeCache(cutoffMs, { protectLivePartials = false } = {}) {
  let deleted = 0;
  let freedBytes = 0;
  if (!fs.existsSync(PERSISTENT_CACHE_DIR)) return { deleted, freedBytes };
  for (const name of await fs.promises.readdir(PERSISTENT_CACHE_DIR)) {
    const filePath = path.join(PERSISTENT_CACHE_DIR, name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.mtimeMs >= cutoffMs) continue;
      if (protectLivePartials && isFreshPartial(name, stat)) continue;
      await fs.promises.unlink(filePath);
      if (isEntryFile(name)) deleted += 1; // sidecars/temp/in-progress files add bytes, not entries
      freedBytes += stat.size;
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn({ err, filePath }, 'ytstream: failed to expire one byte-range cache file');
    }
  }
  return { deleted, freedBytes };
}

/** Deletes every file in the directory. @returns {Promise<{deletedFiles: number, freedBytes: number}>} */
async function clearByteRangeCache() {
  const { deleted, freedBytes } = await sweepExpiredByteRangeCache(Infinity, { protectLivePartials: true });
  return { deletedFiles: deleted, freedBytes };
}

/**
 * Removes in-progress partials and copy/stitch temp files a previous process
 * left behind (a crash or restart mid-encode). Only safe to call before any
 * session of THIS process has started, apart from `keepPaths` (its own
 * first session's partial). Best-effort; never throws.
 */
async function removeOrphanPartials(keepPaths = []) {
  try {
    if (!fs.existsSync(PERSISTENT_CACHE_DIR)) return;
    for (const name of await fs.promises.readdir(PERSISTENT_CACHE_DIR)) {
      const filePath = path.join(PERSISTENT_CACHE_DIR, name);
      if (keepPaths.includes(filePath)) continue;
      if (!name.includes(PARTIAL_MARKER) && !name.endsWith('.tmp')) continue;
      await fs.promises.rm(filePath, { force: true });
    }
  } catch (err) {
    logger.warn({ err }, 'ytstream: failed to remove orphaned byte-range partial files');
  }
}

module.exports = {
  PERSISTENT_CACHE_DIR,
  PARTIAL_MARKER,
  removeOrphanPartials,
  listByteRangeCacheEntries,
  deleteByteRangeCacheForVideo,
  getByteRangeCacheTotals,
  sweepExpiredByteRangeCache,
  clearByteRangeCache,
};
