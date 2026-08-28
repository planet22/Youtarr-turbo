/**
 * Shared between strmGenerator.js (writer) and routes/ytstream.js (reader)
 * for the `ytstream.probeShortcut` feature. A single source of truth so the
 * two can never drift apart - see either file's doc comments for the full
 * mechanism (it exploits jellyfin/jellyfin#10175: ffprobe ignores a .strm's
 * custom User-Agent override, while real ffmpeg playback/transcode honors
 * it, giving a reliable "is this a metadata probe?" signal).
 */
const PROBE_SHORTCUT_USER_AGENT = 'Youtarr-Playback/1.0';

module.exports = { PROBE_SHORTCUT_USER_AGENT };
