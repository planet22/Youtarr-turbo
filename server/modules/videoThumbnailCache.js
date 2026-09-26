const fs = require('fs');
const path = require('path');
const axios = require('axios');
const logger = require('../logger');
const configModule = require('./configModule');
const { Video } = require('../models');

// Single home for the UI video thumbnail (<imageDir>/videothumb-<id>.jpg):
// serve the local copy, otherwise fetch YouTube's still once and keep it so
// the next view is local. Downloads and STRM materialize still write their
// own copy at finalize time; this covers everything else (untracked NZB
// grabs, streamed-but-never-downloaded videos, older rows missing a file).

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const THUMB_FILE_PATTERN = /^videothumb-([A-Za-z0-9_-]{11})\.jpg$/;
const FETCH_TIMEOUT_MS = 10000;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
// Stops repeated YouTube requests for ids that have no thumbnail (deleted or
// private videos, or garbage ids from outside).
const MISS_RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_REMEMBERED_MISSES = 5000;
// Outbound YouTube fetches in flight at once; the rest wait their turn.
const MAX_CONCURRENT_FETCHES = 4;
// A kept thumbnail whose video is not in the library is deleted after this
// many days without being viewed.
const CACHE_RETENTION_DAYS = 30;
// Last-viewed time is the file's mtime, refreshed at most this often.
const TOUCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRUNE_LOOKUP_CHUNK = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

class VideoThumbnailCache {
  constructor() {
    this.inFlight = new Map();
    this.misses = new Map();
    this.activeFetches = 0;
    this.waiting = [];
  }

  isValidId(youtubeId) {
    return typeof youtubeId === 'string' && YOUTUBE_ID_PATTERN.test(youtubeId);
  }

  youtubeUrl(youtubeId) {
    return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
  }

  localPath(youtubeId) {
    return path.join(configModule.getImagePath(), `videothumb-${youtubeId}.jpg`);
  }

  /**
   * The local thumbnail if it exists (and marks it as just viewed), without
   * fetching anything.
   * @returns {string|null}
   */
  existingLocalPath(youtubeId) {
    if (!this.isValidId(youtubeId)) return null;
    const filePath = this.localPath(youtubeId);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      return null;
    }
    if (Date.now() - stat.mtimeMs > TOUCH_INTERVAL_MS) {
      const now = new Date();
      fs.promises.utimes(filePath, now, now).catch(() => {});
    }
    return filePath;
  }

  /**
   * The local thumbnail, fetching and keeping YouTube's still first when
   * there is none yet. Never throws.
   * @returns {Promise<string|null>} null when YouTube has no thumbnail either
   */
  async ensureLocal(youtubeId) {
    const existing = this.existingLocalPath(youtubeId);
    if (existing || !this.isValidId(youtubeId)) return existing;

    const missedAt = this.misses.get(youtubeId);
    if (missedAt && Date.now() - missedAt < MISS_RETRY_MS) return null;

    if (!this.inFlight.has(youtubeId)) {
      const pending = this._fetchAndStore(youtubeId).finally(() => this.inFlight.delete(youtubeId));
      this.inFlight.set(youtubeId, pending);
    }
    return this.inFlight.get(youtubeId);
  }

  async _fetchAndStore(youtubeId) {
    await this._acquireFetchSlot();
    const filePath = this.localPath(youtubeId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const res = await axios.get(this.youtubeUrl(youtubeId), {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_THUMBNAIL_BYTES,
      });
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      // Written aside then renamed, so a reader never sees a half-written jpg.
      await fs.promises.writeFile(tmpPath, Buffer.from(res.data));
      await fs.promises.rename(tmpPath, filePath);
      this.misses.delete(youtubeId);
      return filePath;
    } catch (err) {
      fs.promises.unlink(tmpPath).catch(() => {});
      this._rememberMiss(youtubeId);
      logger.debug({ youtubeId, message: err.message }, 'Video thumbnail not available from YouTube');
      return null;
    } finally {
      this._releaseFetchSlot();
    }
  }

  _rememberMiss(youtubeId) {
    this.misses.delete(youtubeId);
    this.misses.set(youtubeId, Date.now());
    if (this.misses.size > MAX_REMEMBERED_MISSES) {
      this.misses.delete(this.misses.keys().next().value);
    }
  }

  _acquireFetchSlot() {
    if (this.activeFetches < MAX_CONCURRENT_FETCHES) {
      this.activeFetches += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  _releaseFetchSlot() {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.activeFetches -= 1;
    }
  }

  /**
   * Deletes a video's thumbnail (e.g. its library row was purged). Never throws.
   */
  async removeThumbnail(youtubeId) {
    if (!this.isValidId(youtubeId)) return;
    try {
      await fs.promises.unlink(this.localPath(youtubeId));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn({ err, youtubeId }, 'Failed to remove video thumbnail');
      }
    }
  }

  /**
   * Deletes kept thumbnails whose video is not in the library and that
   * nobody has viewed for retentionDays. Library videos keep theirs.
   * @returns {Promise<number>} files deleted
   */
  async pruneUnused({ retentionDays = CACHE_RETENTION_DAYS } = {}) {
    const imageDir = configModule.getImagePath();
    let entries;
    try {
      entries = await fs.promises.readdir(imageDir);
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }

    const cutoff = Date.now() - retentionDays * MS_PER_DAY;
    const stale = new Map();
    for (const name of entries) {
      const match = name.match(THUMB_FILE_PATTERN);
      if (!match) continue;
      try {
        const stat = await fs.promises.stat(path.join(imageDir, name));
        if (stat.mtimeMs < cutoff) stale.set(match[1], name);
      } catch (err) {
        // Deleted since readdir - nothing to do.
      }
    }

    const ids = [...stale.keys()];
    for (let i = 0; i < ids.length; i += PRUNE_LOOKUP_CHUNK) {
      const rows = await Video.findAll({
        where: { youtubeId: ids.slice(i, i + PRUNE_LOOKUP_CHUNK) },
        attributes: ['youtubeId'],
        raw: true,
      });
      rows.forEach((row) => stale.delete(row.youtubeId));
    }

    let deleted = 0;
    for (const name of stale.values()) {
      try {
        await fs.promises.unlink(path.join(imageDir, name));
        deleted += 1;
      } catch (err) {
        if (err.code !== 'ENOENT') logger.warn({ err, name }, 'Failed to delete unused video thumbnail');
      }
    }
    return deleted;
  }
}

module.exports = new VideoThumbnailCache();
module.exports.CACHE_RETENTION_DAYS = CACHE_RETENTION_DAYS;
