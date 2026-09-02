/**
 * server/routes/ytstream.js mode=raw-buffer: in-memory registry of in-flight
 * raw downloads, keyed by youtubeId.
 *
 * Unlike mode=hls-buffer's own fetch guard (ytstreamBufferFetch.js's
 * isBufferFetchActive/markBufferFetchStarted/markBufferFetchFinished, a bare
 * Set<youtubeId> - "already active" just means "this session gives up and
 * falls back to its own network path"), mode=raw-buffer has no live-encode
 * fallback to fall back to: a second concurrent request for the same
 * still-downloading video must attach to and poll the SAME fetch instead of
 * starting a duplicate or failing outright. That requires storing the actual
 * entry (temp/final paths, size estimate, status), not just a boolean - hence
 * a separate, dedicated registry rather than reusing/extending
 * ytstreamBufferFetch.js's Set.
 *
 * Deliberately NOT cross-checked against ytstreamBufferFetch.js's own guard:
 * if a user somehow triggers mode=hls-buffer and mode=raw-buffer for the same
 * not-yet-cached video at the same moment, both fetches run independently
 * (wasteful, not broken) rather than this module reaching into that one's
 * internals.
 */

const rawFetches = new Map(); // youtubeId -> entry

/**
 * @param {string} youtubeId
 * @returns {object|null} the in-flight entry for this video, or null if none
 */
function getRawBufferFetch(youtubeId) {
  return rawFetches.get(youtubeId) || null;
}

/**
 * @param {string} youtubeId
 * @param {object} entry
 */
function registerRawBufferFetch(youtubeId, entry) {
  rawFetches.set(youtubeId, entry);
}

/**
 * @param {string} youtubeId
 */
function clearRawBufferFetch(youtubeId) {
  rawFetches.delete(youtubeId);
}

module.exports = { getRawBufferFetch, registerRawBufferFetch, clearRawBufferFetch };
