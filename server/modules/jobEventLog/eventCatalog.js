// Registry of every event type the video/events log knows about. To add a new
// step to the log: add one entry here, then call
//   jobEventLog.record(EVENT_TYPES.YOUR_TYPE, { jobId, youtubeId, detail })
// at the place it happens. `message` is rendered ONCE at write time and stored
// frozen - the log never recomputes text from live state, which is the whole
// point of it. Types missing from this catalog still record (generic message),
// so a call site can never break by being ahead of its catalog entry.

const LEVELS = Object.freeze({ INFO: 'info', WARN: 'warn', ERROR: 'error' });

const EVENT_TYPES = Object.freeze({
  // Job lifecycle (no youtubeId)
  JOB_CREATED: 'job.created',
  JOB_STARTED: 'job.started',
  JOB_FINISHED: 'job.finished',
  JOB_REMOVED: 'job.removed',
  // Per-video download pipeline
  VIDEO_DOWNLOAD_STARTED: 'video.download_started',
  VIDEO_FILE_FINALIZED: 'video.file_finalized',
  VIDEO_DOWNLOADED: 'video.downloaded',
  VIDEO_FAILED: 'video.failed',
  VIDEO_AUTO_RETRY_QUEUED: 'video.auto_retry_queued',
  VIDEO_DELETED: 'video.deleted',
  VIDEO_REVERTED_TO_STRM: 'video.reverted_to_strm',
  VIDEO_TRANSCODED: 'video.transcoded',
  VIDEO_MARKED_MISSING: 'video.marked_missing',
  VIDEO_RESTORED: 'video.restored',
  VIDEO_PROTECTED: 'video.protected',
  VIDEO_UNPROTECTED: 'video.unprotected',
  VIDEO_IGNORED: 'video.ignored',
  VIDEO_UNIGNORED: 'video.unignored',
  VIDEO_UNAVAILABLE_ON_YOUTUBE: 'video.unavailable_on_youtube',
  VIDEO_RATING_CHANGED: 'video.rating_changed',
  VIDEO_MOVED: 'video.moved',
  VIDEO_RECREATED: 'video.recreated',
  VIDEO_DOWNLOAD_INTERRUPTED: 'video.download_interrupted',
  // Media-server (Plex/Jellyfin/Emby) playlists
  PLAYLIST_SYNCED: 'playlist.synced',
  PLAYLIST_ITEM_ADDED: 'playlist.item_added',
  PLAYLIST_ITEM_REMOVED: 'playlist.item_removed',
  // STRM
  STRM_CREATED: 'strm.created',
  STRM_CACHE_ON_PLAY_QUEUED: 'strm.cache_on_play_queued',
  STRM_ARCHIVED: 'strm.archived',
  // Sonarr/Radarr (NZB) grabs
  NZB_GRAB_REQUESTED: 'nzb.grab_requested',
  NZB_STAGED_FOR_IMPORT: 'nzb.staged_for_import',
  NZB_IMPORT_DETECTED: 'nzb.import_detected',
  NZB_HISTORY_REMOVED: 'nzb.history_removed',
  NZB_UNTRACKED: 'nzb.untracked',
  NZB_UNTRACK_FAILED: 'nzb.untrack_failed',
  // The log itself
  LOG_CLEARED: 'log.cleared',
  // ytstream buffer cache
  CACHE_FETCH_STARTED: 'cache.fetch_started',
  CACHE_HLS_BUFFER_FINALIZED: 'cache.hls_buffer_finalized',
  CACHE_TS_TO_MP4: 'cache.ts_to_mp4',
  CACHE_PROMOTED_TO_LIBRARY: 'cache.promoted_to_library',
  CACHE_DELETED: 'cache.deleted',
  CACHE_BYTE_RANGE_SAVED: 'cache.byte_range_saved',
  CACHE_REMUXED: 'cache.remuxed_for_playback',
});

const has = (value) => value !== undefined && value !== null && value !== '';
const suffix = (value, text) => (has(value) ? ` ${text.replace('%s', value)}` : '');

