const { execFile } = require('child_process');
const logger = require('../logger');

/**
 * Measures a video file's actual pixel dimensions via ffprobe (ships in the
 * image alongside ffmpeg). The raw "WIDTHxHEIGHT" string is what gets stored
 * on Videos.video_resolution; interpreting dimensions into a display tier
 * (e.g. "1080p") is deliberately display logic and lives client-side in
 * client/src/utils/videoResolution.ts, so labeling rules can change without
 * re-probing the library.
 *
 * Also home to format_note parsing, which videoMetadataModule uses for the
 * detail modal's available-resolutions list.
 */

const FFPROBE_TIMEOUT_MS = 15000;

// YouTube's transcode ladder; mirrors TIER_LADDER in
// client/src/utils/videoResolution.ts.
const TIER_LADDER = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];

/**
 * Selection class for a vertical format's pixel height: the smallest ladder
 * rung >= height, i.e. the minimum height-capped yt-dlp selector that would
 * download the format. Mirrors the vertical branch of tierFromDimensions in
 * client/src/utils/videoResolution.ts so the modal's available-resolutions
 * list lines up with the tier labels shown elsewhere in the app.
 */
function selectionTierForHeight(height) {
  if (!Number.isFinite(height) || height <= 0) return null;
  for (const tier of TIER_LADDER) {
    if (tier >= height) return tier;
  }
  return TIER_LADDER[TIER_LADDER.length - 1];
}

/**
 * Parse a tier from a yt-dlp format_note string.
 * "1080p" -> 1080, "1080p60" -> 1080, "1080p+medium" -> 1080, else null.
 */
function parseTierFromFormatNote(formatNote) {
  if (!formatNote || typeof formatNote !== 'string') return null;
  const match = formatNote.match(/^(\d+)p/);
  return match ? parseInt(match[1], 10) : null;
}

// Subset of TIER_LADDER actually surfaced as an "available resolution" -
// 144p/240p are excluded as too low to be a meaningful selectable tier.
const SUPPORTED_HEIGHTS = [360, 480, 720, 1080, 1440, 2160, 4320];

/**
 * Extracts the distinct selectable resolution tiers a yt-dlp format list
 * (jsonData.formats, from --write-info-json / --dump-single-json) reports
 * as available for a video - shared by videoMetadataModule.js (the video
 * detail modal's available-resolutions list) and nfoGenerator.js (the
 * Jellyfin-facing "Available: ..." tag), so both surfaces agree on the
 * same numbers instead of each computing their own.
 *
 * Landscape: prefers format_note (e.g. "1080p") over raw height because for
 * non-16:9 aspect ratios the actual pixel height differs from the quality
 * tier label (e.g. a 2:1 video's "1080p" format has 960 actual height, not
 * 1080). Falls back to height when format_note isn't present or parseable.
 *
 * Vertical (height > width): uses the selection class (smallest ladder rung
 * >= pixel height) instead of format_note, because YouTube labels vertical
 * formats by short edge (a 1080x1920 short's format_note is "1080p") while
 * the app labels downloads by selection class (1080x1920 -> 2160p). Without
 * this, a top-of-ladder vertical download's tier would be missing from the
 * list.
 *
 * @param {Array<object>} formats - jsonData.formats
 * @returns {number[]|null} ascending tiers, or null if none found
 */
function extractAvailableResolutionTiers(formats) {
  if (!Array.isArray(formats) || formats.length === 0) return null;

  const availableTiers = new Set();

  for (const fmt of formats) {
    if (!fmt.vcodec || fmt.vcodec === 'none') continue;

    let tier;
    if (fmt.height && fmt.width && fmt.height > fmt.width) {
      tier = selectionTierForHeight(fmt.height);
    } else {
      tier = parseTierFromFormatNote(fmt.format_note);
      if (tier === null && fmt.height) {
        tier = fmt.height;
      }
    }

    if (tier !== null && SUPPORTED_HEIGHTS.includes(tier)) {
      availableTiers.add(tier);
    }
  }

  if (availableTiers.size === 0) return null;

  return [...availableTiers].sort((a, b) => a - b);
}

/**
 * Probe a media file's first video stream with ffprobe and return its pixel
 * dimensions as a "WIDTHxHEIGHT" string (e.g. "1920x1080"). Resolves null
 * when the probe fails or yields no usable dimensions; never rejects.
 */
function probeVideoDimensions(videoFilePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        videoFilePath
      ],
      { timeout: FFPROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          logger.debug({ err, videoFilePath }, 'ffprobe resolution probe failed');
          return resolve(null);
        }
        const [width, height] = String(stdout).trim().split(',').map((v) => parseInt(v, 10));
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          return resolve(null);
        }
        resolve(`${width}x${height}`);
      }
    );
  });
}

/**
 * Probe a media file's duration with ffprobe, in seconds. Used to turn
 * ffmpeg's own `-progress` output (which reports elapsed *encoded* time,
 * not a percentage) into a percent/ETA during the post-download transcode
 * (see transcodeDownloadedVideo in videoDownloadPostProcessFiles.js).
 * Resolves null when the probe fails or yields no usable duration; never
 * rejects.
 */
function probeVideoDuration(videoFilePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        videoFilePath
      ],
      { timeout: FFPROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          logger.debug({ err, videoFilePath }, 'ffprobe duration probe failed');
          return resolve(null);
        }
        const seconds = parseFloat(String(stdout).trim());
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return resolve(null);
        }
        resolve(seconds);
      }
    );
  });
}

module.exports = {
  parseTierFromFormatNote,
  probeVideoDimensions,
  probeVideoDuration,
  selectionTierForHeight,
  extractAvailableResolutionTiers,
};
