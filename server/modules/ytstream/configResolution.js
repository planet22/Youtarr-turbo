/**
 * server/modules/ytstream/configResolution.js
 *
 * Mode/field validity tables and mode-compatibility resolution shared
 * across ytstream's playback modes - extracted from
 * server/routes/ytstream.js so they're a real importable module instead of
 * trapped in that file's private route-factory closure.
 */

const VALID_MODES = ['direct', 'direct-redirect', 'hls', 'hls-buffer'];
// mkv is ffmpeg-mode only; HLS segments must be fmp4/mpegts, so
// getHlsContainerInfo falls through to its fmp4 default for 'mkv' too.
const VALID_CONTAINERS = ['mp4', 'ts', 'mkv'];
const VALID_TRANSCODE = ['copy', 'h264'];

/**
 * Default yt-dlp player-client selection. The bare "tv" client frequently
 * returns YouTube's generic "The page needs to be reloaded." error once a
 * session/PO-token check fails, even when other clients would work; `-tv`
 * drops just that client while keeping normal multi-client fallback.
 */
const DEFAULT_PLAYER_CLIENT = 'default,-tv';

/**
 * Fallback client used for the single automatic retry when the first
 * attempt fails with a signature matching a client/session rejection.
 * "android" doesn't require the web session tokens that trip up "tv".
 */
const RETRY_PLAYER_CLIENT = 'android';

/**
 * Matches yt-dlp/YouTube errors that are usually fixed by switching
 * player client rather than being a real "video unavailable" — safe to
 * retry once with a different client.
 */
const RETRYABLE_ERROR_PATTERN =
  /page needs to be reloaded|sign in to confirm|not a bot|failed to extract any player response|unable to extract .*player/i;

function isRetryableExtractionError(message = '') {
  return RETRYABLE_ERROR_PATTERN.test(String(message));
}

function parseBooleanQueryFlag(raw) {
  if (raw === true) return true;
  const firstToken = String(raw ?? '').split('|', 1)[0];
  return /^(1|true|yes)$/i.test(firstToken);
}

/**
 * Single source of truth for the forceServerSettings-aware query-override
 * precedence rule used throughout ytstream's playback-mode/field
 * resolution: when forceServerSettings is on, every per-request query
 * param is ignored in favor of the live server config; otherwise the query
 * param wins when present. Returns a bound `(name) => value|undefined`
 * accessor, matching the shape every call site already hand-wrote this
 * exact one-liner as. Consolidating it here means the precedence rule can
 * never drift between resolvePlaybackPlan, evaluateProbeShortcut, and the
 * cheap warm-up mirror in the main route handler - previously three
 * independent copies of the same logic, the exact duplication pattern
 * responsible for a past production bug (a corrupted calculatedLength
 * query value silently evaluating differently in one copy than another).
 * @param {import('express').Request} req
 * @param {{forceServerSettings?: boolean}|undefined} ytCfg - the live
 *   `config.ytstream` object (or an already-scoped equivalent).
 * @returns {(name: string) => any}
 */
function createQueryOverrideResolver(req, ytCfg) {
  const forced = (ytCfg || {}).forceServerSettings === true;
  return (name) => (forced ? undefined : req.query[name]);
}

/**
 * Single source of truth for which ytstream config fields are
 * required/ignored/optional for a given mode+transcode combination -
 * drives the Configuration UI's chips, the /simulate dry-run narrative,
 * and the actual enforcement in resolvePlaybackPlan, so all three can
 * never drift apart from each other (they used to, independently,
 * before this consolidation).
 */