// A short, single-line reason can ride in the event's main line; anything longer
// (a yt-dlp error is often a paragraph) stays in the event's detail, which the
// expansion row shows in full. Returns null when the text is too long to inline.
const MAX_INLINE_TEXT = 100;
function brief(text) {
  if (!has(text)) return null;
  const trimmed = String(text).trim();
  return trimmed.length > 0 && trimmed.length <= MAX_INLINE_TEXT && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

// "12s", "2m 03s", "1h 05m" - how long a transfer took.
function formatSeconds(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return null;
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

// "181 B in 12s (2.4 MB/s)" from whichever of size / time / rate are known.
function transferSummary({ fileSize, downloadDurationSeconds, avgDownloadMBps }) {
  const size = has(fileSize) ? formatBytes(fileSize) : null;
  const took = has(downloadDurationSeconds) ? formatSeconds(downloadDurationSeconds) : null;
  const rate = Number(avgDownloadMBps) > 0 ? `${Number(avgDownloadMBps).toFixed(2)} MB/s` : null;
  const parts = [size, took ? `in ${took}` : null, rate ? `(${rate})` : null].filter(Boolean);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

const EVENT_CATALOG = {
  [EVENT_TYPES.JOB_CREATED]: {
    actor: 'job',
    message: ({ detail = {} }) =>
      detail.status === 'Pending' ? 'Job queued' : `Job created (${detail.status || 'unknown status'})`,
  },
  [EVENT_TYPES.JOB_STARTED]: { actor: 'job', message: () => 'Job started' },
  [EVENT_TYPES.JOB_FINISHED]: {
    actor: 'job',
    level: ({ detail = {} }) => {
      if (detail.status === 'Error') return LEVELS.ERROR;
      if (['Terminated', 'Killed', 'Complete with Warnings', 'Failed'].includes(detail.status)) return LEVELS.WARN;
      return LEVELS.INFO;
    },
    message: ({ detail = {} }) => {
      const parts = [];
      if (has(detail.videoCount)) parts.push(`${detail.videoCount} video${detail.videoCount === 1 ? '' : 's'}`);
      if (detail.failedCount) parts.push(`${detail.failedCount} failed`);
      if (detail.skippedCount) parts.push(`${detail.skippedCount} skipped`);
      return `Job finished: ${detail.status || 'unknown'}${parts.length ? ` (${parts.join(', ')})` : ''}${suffix(brief(detail.reason), '- %s')}`;
    },
  },
  [EVENT_TYPES.JOB_REMOVED]: { actor: 'job', message: () => 'Job removed from the queue before it started' },

  [EVENT_TYPES.VIDEO_DOWNLOAD_STARTED]: { actor: 'downloader', message: () => 'Download started' },
  [EVENT_TYPES.VIDEO_FILE_FINALIZED]: {
    actor: 'downloader',
    message: ({ detail = {} }) => `File finalized${suffix(detail.filePath, 'at %s')}${suffix(detail.fileSize, '(%s bytes)')}`,
  },
  [EVENT_TYPES.VIDEO_DOWNLOADED]: {
    actor: 'downloader',
    message: ({ detail = {} }) => `Downloaded${transferSummary(detail)}`,
  },
  [EVENT_TYPES.VIDEO_FAILED]: {
    actor: 'downloader',
    level: () => LEVELS.ERROR,
    // The error yt-dlp reported, plus the same "likely cause" advice Download History shows.
    message: ({ detail = {} }) =>
      `Download failed${suffix(brief(detail.error), '- %s')}${suffix(detail.diagnosisTitle, '(Likely cause: %s)')}`,
  },
  [EVENT_TYPES.VIDEO_AUTO_RETRY_QUEUED]: {
    actor: 'downloader',
    level: () => LEVELS.WARN,
    message: ({ detail = {} }) => `Auto-retry queued${suffix(detail.attempt, '(attempt %s)')}`,
  },
  [EVENT_TYPES.VIDEO_DELETED]: {
    actor: 'library',
    message: ({ detail = {} }) =>
      `${detail.purged ? 'Video record purged (file was already missing)' : 'Video deleted'}${suffix(detail.reason, '- %s')}`,
  },

  [EVENT_TYPES.VIDEO_REVERTED_TO_STRM]: {
    actor: 'library',
    message: ({ detail = {} }) => `Downloaded file removed, restored to STRM playback${suffix(detail.reason, '- %s')}`,
  },

  [EVENT_TYPES.VIDEO_TRANSCODED]: {
    actor: 'downloader',
    message: ({ detail = {} }) =>
      `Transcoded after download${suffix(detail.codec, 'to %s')}${suffix(detail.from, '(from %s)')}`,
  },
  [EVENT_TYPES.VIDEO_MARKED_MISSING]: {
    actor: 'library',
    level: () => LEVELS.WARN,
    message: ({ detail = {} }) => `Video file not found on disk, marked missing${suffix(detail.filePath, '(%s)')}`,
  },
  [EVENT_TYPES.VIDEO_RESTORED]: {
    actor: 'library',
    message: ({ detail = {} }) => `Video file found again on disk${suffix(detail.filePath, '(%s)')}`,
  },

  [EVENT_TYPES.VIDEO_PROTECTED]: {
    actor: 'library',
    message: () => 'Video protected from automatic removal',
  },
  [EVENT_TYPES.VIDEO_UNPROTECTED]: {
    actor: 'library',
    message: () => 'Video protection removed',
  },
  [EVENT_TYPES.VIDEO_IGNORED]: {
    actor: 'library',
    message: () => 'Video ignored - it will not be downloaded',
  },
  [EVENT_TYPES.VIDEO_UNIGNORED]: {
    actor: 'library',
    message: () => 'Video no longer ignored',
  },
  [EVENT_TYPES.VIDEO_UNAVAILABLE_ON_YOUTUBE]: {
    actor: 'youtube',
    level: () => LEVELS.WARN,
    message: () => 'Video is no longer available on YouTube',
  },

  [EVENT_TYPES.VIDEO_RATING_CHANGED]: {
    actor: 'library',
    message: ({ detail = {} }) =>
      `Rating changed${suffix(detail.previousRating || 'none', 'from %s')} to ${detail.rating || 'none'}`,
  },
  [EVENT_TYPES.VIDEO_MOVED]: {
    actor: 'library',
    message: ({ detail = {} }) => `Video file moved${suffix(detail.to, 'to %s')}${suffix(detail.from, '(from %s)')}`,
  },

  [EVENT_TYPES.PLAYLIST_SYNCED]: {
    actor: 'media-server',
    message: ({ detail = {} }) =>
      `Playlist "${detail.playlistTitle || 'unknown'}" ${detail.created ? 'created on' : 'updated on'} ${detail.server || 'the media server'}${suffix(detail.itemCount, '(%s items)')}`,
  },
  [EVENT_TYPES.PLAYLIST_ITEM_ADDED]: {
    actor: 'media-server',
    message: ({ detail = {} }) => `Added to playlist "${detail.playlistTitle || 'unknown'}"${suffix(detail.server, 'on %s')}`,
  },
  [EVENT_TYPES.PLAYLIST_ITEM_REMOVED]: {
    actor: 'media-server',
    message: ({ detail = {} }) => `Removed from playlist "${detail.playlistTitle || 'unknown'}"${suffix(detail.server, 'on %s')}`,
  },

  [EVENT_TYPES.STRM_CREATED]: { actor: 'strm', message: () => 'STRM file created' },
  [EVENT_TYPES.STRM_ARCHIVED]: {
    actor: 'strm',
    message: ({ detail = {} }) => `STRM file archived after a real download replaced it${suffix(detail.path, '(%s)')}`,
  },
  [EVENT_TYPES.STRM_CACHE_ON_PLAY_QUEUED]: {
    actor: 'strm',
    message: () => 'Background download queued because the STRM item was played',
  },

  [EVENT_TYPES.NZB_GRAB_REQUESTED]: {
    actor: 'nzb',
    message: ({ detail = {} }) =>
      `Grab accepted from Sonarr/Radarr${suffix(detail.categoryName, 'for category %s')}${suffix(detail.importStrategy, '(import strategy: %s)')}`,
  },
  [EVENT_TYPES.NZB_STAGED_FOR_IMPORT]: {
    actor: 'nzb',
    message: ({ detail = {} }) => `Staged for Sonarr/Radarr import${suffix(detail.stagedPath, 'at %s')}`,
  },
  [EVENT_TYPES.NZB_IMPORT_DETECTED]: { actor: 'nzb', message: () => 'Import by Sonarr/Radarr detected' },
  [EVENT_TYPES.NZB_HISTORY_REMOVED]: {
    actor: 'nzb',
    message: () => 'Sonarr/Radarr removed this item from its download history',
  },
  [EVENT_TYPES.NZB_UNTRACKED]: {
    actor: 'nzb',
    message: ({ detail = {} }) =>
      `Removed from the Youtarr library after Sonarr/Radarr import${suffix(detail.trigger, '(via %s)')}`,
  },
  [EVENT_TYPES.NZB_UNTRACK_FAILED]: {
    actor: 'nzb',
    level: () => LEVELS.WARN,
    message: ({ detail = {} }) => `Could not remove from the Youtarr library${suffix(brief(detail.error), '- %s')}`,
  },

  [EVENT_TYPES.VIDEO_RECREATED]: {
    actor: 'library',
    message: ({ detail = {} }) =>
      `Video re-added to the library from the download archive${detail.hasFile ? '' : ' (no file found on disk)'}`,
  },
  [EVENT_TYPES.VIDEO_DOWNLOAD_INTERRUPTED]: {
    actor: 'downloader',
    level: () => LEVELS.WARN,
    message: ({ detail = {} }) =>
      detail.alreadyRemoved ? 'Download interrupted - no partial files were left' : 'Download interrupted - partial files removed',
  },

  [EVENT_TYPES.LOG_CLEARED]: {
    actor: 'maintenance',
    level: () => LEVELS.WARN,
    message: ({ detail = {} }) => `Event log cleared${suffix(detail.deletedCount, '(%s events removed)')}`,
  },
  [EVENT_TYPES.CACHE_FETCH_STARTED]: {
    actor: 'ytstream',
    message: ({ detail = {} }) => `Hidden cache being created (buffer fetch started)${suffix(detail.quality, 'at quality %s')}`,
  },
  [EVENT_TYPES.CACHE_HLS_BUFFER_FINALIZED]: {
    actor: 'ytstream',
    message: ({ detail = {} }) => `HLS buffer saved${transferSummary(detail)}${suffix(detail.filePath, 'to %s')}`,
  },
  [EVENT_TYPES.CACHE_DELETED]: {
    actor: 'ytstream',
    message: ({ detail = {} }) =>
      `Hidden cache file deleted${suffix(formatBytes(detail.freedBytes), '(freed %s)')}${suffix(detail.reason, '- %s')}`,
  },
  [EVENT_TYPES.CACHE_BYTE_RANGE_SAVED]: {
    actor: 'ytstream',
    message: ({ detail = {} }) =>
      `Playback cache saved (${detail.complete ? 'complete' : 'partial'}${detail.resumed ? ', after resume' : ''})${suffix(formatBytes(detail.sizeBytes), '- %s')}`,
  },
  [EVENT_TYPES.CACHE_REMUXED]: {
    actor: 'ytstream',
    message: ({ detail = {} }) => `Seekable .mp4 made for in-app playback of a .ts file${suffix(formatBytes(detail.size), '(%s)')}`,
  },
  [EVENT_TYPES.CACHE_TS_TO_MP4]: {
    actor: 'ytstream',
    message: () => 'Hidden .ts cache remuxed to .mp4',
  },
  [EVENT_TYPES.CACHE_PROMOTED_TO_LIBRARY]: {
    actor: 'ytstream',
    message: ({ detail = {} }) => `Buffered cache promoted to a library file${suffix(detail.filePath, 'at %s')}`,
  },
};

/**
 * Resolves the stored actor/level/message for an event, letting an explicit
 * value on the call always win over the catalog default.
 * @param {string} eventType
 * @param {object} fields - the record() call's fields (jobId, youtubeId, detail, message?, level?, actor?)
 * @returns {{actor: string|null, level: string, message: string}}
 */
function describeEvent(eventType, fields = {}) {
  const entry = EVENT_CATALOG[eventType] || {};
  const level = fields.level || (typeof entry.level === 'function' ? entry.level(fields) : entry.level) || LEVELS.INFO;
  const actor = fields.actor || entry.actor || null;
  const message = fields.message || (entry.message ? entry.message(fields) : eventType);
  return { actor, level, message };
}

module.exports = { EVENT_TYPES, EVENT_CATALOG, LEVELS, describeEvent };
