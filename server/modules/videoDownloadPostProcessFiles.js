const fs = require('fs-extra');
const path = require('path');
const { execSync, spawnSync, spawn } = require('child_process');
const configModule = require('./configModule');
const nfoGenerator = require('./nfoGenerator');
const ratingMapper = require('./ratingMapper');
const tempPathManager = require('./download/tempPathManager');
const downloadSettingsResolver = require('./download/downloadSettingsResolver');
const YtdlpCommandBuilder = require('./download/ytdlpCommandBuilder');
const seriesEpisodeResolver = require('./seriesEpisodeResolver');
const { probeVideoDimensions, probeVideoDuration, selectionTierForHeight } = require('./resolutionTier');
const hardwareEncoderModule = require('./hardwareEncoderModule');
const { TRANSCODE_PROGRESS_MARKER } = require('./constants/outputMarkers');
const { JobVideoDownload } = require('../models');
const videoPersistence = require('./videoPersistence');
const { VIDEO_PERSISTED_MARKER } = require('./constants/outputMarkers');
const logger = require('../logger');
const {
  buildChannelPath,
  buildSeasonFolderPath,
  cleanupEmptyParents,
  moveWithRetries,
  ensureDirWithRetries,
  copySyncWithFallback,
  composeEpisodeFileTemplate
} = require('./filesystem');

const activeJobId = process.env.YOUTARR_JOB_ID;

// Flat mode: skip video subfolder, files go directly in channel folder.
// Describes the INCOMING temp layout written by the yt-dlp output template.
const isFlatMode = process.env.YOUTARR_SKIP_VIDEO_FOLDER === 'true';

// Per-video structure mode (manual downloads): the final flat-vs-subfolder
// decision is made here per video (override -> channel -> global) instead of
// being fixed per job. Incoming temp layout is always nested in this mode.
const perVideoStructure = process.env.YOUTARR_STRUCTURE_PER_VIDEO === 'true';
const skipVideoFolderOverrideEnv = process.env.YOUTARR_SKIP_VIDEO_FOLDER_OVERRIDE;

// STRM cache-on-play: when set, this video's final location is PINNED to the
// exact folder its existing .strm/.nfo/.jpg/.strmtool.json already live in
// (read directly off the Videos row by strmCacheOnPlay.js), bypassing
// libraryMode/subfolder/flat resolution entirely for path purposes - those
// could independently resolve to a different folder than where the .strm was
// originally materialized if channel settings changed since. See Phase 2/3
// below for where this short-circuits the normal path logic.
const strmCacheTargetDir = process.env.YOUTARR_STRM_CACHE_TARGET_DIR || null;
const strmCacheFileStem = process.env.YOUTARR_STRM_CACHE_FILE_STEM || null;

// NZB grabs (see server/routes/nzb.js): Sonarr/Radarr generate their own
// artwork/nfo on import, so skip writing Youtarr's nfo/season.nfo/tvshow.nfo/
// fanart/backdrop/channel-poster and drop the swept-in thumbnail jpg -
// just the video file itself lands in the final location.
const skipMediaSidecarFiles = process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES === 'true';

let videoPath = process.argv[2]; // get the media file path (video or audio) - reassigned in place if the optional post-download transcode below runs
let parsedPath = path.parse(videoPath);
// Note that MP4 videos contain embedded metadata for Plex
// MP3 audio files have their own embedded metadata from yt-dlp
// We only need the .info.json for Youtarr to use
const jsonPath = path.format({
  dir: parsedPath.dir,
  name: parsedPath.name,
  ext: '.info.json'
});

const videoDirectory = path.dirname(videoPath);
// Poster image uses same filename as video but with .jpg extension
const imagePath = path.join(videoDirectory, parsedPath.name + '.jpg');

// Extract the actual channel folder name that yt-dlp created (already sanitized)
// This is more reliable than using jsonData.uploader which may contain special characters
// that yt-dlp sanitizes differently (e.g., #, :, <, >, etc.)
// In flat mode, videoDirectory IS the channel folder; in nested mode, parent is channel folder
const actualChannelFolderName = isFlatMode
  ? path.basename(videoDirectory)
  : path.basename(path.dirname(videoDirectory));

function shouldWriteChannelPosters() {
  if (skipMediaSidecarFiles) return false;
  const config = configModule.getConfig() || {};
  return config.writeChannelPosters !== false;
}

function shouldWriteVideoNfoFiles() {
  if (skipMediaSidecarFiles) return false;
  const config = configModule.getConfig() || {};
  return config.writeVideoNfoFiles !== false;
}

function shouldWriteVideoFanart() {
  if (skipMediaSidecarFiles) return false;
  const config = configModule.getConfig() || {};
  return config.writeVideoFanart === true;
}

function shouldWriteBackdropImages() {
  if (skipMediaSidecarFiles) return false;
  const config = configModule.getConfig() || {};
  return config.writeBackdropImages === true;
}

function sanitizeReleaseGroupTag(name) {
  const cleaned = String(name || '').replace(/[^a-zA-Z0-9]+/g, '');
  return cleaned || 'YOUTARR';
}

/**
 * Splices a scene-style "<height>p WEBDL-<group>" tag into an
 * episode/movie filename, right before the locked " [id].ext" suffix
 * composeEpisodeFileTemplate/composeVideoFileTemplate always append - see
 * the NZB call site above for why. Resolution comes from probing the
 * actual temp file with ffprobe (falls back to the configured preferred
 * resolution if the probe fails, e.g. on an unusual container).
 */
async function insertNzbReleaseTag(fileName, id, ext, channelName, probeSourcePath) {
  const lockedSuffix = ` [${id}].${ext}`;
  if (!fileName.endsWith(lockedSuffix)) return fileName;
  const stem = fileName.slice(0, -lockedSuffix.length);

  let height = null;
  try {
    const dimensions = await probeVideoDimensions(probeSourcePath);
    if (dimensions) {
      const [, probedHeight] = dimensions.split('x').map((v) => parseInt(v, 10));
      height = selectionTierForHeight(probedHeight);
    }
  } catch (err) {
    logger.debug({ err, probeSourcePath }, 'nzb: resolution probe for release tag failed');
  }
  if (!height) {
    height = Number.parseInt(configModule.getConfig().preferredResolution, 10) || null;
  }

  const qualityTag = height ? `${height}p` : '';
  const group = sanitizeReleaseGroupTag(channelName);
  const releaseTag = [qualityTag, `WEBDL-${group}`].filter(Boolean).join(' ');
  return `${stem} ${releaseTag}${lockedSuffix}`;
}

/**
 * Optional post-download transcode (config.downloadTranscodeVideoCodec, off
 * by default - yt-dlp's own output is used unchanged). Re-encodes the
 * just-downloaded file with ffmpeg using hardwareEncoderModule.js's encoder
 * tuning (the same backends STRM playback transcoding uses), tries the
 * configured hardware encoder first and automatically retries with the
 * matching software encoder if it fails to open (wrong GPU generation,
 * missing driver, etc.). Runs as the very first step in the IIFE below,
 * before NFO/AtomicParsley/moves touch the file, so every downstream step
 * sees the final result - videoPath/parsedPath are reassigned in place by
 * the caller when this returns a different path.
 * @param {string} inputPath
 * @returns {Promise<string>} the final video path - unchanged if transcoding
 *   is off, not applicable, or every encode attempt failed; otherwise a new
 *   .mp4 path (HEVC/AV1 both need mp4's container tagging for Apple
 *   compatibility, so a transcode always lands in .mp4 regardless of the
 *   source container).
 */
