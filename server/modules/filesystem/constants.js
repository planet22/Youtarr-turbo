/**
 * Shared constants for file and path operations
 * Single source of truth for all path-related constants
 */

/**
 * Prefix added to subfolder names for namespace safety
 * Subfolders are stored without this prefix in the database
 * but always have it when on the filesystem
 */
const SUBFOLDER_PREFIX = '__';

/**
 * Sentinel value for explicitly specifying "use global default subfolder"
 * This distinguishes from NULL which means "download to root" (backwards compatible)
 */
const GLOBAL_DEFAULT_SENTINEL = '##USE_GLOBAL_DEFAULT##';

/**
 * Sentinel value for explicitly specifying "download to root directory"
 * Used in manual downloads to override channel subfolder settings and download directly to root
 */
const ROOT_SENTINEL = '##ROOT##';

/**
 * Default video file extensions in priority order
 * Used when searching for video files with unknown extensions
 */
// const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.m4v', '.avi'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.m4v', '.avi', '.strm'];
/**
 * Audio file extensions for MP3 downloads
 */
const AUDIO_EXTENSIONS = ['.mp3'];

/**
 * All media file extensions (video + audio)
 * Used when searching for any downloaded media
 */
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS];

/**
 * yt-dlp output template for channel folder name
 * Uses uploader with fallback to channel, then uploader_id
 * Truncated to 80 bytes max to avoid filesystem path length issues with UTF-8 characters
 */
const CHANNEL_TEMPLATE = '%(uploader,channel,uploader_id).80B';

/**
 * Default prefix for the user-customizable video filename template.
 * Composed with VIDEO_FILENAME_SUFFIX to produce the full yt-dlp -o template.
 * The title is capped at 64 bytes: the prefix appears twice in the full path
 * (per-video folder + filename), and Plex on Windows silently skips any file
 * whose full path reaches 260 chars. Installs that saved the setting keep
 * their persisted prefix; this default only applies until they touch it.
 */
const DEFAULT_VIDEO_FILENAME_PREFIX = `${CHANNEL_TEMPLATE} - %(title).64B`;

/**
 * Locked suffix appended to every user-customized video filename.
 * Required for Youtarr's file-to-DB matching (see YOUTUBE_ID_BRACKET_PATTERN).
 */
const VIDEO_FILENAME_SUFFIX = '[%(id)s].%(ext)s';

/**
 * Normalize a user-supplied filename prefix: fall back to the default when
 * null/undefined, then strip trailing whitespace. Shared by the three
 * filename composers below.
 */
function normalizePrefix(prefix) {
  const effective = prefix == null ? DEFAULT_VIDEO_FILENAME_PREFIX : prefix;
  return effective.replace(/\s+$/, '');
}

/**
 * Compose the full yt-dlp video file template from a user-supplied prefix.
 * Inserts a single space between non-empty prefix and suffix; emits suffix
 * alone when the prefix is empty/whitespace as defensive fallback behavior.
 * User-facing config validation rejects empty prefixes. Null/undefined falls
 * back to the default prefix so callers without config still produce a valid template.
 */
function composeVideoFileTemplate(prefix) {
  const trimmed = normalizePrefix(prefix);
  return trimmed.length === 0
    ? VIDEO_FILENAME_SUFFIX
    : `${trimmed} ${VIDEO_FILENAME_SUFFIX}`;
}

/**
 * Compose the thumbnail filename template (no extension; yt-dlp adds .jpg via
 * --convert-thumbnails). Mirrors the video file template so the post-processor
 * can pair thumbnail + video by stem.
 */
function composeThumbnailFilename(prefix) {
  const trimmed = normalizePrefix(prefix);
  return trimmed.length === 0 ? '[%(id)s]' : `${trimmed} [%(id)s]`;
}

