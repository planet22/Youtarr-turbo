const fs = require('fs-extra');
const fsPromises = fs.promises;
const path = require('path');
const { execSync } = require('child_process');
const configModule = require('../configModule');
const logger = require('../../logger');
const {
  copySyncWithFallback,
  resolveEffectiveSubfolder,
  buildChannelPath,
  resolveChannelFolderName,
} = require('../filesystem');
const channelYtdlpExecutor = require('./channelYtdlpExecutor');

class ChannelThumbnails {
  /**
   * Resize channel thumbnail image
   * @param {string} channelId - Channel ID
   * @returns {Promise<void>}
   */
  async resizeChannelThumbnail(channelId) {
    const imagePath = configModule.getImagePath();
    const realImagePath = path.join(
      imagePath,
      `channelthumb-${channelId}.jpg`
    );
    const smallImagePath = path.join(
      imagePath,
      `channelthumb-${channelId}-small.jpg`
    );

    try {
      execSync(
        `${configModule.ffmpegPath} -loglevel error -y -i "${realImagePath}" -vf "scale=iw*0.4:ih*0.4" -q:v 2 "${smallImagePath}"`,
        { stdio: 'inherit' }
      );
      await fsPromises.rename(smallImagePath, realImagePath);
      logger.debug({ channelId }, 'Channel thumbnail resized successfully');
    } catch (err) {
      logger.error({ err, channelId, imagePath: realImagePath }, 'Error resizing channel thumbnail');
    }
  }

  /**
   * Extract the avatar thumbnail URL from channel metadata
   * @param {Object} channelData - Channel metadata from yt-dlp
   * @returns {string|null} - Avatar thumbnail URL or null if not found
   */
  extractAvatarThumbnailUrl(channelData) {
    if (!channelData.thumbnails || !Array.isArray(channelData.thumbnails)) {
      return null;
    }
    // Prefer 900x900 (height and width), then any square dimension thumb, then avatar_uncropped
    // (avatar_uncropped last since it is good, but usually HUGE)
    const avatarThumb = channelData.thumbnails.find(t => t.width === 900 && t.height === 900)
      || channelData.thumbnails.find(t => t.width && t.height && t.width === t.height)
      || channelData.thumbnails.find(t => t.id === 'avatar_uncropped');
    logger.info({ channelId: channelData.channel_id, avatarThumb }, 'Extracted avatar thumbnail URL');
    return avatarThumb?.url || null;
  }

  /**
   * Extract the uncropped banner URL from channel metadata
   * @param {Object} channelData - Channel metadata from yt-dlp or the YouTube API
   * @returns {string|null} - Banner URL or null if the channel has no banner
   */
  extractBannerThumbnailUrl(channelData) {
    if (!channelData.thumbnails || !Array.isArray(channelData.thumbnails)) {
      return null;
    }
    const bannerThumb = channelData.thumbnails.find(t => t.id === 'banner_uncropped');
    return bannerThumb?.url || null;
  }

  /**
   * Download an image from a URL into the image cache directory
   * @param {string} imageUrl - Direct URL to the image
   * @param {string} targetFileName - File name to write inside the image directory
   * @returns {Promise<void>}
   */
  async downloadImageToFile(imageUrl, targetFileName) {
    const imageDir = configModule.getImagePath();
    return this.downloadImageToPath(imageUrl, path.join(imageDir, targetFileName));
  }

