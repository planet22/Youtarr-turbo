/**
 * server/modules/ytstream/debugPlaylistCopy.js
 *
 * ytstream.debugLogging (the same flag streamDebug.js gates its high-volume
 * lines behind): when on, also saves a copy of every playlist ytstream
 * serves - the outer master playlist (BANDWIDTH/CODECS) and the underlying
 * media playlist (segment list/EXTINF) - to a video-name-prefixed file under
 * YTSTREAM_CACHE_DIR/debug-playlists/. The real on-disk HLS session
 * directories are named by an opaque sessionKey hash and get cleaned up
 * automatically, which makes them hard to find or keep around for a
 * specific video while live-debugging a playback issue (e.g. checking the
 * declared BANDWIDTH/CODECS a client rejected Direct Play for).
 */
const fs = require('fs');
const path = require('path');
const configModule = require('../configModule');
const logger = require('../../logger');
const { sanitizeNameLikeYtDlp } = require('../filesystem/sanitizer');
const { YTSTREAM_CACHE_DIR } = require('./paths');
const youtubeMetadataCache = require('../youtubeMetadataCache');

const DEBUG_PLAYLISTS_DIR = path.join(YTSTREAM_CACHE_DIR, 'debug-playlists');

/**
 * @param {object} params
 * @param {string} params.youtubeId
 * @param {'master'|'media'} params.kind
 * @param {string} params.content
 */
async function maybeSaveDebugPlaylistCopy({ youtubeId, kind, content }) {
  if ((configModule.getConfig().ytstream || {}).debugLogging !== true) return;
  try {
    const titles = await youtubeMetadataCache.getCachedTitles([youtubeId]);
    const title = titles[youtubeId] || youtubeId;
    const filename = `${sanitizeNameLikeYtDlp(title)} [${youtubeId}] ${kind}.m3u8`;
    fs.mkdirSync(DEBUG_PLAYLISTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_PLAYLISTS_DIR, filename), content);
  } catch (err) {
    logger.warn({ err, youtubeId, kind }, 'ytstream: failed to save debug playlist copy');
  }
}

module.exports = { maybeSaveDebugPlaylistCopy, DEBUG_PLAYLISTS_DIR };