/**
 * Compose the per-video directory name from a user-supplied prefix.
 * Non-empty prefixes get " - %(id)s"; empty prefixes use "%(id)s" alone.
 * User-facing config validation rejects empty prefixes, so the empty form is
 * defensive fallback behavior for older/hand-edited configs.
 * The non-empty form matches YOUTUBE_ID_DASH_PATTERN for directory ID extraction.
 * Same composition rules as composeVideoFileTemplate.
 */
function composeVideoFolderName(prefix) {
  const trimmed = normalizePrefix(prefix);
  return trimmed.length === 0 ? '%(id)s' : `${trimmed} - %(id)s`;
}

/**
 * Pattern to extract YouTube video ID from filename
 * Matches [VideoID] where VideoID is 10-12 alphanumeric characters (including - and _)
 */
const YOUTUBE_ID_BRACKET_PATTERN = /\[([a-zA-Z0-9_-]{10,12})\]/;

/**
 * Pattern to extract YouTube video ID from directory name
 * Matches " - VideoID" at the end of directory name
 */
const YOUTUBE_ID_DASH_PATTERN = / - ([a-zA-Z0-9_-]{10,12})$/;

/**
 * Pattern to validate a YouTube video ID string
 */
const YOUTUBE_ID_PATTERN = /^[a-zA-Z0-9_-]{10,12}$/;

/**
 * Pattern to identify main video files (not fragments)
 * Matches [VideoID].mp4/mkv/webm but NOT .fXXX.mp4
 */
const MAIN_VIDEO_FILE_PATTERN = /\[[a-zA-Z0-9_-]{10,12}\]\.(mp4|mkv|webm)$/;

/**
 * Pattern to identify video fragment files (to exclude)
 */
const FRAGMENT_FILE_PATTERN = /\.f[\d-]+\.(mp4|m4a|webm|mkv)$/;

/**
 * Files that can be ignored when deciding whether a channel directory is empty
 * If a channel directory contains ONLY these files (and no actual video content),
 * it is considered "effectively empty" and eligible for cleanup
 */
const CHANNEL_CLEANUP_IGNORABLE_FILES = [
  'poster.jpg',
  'poster.png',
  'poster.jpeg',
  'backdrop.jpg',
  'banner.jpg',
  'logo.jpg',
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
];

/**
 * Channel .m3u playlist files (e.g., "Channel Name.m3u") are derived,
 * regenerable metadata. Their presence must not keep an otherwise-empty
 * channel directory alive after its videos are deleted. Also matches a
 * ".m3u.tmp" staging file stranded by a crash mid-write.
 */
const M3U_FILE_PATTERN = /\.m3u(\.tmp)?$/i;

/**
 * AppleDouble metadata files written by macOS SMB clients (e.g., "._video.mp4").
 * These are sidecar metadata for an underlying file; once the underlying file
 * is gone, the sidecar is orphaned junk and safe to remove. Mac SMB also tends
 * to write these into a directory in response to other operations, which can
 * race with rmdir and cause spurious ENOTEMPTY (issue #370).
 */
const APPLEDOUBLE_FILE_PATTERN = /^\._/;

/**
 * Folder-name prefix for TV Series library mode season folders
 * (e.g. "Season 2024"). This literal string is what Jellyfin/Kodi's season
 * folder parser recognizes; it is intentionally not user-configurable.
 */
const SEASON_FOLDER_PREFIX = 'Season ';

/**
 * Compose a TV Series library mode season folder name from a season number
 * (the calendar year of the video's upload_date).
 * @param {number} year
 * @returns {string}
 */
function composeSeasonFolderName(year) {
  return `${SEASON_FOLDER_PREFIX}${year}`;
}

/**
 * Default episode filename template for TV Series library mode.
 * Evaluated by Youtarr itself at finalize time (not by yt-dlp), since
 * season/episode aren't known until after the DB lookup - see
 * formatEpisodeTemplate. The [id].ext suffix is appended automatically by
 * composeEpisodeFileTemplate and is not part of this user-editable prefix.
 * Season is zero-padded to 2 digits (%(season)02d) same as episode - a
 * no-op for the upload-year-as-season default (always 4 digits already),
 * but matters once a channel's Season/Episode Decoding regex resolves a
 * real, potentially single-digit season number (e.g. 6, not 2026).
 */
