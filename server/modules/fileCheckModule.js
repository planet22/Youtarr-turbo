const fs = require('fs').promises;
const path = require('path');
const { VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } = require('./filesystem/constants');
const createLimiter = require('./subscriptionImport/concurrencyLimiter');

// Per-video checks run concurrently up to this bound: each stat costs a full
// round trip on network-backed mounts (NAS, WSL drvfs), so checking a
// 128-row page sequentially takes ~1s of wall time there.
const MAX_CONCURRENT_FILE_CHECKS = 16;

// A video downloaded within this window that fails its file-existence check
// is treated as "not yet confirmed missing" rather than flipped to
// removed=true. Post-processing (poster/nfo/sidecar writes) keeps touching
// the video's directory on a network-backed mount for a moment after the
// video file itself has already been moved into place, and on some mounts a
// fresh stat of the just-written path can still come back ENOENT in that
// window (directory-entry/attribute cache lag) - without this grace period
// that one unlucky check permanently persists removed=true, and the video
// shows as "Missing" in the library until someone notices and it happens to
// get re-checked again. The next real-time check, moments later, settles it
// for real either way.
const REMOVED_FLIP_GRACE_MS = 2 * 60 * 1000;

// Callers pass either raw Video rows (last_downloaded_at) or the getVideos
// listing's computed alias (timeCreated, which is last_downloaded_at itself
// whenever that column is set - see videosModule.js's ADDED_DATE_EXPR).
function wasRecentlyDownloaded(video) {
  const raw = video.last_downloaded_at || video.timeCreated;
  if (!raw) return false;
  const downloadedAt = new Date(raw).getTime();
  return Number.isFinite(downloadedAt) && (Date.now() - downloadedAt) < REMOVED_FLIP_GRACE_MS;
}

/**
 * Check file existence and update video metadata.
 * Real-time per-page check: stats the stored path, falls back to same-dir
 * same-basename files with any supported extension if the original is missing.
 */
class FileCheckModule {
  /**
   * Try the original path; if missing, try same-dir variants with every
   * extension in `extensionList`.
   *
   * Returns:
   *   { exists: true, replaced: false, path, size }     - original found
   *   { exists: true, replaced: true,  path, size }     - variant found
   *   { exists: false, statusKnown: true }              - definitively missing
   *   { exists: false, statusKnown: false }             - non-ENOENT error
   */
  async _findExistingMediaFile(originalPath, extensionList) {
    try {
      const stats = await fs.stat(originalPath);
      return { exists: true, replaced: false, path: originalPath, size: stats.size };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { exists: false, statusKnown: false };
      }
      // ENOENT on the stored path; fall through to the same-dir extension scan.
    }

    const dir = path.dirname(originalPath);
    const ext = path.extname(originalPath);
    const extLower = ext.toLowerCase();
    const base = path.basename(originalPath, ext);

    for (const candidateExt of extensionList) {
      if (candidateExt.toLowerCase() === extLower) {
        continue;
      }
      const candidatePath = path.join(dir, base + candidateExt);
      try {
        const stats = await fs.stat(candidatePath);
        return { exists: true, replaced: true, path: candidatePath, size: stats.size };
      } catch (err) {
        if (err.code !== 'ENOENT') {
          return { exists: false, statusKnown: false };
        }
      }
    }

    return { exists: false, statusKnown: true };
  }

  async checkVideoFiles(videos) {
    const updatedVideos = [...videos];
    const limit = createLimiter(MAX_CONCURRENT_FILE_CHECKS);
    // One slot per video keeps `updates` in input order no matter which
    // check finishes first.
    const updateSlots = new Array(updatedVideos.length).fill(null);

    await Promise.all(updatedVideos.map((video, i) => limit(async () => {
      const update = { id: video.id };
      let hasUpdates = false;
      let videoFileExists = false;
      let audioFileExists = false;
      let videoFileStatusKnown = !video.filePath;
      let audioFileStatusKnown = !video.audioFilePath;

      if (video.filePath) {
        const result = await this._findExistingMediaFile(video.filePath, VIDEO_EXTENSIONS);
        if (result.exists) {
          videoFileExists = true;
          videoFileStatusKnown = true;

          if (result.replaced) {
            update.filePath = result.path;
            update.fileSize = result.size;
            hasUpdates = true;
          } else if (video.fileSize !== result.size.toString()) {
            update.fileSize = result.size;
            hasUpdates = true;
          }
        } else {
          videoFileExists = false;
          videoFileStatusKnown = result.statusKnown;
        }
      }

      if (video.audioFilePath) {
        const result = await this._findExistingMediaFile(video.audioFilePath, AUDIO_EXTENSIONS);
        if (result.exists) {
          audioFileExists = true;
          audioFileStatusKnown = true;

          if (result.replaced) {
            update.audioFilePath = result.path;
            update.audioFileSize = result.size;
            hasUpdates = true;
          } else if (video.audioFileSize !== result.size.toString()) {
            update.audioFileSize = result.size;
            hasUpdates = true;
          }
        } else {
          audioFileExists = false;
          audioFileStatusKnown = result.statusKnown;
        }
      }

      const hasAnyPath = video.filePath || video.audioFilePath;
      const hasAnyFile = videoFileExists || audioFileExists;
      const canDetermineRemovedStatus = videoFileStatusKnown && audioFileStatusKnown;

      if (hasAnyPath && canDetermineRemovedStatus) {
        if (hasAnyFile && video.removed) {
          update.removed = false;
          hasUpdates = true;
        } else if (!hasAnyFile && !video.removed && !wasRecentlyDownloaded(video)) {
          update.removed = true;
          hasUpdates = true;
        }
      }

      if (hasUpdates) {
        updateSlots[i] = update;
        updatedVideos[i] = {
          ...video,
          ...(update.filePath !== undefined && { filePath: update.filePath }),
          ...(update.fileSize !== undefined && { fileSize: update.fileSize.toString() }),
          ...(update.audioFilePath !== undefined && { audioFilePath: update.audioFilePath }),
          ...(update.audioFileSize !== undefined && { audioFileSize: update.audioFileSize.toString() }),
          ...(update.removed !== undefined && { removed: update.removed })
        };
      }
    })));

    return { videos: updatedVideos, updates: updateSlots.filter(Boolean) };
  }

  async applyVideoUpdates(sequelize, Sequelize, updates) {
    if (updates.length === 0) {
      return;
    }

    for (const update of updates) {
      const setClauses = [];
      const values = [];

      if (update.filePath !== undefined) {
        setClauses.push('filePath = ?');
        values.push(update.filePath);
      }
      if (update.fileSize !== undefined) {
        setClauses.push('fileSize = ?');
        values.push(update.fileSize);
      }
      if (update.audioFilePath !== undefined) {
        setClauses.push('audioFilePath = ?');
        values.push(update.audioFilePath);
      }
      if (update.audioFileSize !== undefined) {
        setClauses.push('audioFileSize = ?');
        values.push(update.audioFileSize);
      }
      if (update.removed !== undefined) {
        setClauses.push('removed = ?');
        values.push(update.removed ? 1 : 0);
      }

      if (setClauses.length > 0) {
        values.push(update.id);
        await sequelize.query(
          `UPDATE Videos SET ${setClauses.join(', ')} WHERE id = ?`,
          {
            replacements: values,
            type: Sequelize.QueryTypes.UPDATE
          }
        );
      }
    }
  }
}

module.exports = new FileCheckModule();