function getModeFieldCompatibility({ mode, transcode }) {
  const isHlsFamily = mode === 'hls' || mode === 'hls-buffer';
  const forceH264 = transcode === 'h264';
  const fields = {};

  fields.calculatedLength = isHlsFamily
    ? {
      status: 'forced',
      reason: `${mode} builds a real .m3u8 playlist - without this, a player sees ffmpeg's own raw growing playlist instead of a pre-declared exact-duration one, and can "join near the live edge" on reconnect (a real forward jump, displayed position stuck behind it), regardless of how this setting is configured.`,
    }
    : (mode === 'direct' || mode === 'direct-redirect')
      ? {
        status: 'ignored',
        reason: `${mode} mode uses the stream's own real length (whatever the upstream/player's own fetch reports), not an estimate.`,
      }
      : {
        status: 'optional',
        reason: 'A genuine trade-off: reports an estimated size/duration upfront and answers seeks faster (but only approximately) by restarting at the estimated timestamp.',
      };

  fields.probeShortcut = !isHlsFamily
    ? {
      status: 'ignored',
      reason: 'This mode never transcodes, so the cached probe-shortcut clip (always H.264) could never stand in for its real output codec/container.',
    }
    : !forceH264
      ? {
        status: 'ignored',
        reason: 'Only applies when Transcode is set to Force re-encode (H.264/AAC) - the cached probe-shortcut clip is always H.264, so it can only stand in for a real response that would also be H.264.',
      }
      : {
        status: 'optional',
        reason: 'Skips a real yt-dlp/ffmpeg session for a detected metadata probe, serving a tiny cached clip in the right codec instead.',
      };

  const encodeFieldsIgnoredReason = 'This mode never runs an ffmpeg encode - there\'s nothing here for Container/Transcode/Hardware encoder/Encoding tuning to apply to.';
  fields.container = !isHlsFamily
    ? { status: 'ignored', reason: encodeFieldsIgnoredReason }
    : { status: 'optional' };
  fields.transcode = !isHlsFamily
    ? { status: 'ignored', reason: encodeFieldsIgnoredReason }
    : { status: 'optional' };

  const hwIgnoredReason = !isHlsFamily
    ? encodeFieldsIgnoredReason
    : 'Only applies when Transcode is set to Force re-encode (H.264/AAC) - Copy (or Auto resolving to copy) never touches an encoder at all.';
  fields.hardwareMode = (!isHlsFamily || !forceH264)
    ? { status: 'ignored', reason: hwIgnoredReason }
    : { status: 'optional' };
  fields.tuning = (!isHlsFamily || !forceH264)
    ? { status: 'ignored', reason: hwIgnoredReason }
    : { status: 'optional' };

  fields.hotSwapToCache = mode === 'hls'
    ? {
      status: 'optional',
      reason: 'Hot-swaps a live HLS session onto a finished STRM cache-on-play download once it completes, without restarting playback.',
    }
    : {
      status: 'ignored',
      reason: mode === 'hls-buffer'
        ? 'This mode replaces hot-swap-to-cache entirely with its own buffer finalize mechanism - there\'s nothing session-swap-shaped for it to do here.'
        : 'Only mode=hls (plain Enhanced HLS, not currently offered in the Playback mode dropdown - hls-buffer replaces it there) has a live HLS session to hot-swap onto a finished download.',
    };

  // Mirrors the exact bufferWillAttempt condition the real cache-on-play
  // trigger checks (see maybeEnqueueCacheDownload's call site) - hls-buffer's
  // own independent fetch already produces the same permanent file
  // cache-on-play would, unconditionally, so the STRM background download
  // is always skipped for it.
  fields.cacheOnPlay = mode === 'hls-buffer'
    ? {
      status: 'ignored',
      reason: 'Enhanced HLS + Buffered\'s own fetch always finalizes into the same permanent file cache-on-play would have downloaded - the STRM background download is always skipped for this mode, regardless of this setting.',
    }
    : {
      status: 'optional',
      reason: 'Enqueues a real background download of this video on play, so later plays use the cached file instead of live-proxying it again.',
    };

  // Only hls/hls-buffer produce real numbered segment files at all
  // (see SEGMENT_STATUS_MODES) - a forward seek in any of them can strand
  // segments between the old and new encode-pass targets, permanently
  // un-encoded. Genuinely "optional" rather than depending on more of this
  // session's state (a local source only shows up later, from STRM
  // cache-on-play's hot-swap or hls-buffer's own fetch) - when no local
  // source ever appears, this just never has anything to do, same as
  // disabled.
  fields.backfillMissingSegments = isHlsFamily
    ? {
      status: 'optional',
      reason: 'Once the live encode reaches the end of the video, fills in any segments a forward seek skipped over - using a local source only (STRM cache-on-play\'s hot-swap, or this mode\'s own buffer fetch), never a fresh network pull. No effect if no local source ever became available this session.',
    }
    : {
      status: 'ignored',
      reason: 'Only hls/hls-buffer write real numbered segment files that could ever have a gap to fill.',
    };

  // Only hls-buffer finalizes a .ts (its whole mechanism is a plain -c copy
  // MPEG-TS remux) - every other mode either never finalizes a permanent
  // file, or finalizes something already in a directly-playable container.
  fields.finalizeToMp4 = mode === 'hls-buffer'
    ? {
      status: 'optional',
      reason: 'Enhanced HLS + Buffered always finalizes as a .ts file - once complete, remux it (no re-encode) into a sibling .mp4 that plays natively and doesn\'t need Jellyfin (or any other player) to transcode it server-side.',
    }
    : {
      status: 'ignored',
      reason: 'This mode never finalizes a permanent .ts file to convert.',
    };

  // Only hls-buffer ever writes a genuinely permanent file at all - every
  // other mode has nothing to keep hidden from a media server's library scan.
  fields.stealthCache = mode === 'hls-buffer'
    ? {
      status: 'optional',
      reason: 'Keeps the buffered file out of the library folder entirely, in Youtarr\'s own hidden cache instead - the .strm is never touched, so Jellyfin (or any other media server) always keeps resolving playback through Youtarr instead of ever indexing a real file directly.',
    }
    : {
      status: 'ignored',
      reason: 'This mode never finalizes a permanent file that could be kept hidden.',
    };

  return fields;
}

module.exports = {
  VALID_MODES,
  VALID_CONTAINERS,
  VALID_TRANSCODE,
  DEFAULT_PLAYER_CLIENT,
  RETRY_PLAYER_CLIENT,
  RETRYABLE_ERROR_PATTERN,
  isRetryableExtractionError,
  parseBooleanQueryFlag,
  createQueryOverrideResolver,
  getModeFieldCompatibility,
};