async function transcodeDownloadedVideo(inputPath) {
  const cfg = configModule.getConfig() || {};
  const videoCodecSetting = cfg.downloadTranscodeVideoCodec || 'off';
  if (videoCodecSetting === 'off') return inputPath;
  if (!fs.existsSync(inputPath)) {
    logger.warn({ inputPath }, '[Post-Process] Transcode requested but input file not found - skipping');
    return inputPath;
  }

  // STRM cache-on-play: never transcode. strmCacheTargetDir (module-level,
  // parsed from YOUTARR_STRM_CACHE_TARGET_DIR at the top of this file) is
  // already this script's own signal for "this download is an opportunistic
  // cache-on-play materialize, not a permanent one" - reused here rather
  // than a second lookup. A cache-on-play file is temporary (may get
  // reverted back to STRM - see cached_at/sweepExpiredCachedVideos) and
  // already re-encoded live by ytstream on next play regardless, so
  // spending real encode time on it here would be pure waste.
  if (strmCacheTargetDir) {
    logger.debug({ inputPath }, '[Post-Process] Transcode skipped - STRM cache-on-play download, never transcoded');
    return inputPath;
  }

  // NZB grabs: gated by the triggering job's own category config
  // (nzb.categories[].postEncode), on top of the global setting above - a
  // category with postEncode !== true never transcodes, regardless of
  // downloadTranscodeVideoCodec. Every other job type (channel, manual,
  // playlist) has no category concept and just uses the global setting.
  if (activeJobId) {
    try {
      const { Job } = require('../models');
      const { parseAuxData } = require('./jobAuxData');
      const { NZB_LABEL_PREFIX } = require('./download/jobTypes');
      const job = await Job.findOne({ where: { id: activeJobId }, attributes: ['jobType', 'aux_data'] });
      if (job && typeof job.jobType === 'string' && job.jobType.startsWith(NZB_LABEL_PREFIX)) {
        const categoryName = parseAuxData(job.aux_data)?.nzb?.categoryName;
        const category = (cfg.nzb?.categories || []).find((c) => c.name === categoryName);
        if (!category || category.postEncode !== true) {
          logger.debug({ inputPath, categoryName }, '[Post-Process] Transcode skipped - NZB category has post-download encode disabled');
          return inputPath;
        }
      }
    } catch (err) {
      // Fail open toward the pre-existing (global-only) behavior rather
      // than either blocking the download or silently transcoding an NZB
      // category that asked to be excluded - log and let the global
      // setting alone decide, same as a non-NZB job would.
      logger.warn({ err, activeJobId }, '[Post-Process] Transcode: NZB category lookup failed, falling back to global setting only');
    }
  }

  const videoCodec = hardwareEncoderModule.normalizeVideoCodec(videoCodecSetting);
  const hardwareMode = hardwareEncoderModule.normalizeHardwareMode(cfg.downloadTranscodeHardwareMode);
  const audioCodec = hardwareEncoderModule.normalizeAudioCodec(cfg.downloadTranscodeAudioCodec);

  let sourceHeight = null;
  try {
    const dimensions = await probeVideoDimensions(inputPath);
    if (dimensions) {
      const [, height] = dimensions.split('x').map((v) => parseInt(v, 10));
      sourceHeight = Number.isFinite(height) ? height : null;
    }
  } catch (err) {
    logger.debug({ err, inputPath }, '[Post-Process] Transcode: source resolution probe failed');
  }

  // Needed to turn ffmpeg's -progress output (elapsed encoded time, not a
  // percentage) into percent/ETA below. Progress reporting is simply
  // skipped (encode still proceeds) if this probe fails.
  let sourceDurationSeconds = null;
  try {
    sourceDurationSeconds = await probeVideoDuration(inputPath);
  } catch (err) {
    logger.debug({ err, inputPath }, '[Post-Process] Transcode: source duration probe failed');
  }

  const inputDir = path.dirname(inputPath);
  const inputStem = path.parse(inputPath).name;
  const outputPath = path.join(inputDir, `${inputStem}.transcode-tmp.mp4`);

  const PROGRESS_EMIT_INTERVAL_MS = 1000;
  const STDERR_CAP_BYTES = 50000;

  const attempt = (encoder) => new Promise((resolve) => {
    if (fs.existsSync(outputPath)) {
      try {
        fs.removeSync(outputPath);
      } catch {
        // Best-effort cleanup before retrying - a stale temp file here just
        // means this attempt will fail loudly instead.
      }
    }
    // -progress pipe:1 (machine-readable key=value blocks, terminated by a
    // "progress=continue|end" line) drives the periodic marker emission
    // below; -nostats keeps the regular human-readable stats line out of
    // stderr so stderr only ever contains real errors (-loglevel error).
    const ffArgs = [
      '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
      ...encoder.preInputArgs, '-i', inputPath,
    ];
    if (encoder.videoFilters && encoder.videoFilters.length) {
      ffArgs.push('-vf', encoder.videoFilters.join(','));
    }
    if (encoder.pixFmt) {
      ffArgs.push('-pix_fmt', encoder.pixFmt);
    }
    ffArgs.push(...encoder.encoderArgs);
    ffArgs.push(...hardwareEncoderModule.buildAudioEncoderArgs(audioCodec));
    ffArgs.push('-map_metadata', '0', '-movflags', '+faststart', outputPath);

    let stderr = '';
    let progressBuffer = '';
    let block = {};
    let lastEmit = 0;

    const proc = spawn(configModule.ffmpegPath, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    // Not time-sensitive, just bounded against a wedged/hung encoder.
    const watchdog = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        logger.warn({ err }, '[Post-Process] Failed to kill wedged transcode process');
      }
    }, 4 * 60 * 60 * 1000);

    proc.stdout.on('data', (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop(); // keep any partial trailing line for the next chunk

      for (const rawLine of lines) {
        const eq = rawLine.indexOf('=');
        if (eq === -1) continue;
        const key = rawLine.slice(0, eq).trim();
        const value = rawLine.slice(eq + 1).trim();
        block[key] = value;

        if (key !== 'progress') continue;

        // One full report just completed - emit (throttled; always on the
        // final report so the bar reaches 100%) then start the next block.
        const now = Date.now();
        if (sourceDurationSeconds && (now - lastEmit >= PROGRESS_EMIT_INTERVAL_MS || value === 'end')) {
          const outTimeUs = Number(block.out_time_us);
          const speedFactor = parseFloat(String(block.speed || '').replace('x', ''));
          if (Number.isFinite(outTimeUs)) {
            lastEmit = now;
            const elapsedSeconds = outTimeUs / 1_000_000;
            const percent = Math.max(0, Math.min(100, (elapsedSeconds / sourceDurationSeconds) * 100));
            const normalizedSpeed = Number.isFinite(speedFactor) ? speedFactor : 0;
            const etaSeconds = normalizedSpeed > 0
              ? Math.max(0, (sourceDurationSeconds - elapsedSeconds) / normalizedSpeed)
              : 0;
            process.stdout.write(`${TRANSCODE_PROGRESS_MARKER}${JSON.stringify({ percent, etaSeconds, speedFactor: normalizedSpeed })}\n`);
          }
        }
        block = {};
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > STDERR_CAP_BYTES) {
        stderr = stderr.slice(-STDERR_CAP_BYTES);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(watchdog);
      resolve({ ok: false, stderr: err.message });
    });

    proc.on('close', (code) => {
      clearTimeout(watchdog);
      if (code !== 0 || !fs.existsSync(outputPath)) {
        resolve({ ok: false, stderr: stderr.trim().slice(-4000) || `ffmpeg exited with status ${code}` });
        return;
      }
      resolve({ ok: true });
    });
  });

  logger.info({ inputPath, videoCodec, hardwareMode, audioCodec, sourceHeight, sourceDurationSeconds }, '[Post-Process] Transcoding downloaded video');

  let outcome = null;
  if (hardwareMode !== 'none') {
    const hwArgs = hardwareEncoderModule.buildVideoEncoderArgs(hardwareMode, videoCodec, { sourceHeight });
    outcome = await attempt(hwArgs);
    if (!outcome.ok) {
      logger.warn({ hardwareMode, videoCodec, stderr: outcome.stderr }, '[Post-Process] Hardware transcode failed, retrying with software encoder');
    }
  }
  if (!outcome || !outcome.ok) {
    const swArgs = hardwareEncoderModule.buildSoftwareVideoEncoderArgs(videoCodec, { sourceHeight });
    outcome = await attempt(swArgs);
  }

  if (!outcome.ok) {
    logger.error({ videoCodec, stderr: outcome.stderr }, '[Post-Process] Transcode failed with both hardware and software encoders - keeping original file');
    if (fs.existsSync(outputPath)) {
      try {
        fs.removeSync(outputPath);
      } catch {
        // Not worth failing the download over a leftover temp file.
      }
    }
    return inputPath;
  }

  try {
    fs.removeSync(inputPath);
  } catch (err) {
    logger.warn({ err, inputPath }, '[Post-Process] Could not remove pre-transcode original file');
  }
  const finalPath = path.join(inputDir, `${inputStem}.mp4`);
  if (outputPath !== finalPath) {
    fs.moveSync(outputPath, finalPath, { overwrite: true });
  }
  logger.info({ finalPath, videoCodec, hardwareMode }, '[Post-Process] Transcode complete');
  return finalPath;
}

// Helper function to download channel thumbnail if needed
async function downloadChannelThumbnailIfMissing(channelId) {
  const channelThumbPath = path.join(
    configModule.getImagePath(),
    `channelthumb-${channelId}.jpg`
  );

  if (!fs.existsSync(channelThumbPath)) {
    try {

      // Build the channel URL from the channel ID
      const channelUrl = `https://www.youtube.com/channel/${channelId}`;

      // Build yt-dlp command using centralized helper so proxy/sleep/cookies are respected
      const ytdlpArgs = YtdlpCommandBuilder.buildThumbnailDownloadArgs(channelUrl, channelThumbPath);

      const result = spawnSync('yt-dlp', ytdlpArgs, {
        env: {
          ...process.env,
          TMPDIR: tempPathManager.getTempBasePath()
        },
        encoding: 'utf8'
      });

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        throw new Error(result.stderr || `yt-dlp exited with code ${result.status}`);
      }

      // Resize the thumbnail to make it smaller
      if (fs.existsSync(channelThumbPath)) {
        // ffmpeg infers output format from the extension - ".jpg.temp" gives
        // it nothing to go on ("Unable to find a suitable output format"),
        // so keep ".jpg" as the actual extension and put "temp" before it.
        const tempPath = channelThumbPath.replace(/\.jpg$/i, '.temp.jpg');
        execSync(
          `${configModule.ffmpegPath} -loglevel error -y -i "${channelThumbPath}" -vf "scale=iw*0.4:ih*0.4" -q:v 2 "${tempPath}"`,
          { stdio: 'pipe' }
        );
        fs.renameSync(tempPath, channelThumbPath);
      }
    } catch (err) {
      logger.warn({ err }, 'Error downloading channel thumbnail');
    }
  }
}