const DEFAULT_EPISODE_FILENAME_PREFIX = 'S%(season)02dE%(episode)03d - %(title).64s';

/**
 * Matches Youtarr's own episode-template placeholder syntax:
 *   %(name)s          - string field
 *   %(name).Ns         - string field, truncated to N chars
 *   %(name)0Nd         - integer field, zero-padded to N digits
 * Supported names: title, season, episode, id, channel.
 * This is a distinct, smaller syntax from yt-dlp's own %(...)  output
 * template fields (used by composeVideoFileTemplate) - it is parsed here,
 * not passed through to yt-dlp, because season/episode are resolved by
 * Youtarr after the video's DB record exists.
 */
const EPISODE_TEMPLATE_TOKEN = /%\((\w+)\)(?:\.(\d+))?(0\d+)?([sd])/g;

/**
 * Substitute placeholders in a user-supplied episode filename template.
 * Unknown/missing fields resolve to an empty string.
 * @param {string} template
 * @param {{title?: string, season?: number|string, episode?: number|string, id?: string, channel?: string}} values
 * @returns {string}
 */
function formatEpisodeTemplate(template, values) {
  return String(template).replace(EPISODE_TEMPLATE_TOKEN, (match, key, truncate, pad, kind) => {
    const raw = values[key];
    if (raw === undefined || raw === null) return '';
    if (kind === 'd') {
      const width = pad ? pad.length : 0;
      return String(raw).padStart(width, '0');
    }
    const str = String(raw);
    return truncate ? str.slice(0, parseInt(truncate, 10)) : str;
  });
}

/**
 * Compose the full episode filename (stem + locked suffix) for TV Series
 * library mode. Mirrors composeVideoFileTemplate's role for movie mode:
 * the trailing " [id].ext" is always appended and is not user-editable,
 * since YOUTUBE_ID_BRACKET_PATTERN / extractYoutubeIdFromPath depend on it
 * for file-to-DB matching.
 * @param {string|null} prefix - User-supplied episode template, or null to use the default.
 * @param {{title?: string, season?: number, episode?: number, id: string, channel?: string, ext: string}} values
 * @returns {string}
 */
function composeEpisodeFileTemplate(prefix, values) {
  const effective = prefix == null ? DEFAULT_EPISODE_FILENAME_PREFIX : prefix;
  const stem = formatEpisodeTemplate(effective, values).replace(/\s+$/, '');
  const base = stem.length === 0 ? String(values.id) : stem;
  return `${base} [${values.id}].${values.ext}`;
}

module.exports = {
  SUBFOLDER_PREFIX,
  GLOBAL_DEFAULT_SENTINEL,
  ROOT_SENTINEL,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  CHANNEL_TEMPLATE,
  DEFAULT_VIDEO_FILENAME_PREFIX,
  VIDEO_FILENAME_SUFFIX,
  composeVideoFileTemplate,
  composeThumbnailFilename,
  composeVideoFolderName,
  YOUTUBE_ID_BRACKET_PATTERN,
  YOUTUBE_ID_DASH_PATTERN,
  YOUTUBE_ID_PATTERN,
  MAIN_VIDEO_FILE_PATTERN,
  FRAGMENT_FILE_PATTERN,
  CHANNEL_CLEANUP_IGNORABLE_FILES,
  M3U_FILE_PATTERN,
  APPLEDOUBLE_FILE_PATTERN,
  SEASON_FOLDER_PREFIX,
  composeSeasonFolderName,
  DEFAULT_EPISODE_FILENAME_PREFIX,
  formatEpisodeTemplate,
  composeEpisodeFileTemplate
};