  /**
   * Download an image from a URL to an arbitrary absolute destination path
   * (not confined to the image cache directory) - same request/redirect/
   * timeout handling as downloadImageToFile, which now delegates here.
   * @param {string} imageUrl - Direct URL to the image
   * @param {string} destPath - Absolute path to write the image to
   * @returns {Promise<void>}
   */
  async downloadImageToPath(imageUrl, destPath) {
    const https = require('https');
    const http = require('http');

    return new Promise((resolve, reject) => {
      const protocol = imageUrl.startsWith('https') ? https : http;
      const file = fs.createWriteStream(destPath);

      const req = protocol.get(imageUrl, { timeout: 15000 }, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          return this.downloadImageToPath(response.headers.location, destPath)
            .then(resolve)
            .catch(reject);
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`Failed to download thumbnail: HTTP ${response.statusCode}`));
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          logger.debug({ destPath }, 'Image downloaded via HTTP');
          resolve();
        });
      });

      req.on('timeout', () => {
        req.destroy();
        file.close();
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(new Error('Thumbnail download timed out'));
      });

      req.on('error', (err) => {
        file.close();
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(err);
      });
    });
  }

  /**
   * Download channel thumbnail using yt-dlp (fallback method)
   * @param {string} channelUrl - Channel URL
   * @returns {Promise<void>}
   */
  async downloadChannelThumbnailViaYtdlp(channelUrl) {
    const YtdlpCommandBuilder = require('../download/ytdlpCommandBuilder');
    const imageDir = configModule.getImagePath();
    const imagePath = path.join(
      imageDir,
      'channelthumb-%(channel_id)s.jpg'
    );

    const args = YtdlpCommandBuilder.buildThumbnailDownloadArgs(channelUrl, imagePath);
    await channelYtdlpExecutor.executeYtDlpCommand(args);
  }

  /**
   * Process channel thumbnail (download and resize)
   * @param {Object} channelData - Channel metadata containing thumbnails array
   * @param {string} channelId - Channel ID
   * @param {string} channelUrl - Channel URL (fallback for yt-dlp download)
   * @returns {Promise<void>}
   */
  async processChannelThumbnail(channelData, channelId, channelUrl) {
    const thumbnailUrl = this.extractAvatarThumbnailUrl(channelData);
    logger.info({ channelId, thumbnailUrl }, 'Processing channel thumbnail');

    if (thumbnailUrl) {
      try {
        await this.downloadImageToFile(thumbnailUrl, `channelthumb-${channelId}.jpg`);
      } catch (err) {
        logger.warn({ err, channelId }, 'Failed to download thumbnail via HTTP, falling back to yt-dlp');
        await this.downloadChannelThumbnailViaYtdlp(channelUrl);
      }
    } else {
      logger.info({ channelId }, 'No avatar thumbnail URL found in metadata, using yt-dlp');
      await this.downloadChannelThumbnailViaYtdlp(channelUrl);
    }

    await this.resizeChannelThumbnail(channelId);
  }

  /**
   * Cache the channel banner image (used for backdrop.jpg generation).
   * Best-effort: never throws.
   * @param {Object} channelData - Channel metadata containing thumbnails array
   * @param {string} channelId - Channel ID
   * @returns {Promise<void>}
   */
  async processChannelBanner(channelData, channelId) {
    const bannerUrl = this.extractBannerThumbnailUrl(channelData);
    if (!bannerUrl) {
      logger.debug({ channelId }, 'No banner_uncropped thumbnail in channel metadata, skipping banner cache');
      return;
    }
    try {
      await this.downloadImageToFile(bannerUrl, `channelbanner-${channelId}.jpg`);
      logger.info({ channelId }, 'Channel banner cached');
    } catch (err) {
      logger.warn({ err, channelId }, 'Failed to download channel banner');
    }
  }

  /**
   * Backfill poster.jpg/logo.jpg and backdrop.jpg/banner.jpg files for existing channel folders.
   * @param {Array} channels - Array of channel database records
   * @returns {Promise<void>}
   */
  async backfillChannelImages(channels) {
    try {
      const config = configModule.getConfig() || {};
      const shouldWritePosters = config.writeChannelPosters !== false;
      const shouldWriteBackdrops = config.writeBackdropImages === true;

      if (!shouldWritePosters && !shouldWriteBackdrops) {
        return;
      }

      const outputDir = configModule.directoryPath;
      const imageDir = configModule.getImagePath();

      if (!outputDir || !fs.existsSync(outputDir)) {
        return;
      }

      for (const channel of channels) {
        if (!channel.channel_id) continue;

        const channelFolderName = resolveChannelFolderName(channel);
        if (!channelFolderName) continue;

        // Channels can live under a __subfolder (explicit or via the global
        // default); resolve the real folder path the same way downloads do.
        let channelFolderPath;
        try {
          const subfolder = resolveEffectiveSubfolder(channel.sub_folder, configModule.getDefaultSubfolder());
          channelFolderPath = buildChannelPath(outputDir, subfolder, channelFolderName);
        } catch (pathErr) {
          logger.warn({ err: pathErr, channelId: channel.channel_id }, 'Skipping channel with unresolvable folder path during image backfill');
          continue;
        }
        if (!fs.existsSync(channelFolderPath)) continue;

        if (shouldWritePosters) {
          this.copyChannelImageIfMissing(
            path.join(imageDir, `channelthumb-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'poster.jpg'),
            channelFolderName
          );
          this.copyChannelImageIfMissing(
            path.join(imageDir, `channelthumb-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'logo.jpg'),
            channelFolderName
          );
        }
        if (shouldWriteBackdrops) {
          this.copyChannelImageIfMissing(
            path.join(imageDir, `channelbanner-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'backdrop.jpg'),
            channelFolderName
          );
          this.copyChannelImageIfMissing(
            path.join(imageDir, `channelbanner-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'banner.jpg'),
            channelFolderName
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error during channel image backfill');
    }
  }

  /**
   * Copy a cached channel image to a target path if the source exists and the
   * target doesn't.
   * @param {string} sourcePath - Cached image path in the image directory
   * @param {string} targetPath - Destination path inside the channel folder
   * @param {string} channelFolderName - For error logging context
   */
  copyChannelImageIfMissing(sourcePath, targetPath, channelFolderName) {
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
      return;
    }
    try {
      copySyncWithFallback(sourcePath, targetPath);
    } catch (copyErr) {
      logger.error({ err: copyErr, channelFolderName, targetPath }, 'Error backfilling channel image');
    }
  }

  /**
   * Force re-copy poster.jpg/logo.jpg/backdrop.jpg/banner.jpg for every given
   * channel's folder from this app's own cached channel images, overwriting
   * whatever's already there. Deliberately a separate method from
   * backfillChannelImages/copyChannelImageIfMissing above rather than a
   * shared "force" flag on it - that method's exact skip-if-existing
   * behavior is relied on (and covered) by existing tests, and this is a
   * maintenance-only action, not a hot path, so a little duplication here
   * is safer than risking that behavior.
   *
   * Exists because copyChannelImageIfMissing can never repair an image that
   * already exists but is broken (e.g. wrong permissions from before
   * copySyncWithFallback started normalizing them - see fileOperations.js)
   * — this is the explicit "make it match the cache now" action, backing
   * POST /api/maintenance/regenerate-channel-images.
   *
   * Also covers TV Series library mode's per-season poster.jpg/logo.jpg
   * (see regenerateSeasonImagesForChannel) - those live one level deeper
   * than the channel folder this loop already resolves, and use the same
   * channel-thumbnail source image, so it's natural to fold in here rather
   * than as a separate maintenance action.
   *
   * Also fills in each video/episode's own missing library-adjacent
   * thumbnail (see regenerateVideoThumbnailsForChannel) - governed by its
   * own `strm.writeThumbnail` setting, independent of the channel
   * poster/backdrop flags above, so it runs even when both of those are
   * disabled.
   * @param {Array} channels - Array of channel database records
   * @returns {Promise<{copied: number, skippedNoSource: number, skippedNoFolder: number, errors: number, videoThumbsCopied: number, videoThumbsDownloaded: number, videoThumbsSkipped: number, videoThumbsErrors: number}>}
   */
  async regenerateChannelImages(channels) {
    const counts = {
      copied: 0, skippedNoSource: 0, skippedNoFolder: 0, errors: 0,
      videoThumbsCopied: 0, videoThumbsDownloaded: 0, videoThumbsSkipped: 0, videoThumbsErrors: 0,
    };
    try {
      const config = configModule.getConfig() || {};
      const shouldWritePosters = config.writeChannelPosters !== false;
      const shouldWriteBackdrops = config.writeBackdropImages === true;
      const shouldWriteVideoThumbs = (config.strm || {}).writeThumbnail !== false;

      const outputDir = configModule.directoryPath;
      const imageDir = configModule.getImagePath();

      if (!outputDir || !fs.existsSync(outputDir)) {
        return counts;
      }

      for (const channel of channels) {
        if (!channel.channel_id) continue;

        const channelFolderName = resolveChannelFolderName(channel);
        if (!channelFolderName) continue;

        let channelFolderPath;
        try {
          const subfolder = resolveEffectiveSubfolder(channel.sub_folder, configModule.getDefaultSubfolder());
          channelFolderPath = buildChannelPath(outputDir, subfolder, channelFolderName);
        } catch (pathErr) {
          logger.warn({ err: pathErr, channelId: channel.channel_id }, 'Skipping channel with unresolvable folder path during image regeneration');
          continue;
        }
        if (!fs.existsSync(channelFolderPath)) {
          counts.skippedNoFolder++;
          continue;
        }

        if (shouldWritePosters) {
          this.copyChannelImageForce(
            path.join(imageDir, `channelthumb-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'poster.jpg'),
            channelFolderName,
            counts
          );
          this.copyChannelImageForce(
            path.join(imageDir, `channelthumb-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'logo.jpg'),
            channelFolderName,
            counts
          );
          try {
            // eslint-disable-next-line no-await-in-loop -- deliberately sequential, matches the rest of this loop
            await this.regenerateSeasonImagesForChannel(channel, imageDir, counts);
          } catch (seasonErr) {
            // Scoped to this channel only - a failure here (e.g. a DB
            // hiccup) must not abort the whole batch the way it would if
            // it escaped to the outer catch below.
            counts.errors++;
            logger.error({ err: seasonErr, channelId: channel.channel_id }, 'Error regenerating season images for channel');
          }
        }
        if (shouldWriteBackdrops) {
          this.copyChannelImageForce(
            path.join(imageDir, `channelbanner-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'backdrop.jpg'),
            channelFolderName,
            counts
          );
          this.copyChannelImageForce(
            path.join(imageDir, `channelbanner-${channel.channel_id}.jpg`),
            path.join(channelFolderPath, 'banner.jpg'),
            channelFolderName,
            counts
          );
        }
        if (shouldWriteVideoThumbs) {
          try {
            // eslint-disable-next-line no-await-in-loop -- deliberately sequential, matches the rest of this loop
            await this.regenerateVideoThumbnailsForChannel(channel, imageDir, counts);
          } catch (thumbErr) {
            // Scoped to this channel only - same reasoning as the season-images catch above.
            counts.videoThumbsErrors++;
            logger.error({ err: thumbErr, channelId: channel.channel_id }, 'Error regenerating video thumbnails for channel');
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error during channel image regeneration');
    }
    return counts;
  }

  /**
   * Fills in each of this channel's videos' own missing library-adjacent
   * thumbnail - `<video-or-episode-file-stem>.jpg` next to the video/.strm
   * file, exactly what the video/episode NFO's <thumb> tag references (see
   * nfoGenerator.js's writeVideoNfoFile/writeEpisodeNfoFile). "Fill in if
   * missing" semantics, not force-overwrite like the channel/season poster
   * methods above - a missing video thumbnail means it was never
   * successfully written in the first place (see strmMaterializer.js's
   * _writeThumbnail fix for the bug this repairs after the fact - a
   * maxresdefault.jpg 404 used to leave this file permanently missing),
   * not a stale-permissions problem on a file that already exists, so
   * there's nothing to force-overwrite.
   *
   * Prefers copying the app's own UI-grid thumbnail cache
   * (imageDir/videothumb-<youtubeId>.jpg, already on disk for essentially
   * every video Youtarr has ever shown in its library view) over a fresh
   * network fetch - only falls back to downloading hqdefault.jpg from
   * YouTube (reliably generated for effectively all videos, unlike
   * maxresdefault.jpg) when that cache entry is also missing.
   * @param {object} channel - channel database record
   * @param {string} imageDir - configModule.getImagePath()
   * @param {object} counts - tallied into: videoThumbsCopied, videoThumbsDownloaded, videoThumbsSkipped, videoThumbsErrors
   */
  async regenerateVideoThumbnailsForChannel(channel, imageDir, counts) {
    const { Video } = require('../../models');
    const videos = await Video.findAll({
      where: { channel_id: channel.channel_id },
      attributes: ['filePath', 'youtubeId'],
      raw: true,
    });

    for (const video of videos) {
      if (!video.filePath || !video.youtubeId) continue;

      const parsed = path.parse(video.filePath);
      if (!fs.existsSync(parsed.dir)) continue; // video's own folder is gone - nothing to write into

      const thumbPath = path.join(parsed.dir, `${parsed.name}.jpg`);
      if (fs.existsSync(thumbPath)) {
        counts.videoThumbsSkipped++;
        continue;
      }

      const uiThumbPath = path.join(imageDir, `videothumb-${video.youtubeId}.jpg`);
      try {
        if (fs.existsSync(uiThumbPath)) {
          copySyncWithFallback(uiThumbPath, thumbPath);
          counts.videoThumbsCopied++;
        } else {
          // eslint-disable-next-line no-await-in-loop -- deliberately sequential, matches the rest of this loop
          await this.downloadImageToPath(`https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`, thumbPath);
          counts.videoThumbsDownloaded++;
        }
      } catch (err) {
        counts.videoThumbsErrors++;
        logger.warn({ err, youtubeId: video.youtubeId, thumbPath }, 'Error regenerating missing video thumbnail');
      }
    }
  }

  /**
   * Force re-copies poster.jpg/logo.jpg into every existing season folder
   * for this channel, when it's in TV Series library mode. A season folder
   * isn't derivable from the channel record alone (the season is decoded
   * per-video, from upload date or a channel-specific regex - see
   * videoDownloadPostProcessFiles.js) - so instead of recomputing that,
   * this reads the actual season folders back off already-downloaded
   * videos' own filePath (one level below the video: `path.dirname`),
   * matching exactly what copySeasonPosterIfNeeded/copySeasonLogoIfNeeded
   * wrote them into originally.
   * @param {object} channel - channel database record
   * @param {string} imageDir - configModule.getImagePath()
   * @param {object} counts - tallied into, same shape as regenerateChannelImages'
   */
  async regenerateSeasonImagesForChannel(channel, imageDir, counts) {
    const downloadSettingsResolver = require('../download/downloadSettingsResolver');
    const { Video } = require('../../models');

    const libraryMode = downloadSettingsResolver.resolveFinalLibraryMode({
      channelRecord: channel,
      globalDefault: (configModule.getConfig() || {}).defaultLibraryMode,
    });
    if (libraryMode !== 'series') return;

    const videos = await Video.findAll({
      where: { channel_id: channel.channel_id },
      attributes: ['filePath'],
      raw: true,
    });
    const seasonFolders = new Set(
      videos
        .map((v) => v.filePath)
        .filter(Boolean)
        .map((filePath) => path.dirname(filePath))
        .filter((dir) => fs.existsSync(dir))
    );

    const channelThumbPath = path.join(imageDir, `channelthumb-${channel.channel_id}.jpg`);
    for (const seasonFolderPath of seasonFolders) {
      this.copyChannelImageForce(channelThumbPath, path.join(seasonFolderPath, 'poster.jpg'), seasonFolderPath, counts);
      this.copyChannelImageForce(channelThumbPath, path.join(seasonFolderPath, 'logo.jpg'), seasonFolderPath, counts);
    }
  }

  /**
   * Copy a cached channel image to a target path unconditionally
   * (overwriting an existing target), tallying the outcome into `counts`.
   * See regenerateChannelImages; contrast with copyChannelImageIfMissing.
   */
  copyChannelImageForce(sourcePath, targetPath, channelFolderName, counts) {
    if (!fs.existsSync(sourcePath)) {
      counts.skippedNoSource++;
      return;
    }
    try {
      copySyncWithFallback(sourcePath, targetPath);
      counts.copied++;
    } catch (copyErr) {
      counts.errors++;
      logger.error({ err: copyErr, channelFolderName, targetPath }, 'Error regenerating channel image');
    }
  }
}

module.exports = new ChannelThumbnails();
