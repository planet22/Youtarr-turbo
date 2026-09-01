/**
 * server/routes/ytstream.js mode=hls-buffer: pure, stateless helpers shared
 * by the buffer-fetch process ytstream.js spawns and manages itself. The
 * actual yt-dlp/ffmpeg process orchestration (startHlsBufferFetch) lives in
 * ytstream.js, not here, because it needs the same closures spawnHlsEncodePass
 * already has - buildBaseArgs, getDashFormatSelectors,
 * registerChildProcess/killChildProcess, session.config - and duplicating
 * those as an injected-dependency surface just to move the spawn logic into
 * a separate file isn't worth it. This module only holds the two pieces that
 * genuinely don't need that closure:
 *
 *   - an in-flight guard so two HLS sessions for the same still-STRM video
 *     (different quality/transcode combos, or two devices) don't each start
 *     an independent buffer fetch of the same video
 *   - a parser for ffmpeg's `-progress` stdout, used to track how many
 *     seconds of video the buffer fetch has safely written so far (polled by
 *     ytstream.js's waitForBufferedThrough before every encode pass)
 */

// youtubeId -> true while a buffer fetch for that video is in flight. Purely
// in-memory, process-lifetime only (same precedent as strmCacheOnPlay.js's
// pendingEnqueue Set) - a server restart just means the next play starts a
// fresh fetch, no different than any other in-progress HLS session being lost.
const activeFetches = new Set();

function isBufferFetchActive(youtubeId) {
  return activeFetches.has(youtubeId);
}

function markBufferFetchStarted(youtubeId) {
  activeFetches.add(youtubeId);
}

function markBufferFetchFinished(youtubeId) {
  activeFetches.delete(youtubeId);
}

/**
 * Parses a chunk of ffmpeg `-progress` stdout (repeating key=value lines,
 * one full update block per output flush) for the most recent `out_time=`
 * timestamp. Deliberately not `out_time_ms`/`out_time_us` - both are
 * genuinely ambiguous across ffmpeg versions (a long-standing, never-fixed
 * naming inconsistency where "_ms" has actually meant microseconds on some
 * builds), while `out_time`'s HH:MM:SS.ffffff formatted string has no such
 * ambiguity.
 * @param {string} chunk
 * @returns {number|null} seconds, or null if this chunk had no out_time line
 */
function parseBufferedSeconds(chunk) {
  const matches = String(chunk).match(/out_time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/g);
  if (!matches || !matches.length) return null;
  const m = matches[matches.length - 1].match(/out_time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

module.exports = {
  isBufferFetchActive,
  markBufferFetchStarted,
  markBufferFetchFinished,
  parseBufferedSeconds,
};