// Helper function to copy channel thumb as poster.jpg to channel folder
async function copyChannelPosterIfNeeded(channelId, channelFolderPath) {
  if (!shouldWriteChannelPosters()) {
    return;
  }

  try {
    const channelPosterPath = path.join(channelFolderPath, 'poster.jpg');
    // Only copy if poster.jpg doesn't already exist
    if (!fs.existsSync(channelPosterPath)) {
      // First ensure we have the channel thumbnail
      await downloadChannelThumbnailIfMissing(channelId);

      const channelThumbPath = path.join(
        configModule.getImagePath(),
        `channelthumb-${channelId}.jpg`
      );

      if (fs.existsSync(channelThumbPath)) {
        copySyncWithFallback(channelThumbPath, channelPosterPath);
        logger.info({ channelFolderPath }, 'Channel poster.jpg created');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error copying channel poster');
  }
}

// Jellyfin/Kodi show a season's own poster.jpg (or folder.jpg) placed inside
// that season's folder instead of a blank/random image, once one exists
// there. YouTube has no per-season artwork of its own (seasons here are just
// upload years), so reuse the channel thumbnail the same way
// copyChannelPosterIfNeeded reuses it for the channel-level poster.jpg.
async function copySeasonPosterIfNeeded(channelId, seasonFolderPath) {
  if (!shouldWriteChannelPosters()) {
    return;
  }

  try {
    const seasonPosterPath = path.join(seasonFolderPath, 'poster.jpg');
    if (!fs.existsSync(seasonPosterPath)) {
      await downloadChannelThumbnailIfMissing(channelId);

      const channelThumbPath = path.join(
        configModule.getImagePath(),
        `channelthumb-${channelId}.jpg`
      );

      if (fs.existsSync(channelThumbPath)) {
        copySyncWithFallback(channelThumbPath, seasonPosterPath);
        logger.info({ seasonFolderPath }, 'Season poster.jpg created');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error copying season poster');
  }
}

// Jellyfin/Kodi's "logo" (clearlogo) has no YouTube equivalent, so reuse the
// channel avatar the same way copySeasonPosterIfNeeded reuses it for
// poster.jpg - same source image, just filed under the role Jellyfin looks
// for when rendering a logo overlay instead of a poster.
async function copyChannelLogoIfNeeded(channelId, channelFolderPath) {
  if (!shouldWriteChannelPosters()) {
    return;
  }

  try {
    const channelLogoPath = path.join(channelFolderPath, 'logo.jpg');
    if (!fs.existsSync(channelLogoPath)) {
      await downloadChannelThumbnailIfMissing(channelId);

      const channelThumbPath = path.join(
        configModule.getImagePath(),
        `channelthumb-${channelId}.jpg`
      );

      if (fs.existsSync(channelThumbPath)) {
        copySyncWithFallback(channelThumbPath, channelLogoPath);
        logger.info({ channelFolderPath }, 'Channel logo.jpg created');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error copying channel logo');
  }
}

async function copySeasonLogoIfNeeded(channelId, seasonFolderPath) {
  if (!shouldWriteChannelPosters()) {
    return;
  }

  try {
    const seasonLogoPath = path.join(seasonFolderPath, 'logo.jpg');
    if (!fs.existsSync(seasonLogoPath)) {
      await downloadChannelThumbnailIfMissing(channelId);

      const channelThumbPath = path.join(
        configModule.getImagePath(),
        `channelthumb-${channelId}.jpg`
      );

      if (fs.existsSync(channelThumbPath)) {
        copySyncWithFallback(channelThumbPath, seasonLogoPath);
        logger.info({ seasonFolderPath }, 'Season logo.jpg created');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error copying season logo');
  }
}

// Copy-only: the banner cache is populated at channel-add time and by the on-enable sweep.
async function copyChannelBackdropIfNeeded(channelId, channelFolderPath) {
  if (!shouldWriteBackdropImages()) {
    return;
  }

  try {
    const channelBackdropPath = path.join(channelFolderPath, 'backdrop.jpg');
    if (!fs.existsSync(channelBackdropPath)) {
      const channelBannerPath = path.join(
        configModule.getImagePath(),
        `channelbanner-${channelId}.jpg`
      );

      if (fs.existsSync(channelBannerPath)) {
        copySyncWithFallback(channelBannerPath, channelBackdropPath);
        logger.info({ channelFolderPath }, 'Channel backdrop.jpg created');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error copying channel backdrop');
  }
}

// YouTube's channel banner is a wide strip image, matching the aspect ratio
// Jellyfin/Kodi expect for banner.jpg (not the full-screen backdrop.jpg role
// it was previously only saved as). Same cached source as
// copyChannelBackdropIfNeeded, filed under the correct role name as well.
async function copyChannelBannerIfNeeded(channelId, channelFolderPath) {
  if (!shouldWriteBackdropImages()) {
    return;
  }

  try {
    const channelBannerJellyfinPath = path.join(channelFolderPath, 'banner.jpg');
    if (!fs.existsSync(channelBannerJellyfinPath)) {
      const channelBannerPath = path.join(
        configModule.getImagePath(),
        `channelbanner-${channelId}.jpg`
      );

      if (fs.existsSync(channelBannerPath)) {
        copySyncWithFallback(channelBannerPath, channelBannerJellyfinPath);
        logger.info({ channelFolderPath }, 'Channel banner.jpg created');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error copying channel banner');
  }
}

// Parse the per-video owner-channel map (YOUTARR_OWNER_CHANNEL_MAP, set for
// playlist downloads). Maps youtube_id -> owning channel_id, from the per-video
// attribution captured at playlist sync. An entry wins over the .info.json
// channel_id, which for VEVO/Topic uploads points at the auto-generated upload
// channel instead of the channel the user subscribed to.
function parseOwnerChannelMapEnv() {
  const raw = process.env.YOUTARR_OWNER_CHANNEL_MAP;
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    logger.warn({ err }, 'Post-process: could not parse owner channel map');
    return null;
  }
}

// Find the tracked channel that owns this video when no explicit owner was
// passed (manual URL paste, channel auto-download). `channelvideos` records
// every channel that listed a video; for a VEVO/Topic upload that includes both
// the untracked auto-channel (the video's own channel_id) and the
// subscribed/artist channel. Prefer the video's own channel_id when tracked,
// otherwise any tracked associated channel; never an untracked id.
async function resolveTrackedOwnerChannelId(youtubeId, metadataChannelId) {
  if (!youtubeId || youtubeId === 'default') {
    return null;
  }
  try {
    const ChannelVideo = require('../models/channelvideo');
    const { Channel } = require('../models');

    const rows = await ChannelVideo.findAll({
      where: { youtube_id: youtubeId },
      attributes: ['channel_id'],
    });
    // Video's own channel first, then the channels that listed it.
    const candidates = [metadataChannelId, ...rows.map((r) => r.channel_id)].filter(Boolean);
    const unique = [...new Set(candidates)];
    if (unique.length === 0) {
      return null;
    }

    const tracked = await Channel.findAll({
      where: { channel_id: unique },
      attributes: ['channel_id', 'enabled'],
    });
    const enabledIds = new Set(tracked.filter((c) => c.enabled).map((c) => c.channel_id));
    const trackedIds = new Set(tracked.map((c) => c.channel_id));
    // Prefer an enabled owner: only enabled channels contribute routing
    // settings downstream, so a disabled candidate (e.g. a hidden auto-created
    // playlist source channel) must not shadow a later enabled association.
    // A disabled-only match still returns so metadata backfill keeps working.
    for (const candidate of unique) {
      if (enabledIds.has(candidate)) {
        return candidate;
      }
    }
    for (const candidate of unique) {
      if (trackedIds.has(candidate)) {
        return candidate;
      }
    }
    return null;
  } catch (err) {
    logger.warn({ err, youtubeId }, 'Post-process: tracked owner channel lookup failed');
    return null;
  }
}

// Main execution wrapped in async IIFE to handle async operations
(async () => {
  if (fs.existsSync(jsonPath)) {
    // Optional post-download transcode (config.downloadTranscodeVideoCodec,
    // off by default) - run first, before anything else (NFO/AtomicParsley/
    // moves) touches the file, so every downstream step already sees the
    // final result. jsonPath/imagePath are unaffected (named from the stem,
    // not the extension) so only videoPath/parsedPath need reassigning here.
    // Audio-only downloads (mp3) have nothing to transcode.
    if (parsedPath.ext.toLowerCase() !== '.mp3') {
      const transcodedPath = await transcodeDownloadedVideo(videoPath);
      if (transcodedPath !== videoPath) {
        videoPath = transcodedPath;
        parsedPath = path.parse(videoPath);
      }
    }

    // Read the JSON file to get the upload_date
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    // Parse the upload_date (format: YYYYMMDD) into a Date object
    let uploadDate = null;
    if (jsonData.upload_date) {
      try {
        const dateStr = jsonData.upload_date.toString();
        const year = dateStr.substring(0, 4);
        const month = dateStr.substring(4, 6);
        const day = dateStr.substring(6, 8);
        uploadDate = new Date(`${year}-${month}-${day}T00:00:00`);

        // Check if the date is valid
        if (isNaN(uploadDate.getTime())) {
          logger.warn({ uploadDate: jsonData.upload_date }, 'Invalid upload_date format');
          uploadDate = null;
        }
      } catch (err) {
        logger.warn({ err, uploadDate: jsonData.upload_date }, 'Error parsing upload_date');
        uploadDate = null;
      }
    }

    const filename = path.basename(jsonPath, '.info.json'); // get the filename
    const matches = filename.match(/\[(.*?)\]/g); // Extract all occurrences of video IDs enclosed in brackets
    const id = matches
      ? matches[matches.length - 1].replace(/[[\]]/g, '')
      : 'default'; // take the last match and remove brackets or use 'default'
    const directoryPath = path.join(configModule.getJobsPath(), 'info');
    const newImagePath = configModule.getImagePath();

    fs.ensureDirSync(directoryPath); // ensures that the directory exists, if it doesn't it will create it
    const newJsonPath = path.join(directoryPath, `${id}.info.json`); // define the new path

    // Phase 1: Early subfolder detection
    // Determine target channel folder (with subfolder if applicable) BEFORE any moves
    let targetChannelFolder = null;
    let channelSubFolder = null;

    // Check for subfolder override from manual download (passed via environment variable)
    const subfolderOverride = process.env.YOUTARR_SUBFOLDER_OVERRIDE || null;

    // Check for explicit rating override from manual download
    const ratingOverrideEnv = process.env.YOUTARR_OVERRIDE_RATING;

    // Soft fallbacks (playlist defaults); used only when the real channel has no setting.
    // A present hard rating override always wins, so suppress the rating fallback in that case.
    const subfolderFallbackEnv = process.env.YOUTARR_SUBFOLDER_FALLBACK || null;
    const ratingFallbackEnv = process.env.YOUTARR_OVERRIDE_RATING ? null : (process.env.YOUTARR_RATING_FALLBACK || null);

    // Real season/episode from an NZB grab's tvsearch (see
    // server/routes/nzb.js and ytdlpEnvBuilder.js) - used below instead of
    // seriesEpisodeResolver's upload-year-as-season default, only when both
    // are present.
    const seriesSeasonOverrideEnv = process.env.YOUTARR_SERIES_SEASON_OVERRIDE
      ? Number.parseInt(process.env.YOUTARR_SERIES_SEASON_OVERRIDE, 10)
      : null;
    const seriesEpisodeOverrideEnv = process.env.YOUTARR_SERIES_EPISODE_OVERRIDE
      ? Number.parseInt(process.env.YOUTARR_SERIES_EPISODE_OVERRIDE, 10)
      : null;

    // Resolve which channel owns this download, in priority order: explicit
    // owner env (channel-page download) > per-video map (playlist download) >
    // tracked channel already associated with this video > the video's own
    // channel_id. The .info.json channel_id alone misses VEVO/Topic uploads,
    // whose auto-generated channel differs from the subscribed channel.
    const ownerChannelId = process.env.YOUTARR_OWNER_CHANNEL_ID
      ? process.env.YOUTARR_OWNER_CHANNEL_ID.trim()
      : null;
    const ownerChannelMap = ownerChannelId ? null : parseOwnerChannelMapEnv();
    const mappedOwnerChannelId = ownerChannelMap && ownerChannelMap[id] ? String(ownerChannelMap[id]).trim() : null;
    const metadataChannelId = jsonData.channel_id ? jsonData.channel_id.trim() : null;
    const explicitOwnerChannelId = ownerChannelId || mappedOwnerChannelId;
    const trackedOwnerChannelId = explicitOwnerChannelId
      ? null
      : await resolveTrackedOwnerChannelId(id, metadataChannelId);
    const lookupChannelId = explicitOwnerChannelId || trackedOwnerChannelId || metadataChannelId;

    // Always look up channel to apply default rating (independent of subfolder)
    let channelRecord = null;
    if (lookupChannelId) {
      try {
        // Use the centralized models export to ensure proper associations/initialization
        const { Channel } = require('../models');

        const channelId = lookupChannelId;
        channelRecord = await Channel.findOne({
          where: { channel_id: channelId },
          attributes: ['id', 'sub_folder', 'title', 'uploader', 'folder_name', 'default_rating', 'enabled', 'skip_video_folder', 'library_mode', 'season_episode_regex']
        });

        logger.info({ channelId, ownerProvided: !!ownerChannelId, found: !!channelRecord }, 'Post-process channel lookup');
        if (channelRecord) {
          logger.info({ channelId, defaultRating: channelRecord.default_rating }, 'Post-process channel default rating');

          // Backfill channel metadata learned from the download. folder_name is the
          // yt-dlp-sanitized directory name; title/uploader use the raw channel name
          // and are only filled when currently empty (e.g. a channel auto-seeded from
          // a playlist with just a channel_id, before the playlist sync captured a
          // channel_name), so an activated/refreshed channel is never clobbered.
          // Only when the record was resolved via the video's own channel_id: the
          // on-disk folder is named after the video's uploader, so for an
          // owner-resolved record (e.g. the artist channel of a VEVO/Topic upload)
          // these values describe a different channel and must not be written.
          const isUploaderChannel = lookupChannelId === metadataChannelId;
          const realChannelName = jsonData.uploader || jsonData.channel || null;
          const channelPatch = {};
          if (isUploaderChannel && actualChannelFolderName && channelRecord.folder_name !== actualChannelFolderName) {
            channelPatch.folder_name = actualChannelFolderName;
          }
          if (isUploaderChannel && realChannelName && !channelRecord.title) channelPatch.title = realChannelName;
          if (isUploaderChannel && realChannelName && !channelRecord.uploader) channelPatch.uploader = realChannelName;
          if (Object.keys(channelPatch).length > 0) {
            try {
              await Channel.update(channelPatch, { where: { id: channelRecord.id } });
              Object.assign(channelRecord, channelPatch);
              logger.info({ channelId, patch: channelPatch }, 'Post-process backfilled channel metadata');
            } catch (updateErr) {
              logger.error({ err: updateErr }, 'Post-process error updating channel metadata');
            }
          }
        } else {
          logger.info({ channelId }, 'Post-process channel not found; assuming no channel default rating');
        }
      } catch (err) {
        logger.error({ err }, 'Post-process error looking up channel');
      }
    }

    // Only an enabled channel contributes routing settings (rating, subfolder). A disabled
    // channel is invisible in the UI, so treat it as untracked and fall through to the
    // playlist fallback -> global. channelRecord above is still used for metadata backfill
    // regardless of enabled state.
    const settingsChannelRecord = channelRecord && channelRecord.enabled ? channelRecord : null;

    // Outgoing layout: in per-video mode, resolve flat-vs-subfolder from the
    // video's real channel (hard override -> channel tri-state -> global);
    // fixed mode keeps the per-job layout. Incoming per-video layout is always
    // nested, so the only conversion ever performed is nested -> flat.
    const outgoingFlat = perVideoStructure
      ? downloadSettingsResolver.resolveSkipVideoFolder({
        override: skipVideoFolderOverrideEnv === undefined
          ? {}
          : { skipVideoFolder: skipVideoFolderOverrideEnv === 'true' },
        channel: settingsChannelRecord,
        config: configModule.getConfig(),
      })
      : isFlatMode;
    logger.info({ perVideoStructure, incomingFlat: isFlatMode, outgoingFlat }, 'Post-process resolved file structure');

    // Determine effective rating using strict priority order:
    // 1. Manual Override
    // 2. Channel Default
    // 3. Mapped Metadata
    // 4. NR
    const manualOverride = (ratingOverrideEnv !== undefined && ratingOverrideEnv !== null && ratingOverrideEnv !== '')
      ? ratingOverrideEnv
      : undefined;

    const effectiveRating = ratingMapper.determineEffectiveRating(
      jsonData,
      settingsChannelRecord ? settingsChannelRecord.default_rating : null,
      manualOverride,
      ratingFallbackEnv
    );

    jsonData.normalized_rating = effectiveRating.normalized_rating;
    jsonData.rating_source = effectiveRating.rating_source;

    // Log the decision
    if (jsonData.normalized_rating) {
      logger.info({ rating: jsonData.normalized_rating, source: jsonData.rating_source }, 'Post-process applied rating');
    } else {
      logger.info({ source: jsonData.rating_source || 'None' }, 'Post-process no rating applied');
    }

    // TV Series library mode: resolve movie-vs-series BEFORE subfolder
    // resolution, so a series-mode video with no other subfolder choice can
    // fall through to the dedicated seriesOutputSubfolder default below.
    const libraryModeFallbackEnv = process.env.YOUTARR_LIBRARY_MODE_FALLBACK || null;
    let libraryMode = downloadSettingsResolver.resolveFinalLibraryMode({
      channelRecord: settingsChannelRecord,
      softFallback: libraryModeFallbackEnv,
      globalDefault: (configModule.getConfig() || {}).defaultLibraryMode,
    });

    // Per-video subfolder precedence; see resolveFinalSubfolder for the full contract.
    channelSubFolder = downloadSettingsResolver.resolveFinalSubfolder({
      hardOverride: subfolderOverride,
      channelRecord: settingsChannelRecord,
      softFallback: subfolderFallbackEnv,
      globalDefault: configModule.getDefaultSubfolder(),
    });

    // Series mode's own default subfolder: applies only when nothing else
    // already resolved one (no hard override, no explicit channel/playlist
    // choice) - most channels have no sub_folder set at all, so this is the
    // only way series-mode content reliably lands in a dedicated location
    // the user can point a separate Jellyfin "Shows" library at.
    if (libraryMode === 'series' && !channelSubFolder) {
      const seriesSubfolder = ((configModule.getConfig() || {}).seriesOutputSubfolder || '').trim();
      if (seriesSubfolder) {
        channelSubFolder = seriesSubfolder;
      }
    }

    if (channelSubFolder) {
      const baseDir = configModule.directoryPath;
      targetChannelFolder = buildChannelPath(baseDir, channelSubFolder, actualChannelFolderName);
    }
    logger.info({ subfolder: channelSubFolder }, 'Post-process resolved target subfolder');

    let seriesSeason = null;
    let seriesEpisode = null;
    let seriesTarget = null; // { seasonFolderPath, episodeFileName, episodeStemBase, finalPath }
    // Only set when the season/episode decode regex actually matched - the
    // title with its matched "Season 21, Episode 10"-style span collapsed
    // down to "S21E10", so the filename doesn't spell out the same info
    // twice (once here, once as composeEpisodeFileTemplate's own S%dE%03d
    // prefix) and burn its 64-char truncation budget on the redundant text.
    // null everywhere else - jsonData.title (unmodified) is used instead.
    let seriesEpisodeFilenameTitle = null;

    if (libraryMode === 'series') {
      if (seriesSeasonOverrideEnv != null && seriesEpisodeOverrideEnv != null) {
        seriesSeason = seriesSeasonOverrideEnv;
        seriesEpisode = seriesEpisodeOverrideEnv;
        logger.info({ id, season: seriesSeason, episode: seriesEpisode }, 'Post-process: using real season/episode from NZB grab instead of upload-year-as-season');
      } else if (settingsChannelRecord && settingsChannelRecord.season_episode_regex) {
        // Channel Settings -> Filters -> Season/Episode Decoding (series
        // library mode only). Decodes against the same title
        // composeEpisodeFileTemplate itself uses below. A title the
        // pattern doesn't match (or a script failure) falls back to the
        // upload-year-as-season default for THIS video only, rather than
        // failing the whole download - same graceful-degradation contract
        // channelSettingsModule.previewCombinedFilters shows in the UI.
        const channelSettingsModule = require('./channelSettingsModule');
        const decoded = channelSettingsModule.decodeSeasonEpisode(
          settingsChannelRecord.season_episode_regex,
          jsonData.title || jsonData.fulltitle || ''
        );
        if (!decoded.error && decoded.matches && decoded.season != null && decoded.episode != null) {
          seriesSeason = decoded.season;
          seriesEpisode = decoded.episode;
          seriesEpisodeFilenameTitle = decoded.cleanedTitle || null;
          logger.info({ id, season: seriesSeason, episode: seriesEpisode }, 'Post-process: using channel season/episode decode regex');
        } else {
          if (decoded.error) {
            logger.warn({ id, err: decoded.error }, 'Post-process: season/episode decode regex failed; falling back to upload-year-as-season default');
          } else {
            logger.info({ id, title: jsonData.title }, 'Post-process: season/episode decode regex did not match this title; falling back to upload-year-as-season default');
          }
          seriesSeason = seriesEpisodeResolver.deriveSeasonYear(jsonData.upload_date);
        }
      } else {
        seriesSeason = seriesEpisodeResolver.deriveSeasonYear(jsonData.upload_date);
      }
      if (seriesSeason == null) {
        // Can't place this video in a season folder without a valid upload
        // date - fall back to movie mode for this single video rather than
        // failing the whole download.
        logger.warn({ id, uploadDate: jsonData.upload_date }, 'Post-process: series mode requires a valid upload_date, falling back to movie mode for this video');
        libraryMode = 'movie';
      } else {
        if (seriesEpisode == null) {
          seriesEpisode = await seriesEpisodeResolver.resolveEpisodeNumber({
            channelId: lookupChannelId,
            youtubeId: id,
            season: seriesSeason,
          });
        }

        // Channel root is the same folder movie mode would use as the
        // channel's directory: the subfolder-aware targetChannelFolder if
        // set, otherwise derived from the incoming temp layout - same
        // derivation the "no subfolder" branches below already use.
        const standardFinalPathForSeries = tempPathManager.convertTempToFinal(videoPath);
        const seriesChannelRoot = targetChannelFolder || (isFlatMode
          ? path.dirname(standardFinalPathForSeries)
          : path.dirname(path.dirname(standardFinalPathForSeries)));

        const ext = parsedPath.ext.replace(/^\./, '');
        let episodeFileName = composeEpisodeFileTemplate(configModule.getConfig().episodeFilenamePrefix, {
          title: seriesEpisodeFilenameTitle || jsonData.title,
          season: seriesSeason,
          episode: seriesEpisode,
          id,
          channel: jsonData.uploader || jsonData.channel,
          ext,
        });
        // NZB grabs (see server/routes/nzb.js): Sonarr/Radarr parse quality
        // and release group from the file's own name - without a
        // recognizable tag they show the imported episode as "Unknown"
        // quality / "Release Group (Missing)" even though the download
        // itself succeeded. Insert a normal scene-style "<height>p
        // WEBDL-<group>" tag (Sonarr's release-group regex expects a
        // trailing "-GROUP" token) before the locked " [id].ext" suffix
        // composeEpisodeFileTemplate always appends, using the channel as
        // the "group" and the video's own actually-downloaded resolution
        // (probed via ffprobe, not the configured preference - yt-dlp may
        // not have found a format at the preferred height and fallen back
        // lower) - gets the imported result as close to a normal release as
        // possible. Only for NZB - Youtarr's own regular library naming is
        // untouched.
        if (skipMediaSidecarFiles) {
          episodeFileName = await insertNzbReleaseTag(episodeFileName, id, ext, jsonData.uploader || jsonData.channel, videoPath);
        }
        const episodeStemBase = path.basename(episodeFileName, path.extname(episodeFileName));
        const seasonFolderPath = buildSeasonFolderPath(seriesChannelRoot, seriesSeason);

        seriesTarget = {
          channelRoot: seriesChannelRoot,
          seasonFolderPath,
          episodeFileName,
          episodeStemBase,
          finalPath: path.join(seasonFolderPath, episodeFileName),
        };
        logger.info({ id, season: seriesSeason, episode: seriesEpisode, finalPath: seriesTarget.finalPath }, 'Post-process resolved series library mode target');
      }
    }

    // Phase 2: Calculate the final path for _actual_filepath with subfolder if applicable
    // Downloads always go to temp first, so we need to store the FINAL path, not the temp path
    let finalVideoPathForJson;

    if (strmCacheTargetDir && strmCacheFileStem) {
      finalVideoPathForJson = path.join(strmCacheTargetDir, `${strmCacheFileStem}${parsedPath.ext}`);
    } else if (libraryMode === 'series' && seriesTarget) {
      finalVideoPathForJson = seriesTarget.finalPath;
    } else if (targetChannelFolder) {
      // Channel has subfolder - calculate path with subfolder included
      const videoFileName = path.basename(videoPath);
      if (outgoingFlat) {
        finalVideoPathForJson = path.join(targetChannelFolder, videoFileName);
      } else {
        const videoDirectoryName = path.basename(videoDirectory);
        finalVideoPathForJson = path.join(targetChannelFolder, videoDirectoryName, videoFileName);
      }
    } else {
      // No subfolder - use standard temp-to-final conversion
      const standardFinalPath = tempPathManager.convertTempToFinal(videoPath);
      if (outgoingFlat && !isFlatMode) {
        // Incoming nested, outgoing flat: hoist the file out of its video folder
        finalVideoPathForJson = path.join(
          path.dirname(path.dirname(standardFinalPath)),
          path.basename(standardFinalPath)
        );
      } else {
        finalVideoPathForJson = standardFinalPath;
      }
    }

    // Add the actual video filepath to the JSON data before moving it
    // IMPORTANT: This should always be the final path, never the temp path
    jsonData._actual_filepath = finalVideoPathForJson;
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));

    fs.moveSync(jsonPath, newJsonPath, { overwrite: true }); // move the file

    // Generate NFO file for Jellyfin/Kodi/Emby compatibility if enabled
    if (shouldWriteVideoNfoFiles()) {
      if (libraryMode === 'series' && seriesTarget) {
        nfoGenerator.writeEpisodeNfoFile(videoPath, jsonData, {
          season: seriesSeason,
          episode: seriesEpisode,
          showTitle: (settingsChannelRecord && settingsChannelRecord.title) || jsonData.uploader || jsonData.channel,
        });
      } else {
        nfoGenerator.writeVideoNfoFile(videoPath, jsonData);
      }
    }

    // Check if this is an audio file (MP3) - skip video-specific metadata embedding
    const isAudioFile = parsedPath.ext.toLowerCase() === '.mp3';

    // Detect companion video file for dual-format downloads (video_mp3 mode)
    // When yt-dlp runs with --extract-audio --keep-video, it produces both MP4 and MP3
    // but only calls --exec for the final MP3 file. We need to track the MP4 as well.
    let companionVideoPath = null;
    if (isAudioFile) {
      const potentialVideoPath = path.join(parsedPath.dir, parsedPath.name + '.mp4');
      if (fs.existsSync(potentialVideoPath)) {
        companionVideoPath = potentialVideoPath;
        logger.info({ audioPath: videoPath, videoPath: companionVideoPath },
          '[Post-Process] Dual-format download detected (video_mp3 mode)');
      }
    }

    // Embed iTunes-compatible metadata into the MP4 using AtomicParsley.
    // AtomicParsley writes directly to the iTunes atom container (moov.udta.meta.ilst)
    // which Plex reads for "Other Videos" / Personal Media libraries.
    // It modifies the file in-place (--overWrite), so no temp file dance is needed.
    // Skip for audio-only downloads (MP3 files)
    if (isAudioFile) {
      logger.info('[Post-Process] Audio file detected, skipping video metadata embedding');
    } else try {
      const apArgs = [videoPath];

      // Title (channel name + video title)
      const channelName = jsonData.uploader || jsonData.channel || jsonData.uploader_id || '';
      if (channelName && jsonData.title) {
        apArgs.push('--title', `${channelName} - ${jsonData.title}`);
      }

      // Genre from YouTube categories
      if (jsonData.categories && jsonData.categories.length > 0) {
        apArgs.push('--genre', jsonData.categories.join(';'));
      }

      // Channel name metadata
      if (channelName) {
        apArgs.push('--TVNetwork', channelName);
        apArgs.push('--copyright', channelName);  // Plex maps cprt atom → Studio
        apArgs.push('--artist', channelName);
        apArgs.push('--album', channelName);       // Plex maps album → Collection
      }

      // Tags as keywords
      if (jsonData.tags && jsonData.tags.length > 0) {
        apArgs.push('--keyword', jsonData.tags.slice(0, 10).join(';'));
      }

      // Add release date for Plex/mp4 embedded metadata
      // Good lord Plex is finicky
      if (jsonData.upload_date) {
        const year = jsonData.upload_date.substring(0, 4);
        const month = jsonData.upload_date.substring(4, 6);
        const day = jsonData.upload_date.substring(6, 8);
        const releaseDate = `${year}-${month}-${day}`;
        apArgs.push('--year', `${releaseDate}`);
      }

      // Description for Plex Summary
      if (jsonData.description) {
        apArgs.push('--description', jsonData.description.substring(0, 255));
        apArgs.push('--longdesc', jsonData.description);
      }

      // Media type (stik=9 → Movie, used by Plex for personal media)
      apArgs.push('--stik', 'Movie');

      // Content rating via iTunEXTC atom — this is what Plex actually reads
      const iTunEXTC = ratingMapper.mapToITunEXTC(jsonData.normalized_rating);
      if (iTunEXTC) {
        apArgs.push('--rDNSatom', iTunEXTC, 'name=iTunEXTC', 'domain=com.apple.iTunes');
      }

      apArgs.push('--overWrite');

      logger.info('Embedding metadata via AtomicParsley for Plex');
      const result = spawnSync(configModule.atomicParsleyPath, apArgs, {
        stdio: 'pipe',
        maxBuffer: 10 * 1024 * 1024
      });

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        const stderr = result.stderr ? result.stderr.toString() : 'Unknown error';
        throw new Error(`AtomicParsley exited with status ${result.status}: ${stderr}`);
      }

      logger.info('Successfully embedded metadata via AtomicParsley');
    } catch (err) {
      logger.warn({ err }, 'Could not embed metadata via AtomicParsley');
    }

    if (fs.existsSync(imagePath)) {
      // check if image thumbnail exists
      const newImageFullPath = path.join(newImagePath, `videothumb-${id}.jpg`); // define the new path for image thumbnail
      const newImageFullPathSmall = path.join(
        newImagePath,
        `videothumb-${id}-small.jpg`
      ); // define the new path for image thumbnail
      copySyncWithFallback(imagePath, newImageFullPath, { overwrite: true }); // copy the image thumbnail

      // Resize the image using ffmpeg with proper settings to avoid deprecated format warnings
      // Using -loglevel error to suppress the deprecated pixel format warnings but still show actual errors
      try {
        execSync(
          `${configModule.ffmpegPath} -loglevel error -y -i "${newImageFullPath}" -vf "scale=iw*0.5:ih*0.5" -q:v 2 "${newImageFullPathSmall}"`,
          { stdio: 'inherit' }
        );
        fs.rename(newImageFullPathSmall, newImageFullPath);
        logger.info('Image resized successfully');
      } catch (err) {
        logger.error({ err }, 'Error resizing image');
      }
    }

    // Set the file timestamps to match the upload date
    if (uploadDate) {
      // Set timestamp for the video/audio file (whatever was passed to post-processor)
      if (fs.existsSync(videoPath)) {
        try {
          fs.utimesSync(videoPath, uploadDate, uploadDate);
          logger.info({ timestamp: uploadDate.toISOString() }, 'Set primary file timestamp');
        } catch (err) {
          logger.warn({ err }, 'Error setting primary file timestamp');
        }
      }

      // Set timestamp for companion video file (dual-format downloads)
      if (companionVideoPath && fs.existsSync(companionVideoPath)) {
        try {
          fs.utimesSync(companionVideoPath, uploadDate, uploadDate);
          logger.info({ timestamp: uploadDate.toISOString() }, 'Set companion video timestamp');
        } catch (err) {
          logger.warn({ err }, 'Error setting companion video timestamp');
        }
      }

      // Set timestamp for the thumbnail
      if (fs.existsSync(imagePath)) {
        try {
          fs.utimesSync(imagePath, uploadDate, uploadDate);
          logger.info({ timestamp: uploadDate.toISOString() }, 'Set thumbnail timestamp');
        } catch (err) {
          logger.warn({ err }, 'Error setting thumbnail timestamp');
        }
      }

      // Set timestamp for the directory
      if (fs.existsSync(videoDirectory)) {
        try {
          fs.utimesSync(videoDirectory, uploadDate, uploadDate);
          logger.info({ timestamp: uploadDate.toISOString() }, 'Set directory timestamp');
        } catch (err) {
          logger.warn({ err }, 'Error setting directory timestamp');
        }
      }
    }

    // Phase 3: Move files from temp to final location
    // Downloads are always staged in temp, so we move to final location here
    // This handles subfolder routing atomically (one move instead of two)
    let finalVideoPath = videoPath;

    if (tempPathManager.isTempPath(videoPath)) {
      logger.info({ isFlatMode }, '[Post-Process] Moving files from temp to final location');

      // Calculate target video directory based on subfolder setting
      const videoDirectoryName = path.basename(videoDirectory);
      const videoFileName = path.basename(videoPath);
      let targetVideoDirectory;
      let targetChannelFolderForMove;

      if (strmCacheTargetDir && strmCacheFileStem) {
        // STRM cache-on-play: pinned directory, bypasses subfolder/flat/series
        // resolution entirely - see the strmCacheTargetDir declaration above.
        targetVideoDirectory = strmCacheTargetDir;
        targetChannelFolderForMove = strmCacheTargetDir;
      } else if (libraryMode === 'series' && seriesTarget) {
        // Series mode: files land flat inside the season folder, renamed to
        // the episode filename template - never nested per-episode like
        // movie mode, and independent of the outgoingFlat/subfolder logic.
        targetVideoDirectory = seriesTarget.seasonFolderPath;
        targetChannelFolderForMove = seriesTarget.seasonFolderPath;
      } else if (targetChannelFolder) {
        targetVideoDirectory = outgoingFlat
          ? targetChannelFolder
          : path.join(targetChannelFolder, videoDirectoryName);
        targetChannelFolderForMove = targetChannelFolder;
        console.log(`[Post-Process] Moving to subfolder location: ${channelSubFolder}`);
      } else {
        // No subfolder - move to standard location
        const standardFinalPath = tempPathManager.convertTempToFinal(videoPath);
        // standardFinalPath mirrors the INCOMING temp layout; derive the
        // channel folder from that layout before applying the outgoing one.
        targetChannelFolderForMove = isFlatMode
          ? path.dirname(standardFinalPath)
          : path.dirname(path.dirname(standardFinalPath));
        targetVideoDirectory = outgoingFlat
          ? targetChannelFolderForMove
          : path.join(targetChannelFolderForMove, videoDirectoryName);
      }

      logger.info({ from: videoDirectory, to: targetVideoDirectory, isFlatMode }, '[Post-Process] Moving video directory');

      try {
        // Ensure parent channel directory exists (with retries for NFS/cross-filesystem transient errors)
        await ensureDirWithRetries(targetChannelFolderForMove, { retries: 5, delayMs: 500 });

        // Clean up yt-dlp intermediate files before moving
        // In video_mp3 mode with --extract-audio --keep-video, yt-dlp doesn't always
        // clean up these intermediate files as it normally would
        const filesInDir = await fs.readdir(videoDirectory);
        for (const file of filesInDir) {
          // Match yt-dlp fragment patterns: .f###.ext or .f###-###.ext where ext is mp4/m4a/webm/mkv
          if (/\.f[\d-]+\.(mp4|m4a|webm|mkv)$/i.test(file)) {
            const fragmentPath = path.join(videoDirectory, file);
            logger.info({ fragmentPath }, '[Post-Process] Removing yt-dlp fragment file');
            await fs.remove(fragmentPath);
          }
          // Remove original thumbnail files (.webp) - these should have been converted to .jpg
          else if (/\.webp$/i.test(file)) {
            const webpPath = path.join(videoDirectory, file);
            logger.info({ webpPath }, '[Post-Process] Removing original webp thumbnail');
            await fs.remove(webpPath);
          }
          // Remove original subtitle files (.vtt) - these should have been converted to .srt
          else if (/\.vtt$/i.test(file)) {
            const vttPath = path.join(videoDirectory, file);
            logger.info({ vttPath }, '[Post-Process] Removing original vtt subtitle');
            await fs.remove(vttPath);
          }
        }

        if (strmCacheTargetDir && strmCacheFileStem) {
          // STRM cache-on-play: rename-and-move every file sharing the temp
          // stem into the pinned target directory, using the SAME technique
          // series mode uses below (matched-by-id file loop, never a whole-
          // directory move) - required regardless of this video's own
          // libraryMode, since a series video's target directory is a season
          // folder SHARED with other episodes and must never be wiped/moved
          // wholesale for just this one video.
          const oldStem = parsedPath.name;
          const allFilesInDir = await fs.readdir(videoDirectory);
          const matchedFiles = allFilesInDir.filter(
            file => file.includes(`[${id}]`) || file.includes(` - ${id}`)
          );
          for (const file of matchedFiles) {
            const suffix = file.startsWith(oldStem) ? file.slice(oldStem.length) : path.extname(file);
            const newFileName = `${strmCacheFileStem}${suffix}`;
            const srcPath = path.join(videoDirectory, file);
            const destPath = path.join(targetVideoDirectory, newFileName);
            if (await fs.pathExists(destPath)) {
              logger.warn({ destPath }, '[Post-Process] Target file already exists, overwriting (STRM cache-on-play)');
              await fs.remove(destPath);
            }
            await moveWithRetries(srcPath, destPath, { retries: 5, delayMs: 500 });
            logger.info({ file, newFileName }, '[Post-Process] Moved+renamed file (STRM cache-on-play)');
          }

          finalVideoPath = path.join(targetVideoDirectory, `${strmCacheFileStem}${parsedPath.ext}`);

          logger.info({ targetVideoDirectory }, '[Post-Process] Successfully moved files to final location (STRM cache-on-play)');
        } else if (libraryMode === 'series' && seriesTarget) {
          // Series mode: rename-and-move every file sharing the temp stem
          // into the season folder using the episode filename template.
          // Unlike movie mode this always renames (not just moves), since
          // the episode number is only known now, at finalize time.
          const oldStem = parsedPath.name;
          const allFilesInDir = await fs.readdir(videoDirectory);
          const matchedFiles = allFilesInDir.filter(
            file => file.includes(`[${id}]`) || file.includes(` - ${id}`)
          );
          for (const file of matchedFiles) {
            const suffix = file.startsWith(oldStem) ? file.slice(oldStem.length) : path.extname(file);
            const newFileName = `${seriesTarget.episodeStemBase}${suffix}`;
            const srcPath = path.join(videoDirectory, file);
            const destPath = path.join(targetVideoDirectory, newFileName);
            if (await fs.pathExists(destPath)) {
              logger.warn({ destPath }, '[Post-Process] Target file already exists, overwriting (series mode)');
              await fs.remove(destPath);
            }
            await moveWithRetries(srcPath, destPath, { retries: 5, delayMs: 500 });
            logger.info({ file, newFileName }, '[Post-Process] Moved+renamed file (series mode)');
          }

          finalVideoPath = path.join(targetVideoDirectory, seriesTarget.episodeFileName);

          logger.info({ targetVideoDirectory }, '[Post-Process] Successfully moved files to final location (series mode)');
        } else if (outgoingFlat) {
          // Flat mode: move individual files from temp channel folder to final channel folder
          // Filter by video ID to avoid moving files belonging to other downloads
          const allFilesInDir = await fs.readdir(videoDirectory);
          // Bracketed form [ID] is the yt-dlp default; dash form " - ID" is a fallback
          const updatedFilesInDir = allFilesInDir.filter(
            file => file.includes(`[${id}]`) || file.includes(` - ${id}`)
          );
          for (const file of updatedFilesInDir) {
            const srcPath = path.join(videoDirectory, file);
            const destPath = path.join(targetVideoDirectory, file);
            // Overwrite if the file already exists at destination
            if (await fs.pathExists(destPath)) {
              logger.warn({ destPath }, '[Post-Process] Target file already exists, overwriting');
              await fs.remove(destPath);
            }
            await moveWithRetries(srcPath, destPath, { retries: 5, delayMs: 500 });
            logger.info({ file }, '[Post-Process] Moved file (flat mode)');
          }

          // Update paths to reflect final locations
          finalVideoPath = path.join(targetVideoDirectory, videoFileName);

          logger.info({ targetVideoDirectory }, '[Post-Process] Successfully moved files to final location (flat mode)');
        } else {
          // Nested mode: move the entire video directory atomically

          // Check if target video directory already exists (rare, but handle gracefully)
          const targetExists = await fs.pathExists(targetVideoDirectory);

          if (targetExists) {
            logger.warn({ targetVideoDirectory }, '[Post-Process] Target directory already exists, removing before move');
            await fs.remove(targetVideoDirectory);
          }

          // Move the entire video directory from temp to final location (with retries for NFS/cross-filesystem transient errors)
          await moveWithRetries(videoDirectory, targetVideoDirectory, { retries: 5, delayMs: 500 });

          // Update paths to reflect final locations
          finalVideoPath = path.join(targetVideoDirectory, videoFileName);

          logger.info({ targetVideoDirectory }, '[Post-Process] Successfully moved to final location');
        }

        // Clean up empty parent directories in the temp path (e.g., empty channel folder)
        const tempBasePath = tempPathManager.getTempBasePath();
        // Series mode and STRM cache-on-play always move individual files out
        // of videoDirectory (never rename the whole directory away), same
        // shape as the flat file-by-file move, regardless of incoming layout.
        const parentDir = (strmCacheTargetDir || libraryMode === 'series' || (outgoingFlat && !isFlatMode))
          ? videoDirectory
          : (isFlatMode ? videoDirectory : path.dirname(videoDirectory));
        await cleanupEmptyParents(parentDir, tempBasePath);

        // Verify the final file exists
        if (!fs.existsSync(finalVideoPath)) {
          logger.error({ finalVideoPath }, '[Post-Process] Final video file doesn\'t exist after move');
          process.exit(1);
        }

        // NZB grabs: the raw thumbnail jpg yt-dlp wrote alongside the video
        // gets swept along with everything else matching this video's id
        // during the move above - remove it from the final location so only
        // the video file itself remains (see skipMediaSidecarFiles above).
        if (skipMediaSidecarFiles) {
          const finalImagePathForCleanup = path.join(
            path.dirname(finalVideoPath),
            path.parse(finalVideoPath).name + '.jpg'
          );
          if (fs.existsSync(finalImagePathForCleanup)) {
            try {
              fs.removeSync(finalImagePathForCleanup);
              logger.info({ finalImagePathForCleanup }, '[Post-Process] Removed thumbnail jpg for NZB grab (skipMediaSidecarFiles)');
            } catch (err) {
              logger.warn({ err, finalImagePathForCleanup }, '[Post-Process] Failed to remove thumbnail jpg for NZB grab');
            }
          }
        }

      } catch (error) {
        logger.error({
          error: error.message,
          code: error.code,
          syscall: error.syscall,
          src: videoDirectory,
          dest: targetVideoDirectory
        }, '[Post-Process] ERROR during move operation (all retries exhausted)');
        logger.error({ videoDirectory }, '[Post-Process] Files remain in temp location');
        // Log filesystem diagnostics to help debug NFS/permission issues
        // Use async stat with timeout to avoid hanging on stale NFS mounts
        try {
          const parentDir = path.dirname(targetVideoDirectory);
          const statPromise = require('fs').promises.stat(parentDir);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('stat timed out')), 5000)
          );
          const parentStats = await Promise.race([statPromise, timeoutPromise]);
          logger.error({
            parentDir,
            mode: parentStats.mode.toString(8),
            uid: parentStats.uid,
            gid: parentStats.gid
          }, '[Post-Process] Target parent directory permissions');
        } catch (diagErr) {
          logger.error({ diagErr: diagErr.message }, '[Post-Process] Could not read target parent directory stats');
        }
        process.exit(1);
      }
    }

    // Update the JSON file with the final path (after all moves are complete)
    // This ensures videoMetadataProcessor gets the correct location
    try {
      // Handle dual-format downloads (video_mp3 mode): track both video and audio paths
      if (isAudioFile && companionVideoPath) {
        // Calculate final path for companion video (same directory as the audio file)
        const finalCompanionVideoPath = path.join(
          path.dirname(finalVideoPath),
          path.basename(companionVideoPath)
        );

        // Store both paths for videoMetadataProcessor
        jsonData._actual_video_filepath = finalCompanionVideoPath;
        jsonData._actual_audio_filepath = finalVideoPath;
        // Keep _actual_filepath as video for backward compatibility
        jsonData._actual_filepath = finalCompanionVideoPath;

        logger.info({
          videoPath: finalCompanionVideoPath,
          audioPath: finalVideoPath
        }, '[Post-Process] Updated dual-format paths in JSON');
      } else if (isAudioFile) {
        // Audio-only download (mp3_only mode)
        jsonData._actual_audio_filepath = finalVideoPath;
        jsonData._actual_filepath = finalVideoPath;
        logger.info({ finalVideoPath }, '[Post-Process] Updated _actual_filepath in JSON (audio-only)');
      } else {
        // Standard video download
        jsonData._actual_video_filepath = finalVideoPath;
        jsonData._actual_filepath = finalVideoPath;
        logger.info({ finalVideoPath }, '[Post-Process] Updated _actual_filepath in JSON');
      }

      if (libraryMode === 'series' && seriesSeason != null) {
        jsonData.season = seriesSeason;
        jsonData.episode = seriesEpisode;
      }

      fs.writeFileSync(newJsonPath, JSON.stringify(jsonData, null, 2));
    } catch (jsonErr) {
      logger.error({ err: jsonErr }, '[Post-Process] Error updating JSON file with final path');
      // Don't fail the process, but log the error
    }

    // Create fanart.jpg in video folder if enabled (for Plex background image on compatible clients)
    // This complements the poster.jpg (which comes from channel thumbnail)
    if (shouldWriteVideoFanart()) {
      try {
        const videoDir = path.dirname(finalVideoPath);
        const videoBaseName = path.parse(finalVideoPath).name; // filename without extension
        const finalImagePath = path.join(videoDir, `${videoBaseName}.jpg`);
        const fanartPath = path.join(videoDir, `${videoBaseName}-fanart.jpg`);

        // Copy the video thumbnail as fanart (if the thumbnail exists in the final location and -fanart doesn't already exist)
        if (fs.existsSync(finalImagePath) && !fs.existsSync(fanartPath)) {
          copySyncWithFallback(finalImagePath, fanartPath);
          logger.info({ fanartPath }, '[Post-Process] Created video fanart file');
        } else {
          logger.debug({ finalImagePath }, '[Post-Process] No image copied for fanart creation');
        }
      } catch (err) {
        logger.warn({ err }, '[Post-Process] Error creating video fanart');
        // Don't fail the process, but log the warning
      }
    }

    // Create -backdrop.jpg beside the video if enabled (Emby/Jellyfin background art)
    if (shouldWriteBackdropImages()) {
      try {
        const videoDir = path.dirname(finalVideoPath);
        const videoBaseName = path.parse(finalVideoPath).name;
        const finalImagePath = path.join(videoDir, `${videoBaseName}.jpg`);
        const backdropPath = path.join(videoDir, `${videoBaseName}-backdrop.jpg`);

        if (fs.existsSync(finalImagePath) && !fs.existsSync(backdropPath)) {
          copySyncWithFallback(finalImagePath, backdropPath);
          logger.info({ backdropPath }, '[Post-Process] Created video backdrop file');
        } else {
          logger.debug({ finalImagePath }, '[Post-Process] No image copied for backdrop creation');
        }
      } catch (err) {
        logger.warn({ err }, '[Post-Process] Error creating video backdrop');
      }
    }

    // Copy channel thumbnail as poster.jpg to channel folder (must be done AFTER all moves)
    // Calculate the final channel folder path based on the final video path
    // In flat mode, the file is directly in the channel folder
    const finalChannelFolderPath = libraryMode === 'series'
      ? path.dirname(path.dirname(finalVideoPath)) // channelRoot/Season Y/file -> channelRoot
      : (outgoingFlat
        ? path.dirname(finalVideoPath)
        : path.dirname(path.dirname(finalVideoPath)));
    if (jsonData.channel_id) {
      await copyChannelPosterIfNeeded(jsonData.channel_id, finalChannelFolderPath);
      await copyChannelLogoIfNeeded(jsonData.channel_id, finalChannelFolderPath);
      await copyChannelBackdropIfNeeded(jsonData.channel_id, finalChannelFolderPath);
      await copyChannelBannerIfNeeded(jsonData.channel_id, finalChannelFolderPath);
    }

    // TV Series library mode: write/refresh tvshow.nfo and season.nfo.
    // Idempotent - safe to overwrite on every series-mode finalize.
    if (!skipMediaSidecarFiles && libraryMode === 'series' && seriesSeason != null) {
      const seasonFolderPath = path.dirname(finalVideoPath);
      const showTitle = (settingsChannelRecord && settingsChannelRecord.title) || jsonData.uploader || jsonData.channel || 'Unknown Channel';
      nfoGenerator.writeShowNfoFile(finalChannelFolderPath, { title: showTitle, plot: '', channelId: jsonData.channel_id });
      nfoGenerator.writeSeasonNfoFile(seasonFolderPath, { showTitle, season: seriesSeason });
      if (jsonData.channel_id) {
        await copySeasonPosterIfNeeded(jsonData.channel_id, seasonFolderPath);
        await copySeasonLogoIfNeeded(jsonData.channel_id, seasonFolderPath);
      }
    }

    // Save to the videos + channelvideos tables now so listing pages can show
    // this video mid-batch. The end-of-batch save still runs; a failure here
    // must not fail the download.
    if (activeJobId) {
      try {
        const persisted = await videoPersistence.persistDownloadedVideoForJob({ jobId: activeJobId, youtubeId: id });
        if (persisted) {
          // Control marker, not a log line: stdout flows through yt-dlp to
          // YtdlpOutputRouter, which broadcasts videosUpdated to the listing pages.
          process.stdout.write(`${VIDEO_PERSISTED_MARKER}${id}\n`);
        }
      } catch (err) {
        logger.error({ err, id }, 'Error persisting downloaded video during post-processing');
      }
    }

    // Mark this video as completed in the JobVideoDownload tracking table
    // IMPORTANT: Always use final path in database, never temp path
    if (activeJobId) {
      try {
        const [updatedCount] = await JobVideoDownload.update(
          { status: 'completed', file_path: finalVideoPath },
          {
            where: {
              job_id: activeJobId,
              youtube_id: id
            }
          }
        );
        if (updatedCount > 0) {
          logger.info({ id, activeJobId, finalVideoPath }, 'Marked video as completed in tracking');
        }
      } catch (err) {
        logger.error({ err, id }, 'Error updating JobVideoDownload status');
        // Don't fail the entire post-processing if this fails
      }
    } else {
      logger.warn({ id }, 'Job ID not available while marking video as completed; skipping tracking update');
    }
  }
})().catch(err => {
  logger.error({ err }, 'Error in post-processing');
  process.exit(1);
});

configModule.stopWatchingConfig();
