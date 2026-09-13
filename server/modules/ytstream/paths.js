/**
 * server/modules/ytstream/paths.js
 *
 * Shared on-disk cache locations for ytstream's playback modes. Split out
 * on its own because these constants fan out across several concerns
 * (untracked-buffer-cache CRUD, probe-clip cache, the HLS session engine's
 * own base-dir resolution) that are otherwise being split into separate
 * modules - keeping the paths here avoids re-deriving them independently
 * in each one.
 */
const path = require('path');
const configModule = require('../configModule');

// Lives under configModule.directoryPath (the library volume), NOT the
// config volume — same precedent as nzb.js's .nzb_staging — since these
// caches (especially the untracked-buffer cache, a full copy of a video)
// belong on the volume sized for bulk media. NOT HLS_BASE_TEMP_DIR's local
// /tmp either: unlike these write-once caches, live per-session HLS segment
// dirs are written continuously for a stream's whole life, and routing that
// through NAS-backed storage instead of fast local disk regressed segment
// production from far-faster-than-realtime to barely realtime (see
// mode=hls-buffer's bufferTempPath doc). And NOT tempPathManager's '.youtarr_tmp'
// subfolder: that gets wiped wholesale by cleanTempDirectory() on startup
// and before every download job, which was silently deleting this cache's
// persistent contents each time a job ran in the background.
const YTSTREAM_CACHE_DIR = path.join(configModule.directoryPath, '.youtarr_ytstream_cache');
const YTSTREAM_CLIPS_DIR = path.join(YTSTREAM_CACHE_DIR, 'ytstream-clips');

// mode=hls-buffer against a video with no `Video` row (untracked NZB
// `strm` grab, or later disowned via `importStrategy:'untracked'` — see
// bufferEnabled in createHlsSessionInternal) still gets buffer-fetched, but
// lands HERE keyed by youtubeId instead of a library location — no Video/Job
// row, invisible in the library/Download History, purely a same-video
// speed-up. Persistent so a later replay (even post-restart) can reuse it.
//
// Also reused (deliberately - same dir, same finalize semantics) by
// ytstream.stealthCache and finalizeToMp4 for a genuinely TRACKED, still-STRM
// video's hls-buffer fetch — see bufferEnabled's tracked-video branch in
// createHlsSessionInternal. Keeping the .ts here instead of the library
// folder is what keeps it invisible to Jellyfin's own scanner; the Video row
// stays untouched (finalizeTapOutput runs with skipVideoUpsert:true, same as
// the untracked case) for as long as the file lives here.
const HLS_UNTRACKED_BUFFER_CACHE_DIR = path.join(YTSTREAM_CLIPS_DIR, 'hls-buffer-untracked-cache');

module.exports = {
  YTSTREAM_CACHE_DIR,
  YTSTREAM_CLIPS_DIR,
  HLS_UNTRACKED_BUFFER_CACHE_DIR,
};
