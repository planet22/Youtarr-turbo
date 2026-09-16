/**
 * server/modules/ytstream/playbackPlan.js
 *
 * Duration/codec/height resolution shared across ytstream's playback
 * modes - `ytstream.calculatedLength`'s duration lookup, `transcode=copy`'s
 * auto-upgrade-to-h264 codec check, and quality auto-capping to a video's
 * real best-available height - plus `resolvePlaybackPlan`, the mode/
 * quality/transcode resolution engine shared by the real playback route
 * and the `/simulate` dry-run (moved in later, once its own dependencies -
 * all pure/already-extracted - made this a safe, self-contained transplant
 * with zero coupling to the HLS session engine). Extracted from
 * server/routes/ytstream.js so it's a real importable module instead of
 * trapped in that file's private route-factory closure.
 *
 * Singleton state (see activeStreams.js's doc comment for the full
 * rationale - this module is only evaluated once per process, so the
 * caches here stay real singletons across every createYtStreamRoutes call,
 * same as they were as plain module-level state before this extraction).
 * `models` is injected via `init()` since it's only known once
 * createYtStreamRoutes actually runs.
 */
const logger = require('../../logger');
const ytDlpRunner = require('../ytDlpRunner');
const youtubeMetadataCache = require('../youtubeMetadataCache');
const streamEncoderTuning = require('../streamEncoderTuning');
const { normalizeHardwareMode, normalizeTuning } = streamEncoderTuning;
const { buildBaseArgs } = require('./ytdlpArgs');
const { resolveQualityHeight, getDashFormatSelectors, isH264Codec } = require('./formatSelection');
const {
  VALID_MODES,
  VALID_CONTAINERS,
  VALID_TRANSCODE,
  DEFAULT_PLAYER_CLIENT,
  parseBooleanQueryFlag,
  createQueryOverrideResolver,
  getModeFieldCompatibility,
} = require('./configResolution');
const { isFfmpegAvailable } = require('./processRegistry');
const { evaluateProbeShortcut } = require('./probeShortcut');
const { streamDebug } = require('./streamDebug');

// In-memory cache of resolved video codecs, for transcode=copy's
// auto-upgrade-to-h264 check (resolveVideoCodec). Keyed by
// youtubeId|quality|playerClient since the DASH format yt-dlp selects (and
// so its codec) depends on both. Never expires within a process lifetime.
const codecCache = new Map();

let models = null;

/** @param {object} params.models - Sequelize models (Video, YoutubeMetadataCache). */
function init(params) {
  models = params.models;
}

/**
 * This video's full yt-dlp extraction (same shape as a direct `yt-dlp -j`
 * call). Caching (including in-flight dedup) is entirely
 * youtubeMetadataCache's job - this just supplies the ytstream-specific
 * live-fetch (player_client override) for it to call on a cache miss.
 * Prefer this over a one-off yt-dlp call whenever what's needed is a fact
 * about the video itself (duration, height, fps, ...) rather than a
 * request-specific answer like a format selector's codec.
 * @returns {Promise<object>} parsed yt-dlp -j output
 * @throws if nothing is cached and the live extraction fails
 */
async function getVideoInfo(youtubeId, config, playerClient) {
  streamDebug({ youtubeId, playerClient }, 'ytstream: getVideoInfo called');
  const info = await youtubeMetadataCache.getOrFetchRawInfoJson(youtubeId, async () => {
    // fetchMetadata's generic arg-builder has no player_client opinion of
    // its own - replicate buildBaseArgs' precedence for it here.
    const resolvedPlayerClient = playerClient || (config.ytstream || {}).playerClient || DEFAULT_PLAYER_CLIENT;
    logger.info({ youtubeId, playerClient: resolvedPlayerClient }, 'ytstream: resolving full video metadata via yt-dlp');
    return ytDlpRunner.fetchMetadata(
      `https://youtube.com/watch?v=${youtubeId}`,
      30000,
      { extractorArgs: `youtube:player_client=${resolvedPlayerClient}` }
    );
  });
  streamDebug({ youtubeId, duration: info?.duration, formatCount: Array.isArray(info?.formats) ? info.formats.length : 0 }, 'ytstream: getVideoInfo resolved');
  return info;
}

/**
 * Duration lookup for `ytstream.calculatedLength`'s synthetic Content-Length.
 * Checks the library DB first (a real download's own recorded duration),
 * then youtube_metadata_cache (for untracked videos), falling back to
 * getVideoInfo only when neither has it.
 */
async function getVideoDurationSeconds(youtubeId, config) {
  streamDebug({ youtubeId }, 'ytstream: getVideoDurationSeconds called');
  if (models && models.Video) {
    try {
      const existing = await models.Video.findOne({
        where: { youtubeId },
        attributes: ['duration'],
      });
      const dbSeconds = existing ? Number(existing.duration) : NaN;
      if (Number.isFinite(dbSeconds) && dbSeconds > 0) {
        logger.info({ youtubeId, seconds: dbSeconds }, 'ytstream: resolved duration for calculatedLength from the database');
        return dbSeconds;
      }
      streamDebug({ youtubeId, hasVideoRow: !!existing }, 'ytstream: no usable duration in the Video table; checking metadata cache next');
    } catch (err) {
      logger.warn({ err, youtubeId }, 'ytstream: DB duration lookup failed for calculatedLength; falling back to yt-dlp');
    }
  }

  const cachedDuration = await youtubeMetadataCache.getCachedDurationSeconds(youtubeId);
  if (cachedDuration) {
    logger.info({ youtubeId, seconds: cachedDuration }, 'ytstream: resolved duration for calculatedLength from the persistent untracked-video metadata cache');
    return cachedDuration;
  }
  streamDebug({ youtubeId }, 'ytstream: no cached duration; falling back to getVideoInfo (live yt-dlp on a cache miss)');

  const info = await getVideoInfo(youtubeId, config);
  const seconds = Number(info.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Could not determine video duration for calculatedLength: ${JSON.stringify(info).slice(0, 200)}`);
  }
  return seconds;
}

/**
 * Resolves the video codec `getDashFormatSelectors` would actually select
 * at this quality — used to auto-upgrade `transcode=copy` to `h264` when
 * that format isn't H.264. The selector prefers avc1 but falls back to
 * whatever's available, commonly VP9/AV1 for videos with no H.264 track
 * that high; a `copy` remux of that isn't broadly player-compatible, and
 * can trigger Jellyfin's own server-side-transcode fallback which then
 * fails reading our stream as input.
 *
 * Uses `--print vcodec` against the same `-f` selector (not a full-format
 * parse), so the probed codec is exactly what will actually be used.
 */
async function resolveVideoCodec(youtubeId, quality, config, playerClient, qualityStrictness) {
  const cacheKey = `${youtubeId}|${quality}|${playerClient || ''}|${qualityStrictness || 'fallback'}`;
  if (codecCache.has(cacheKey)) {
    const cached = codecCache.get(cacheKey);
    streamDebug({ youtubeId, quality, playerClient, qualityStrictness, codec: cached }, 'ytstream: resolveVideoCodec cache hit');
    return cached;
  }

  const { videoFormat } = getDashFormatSelectors(quality, qualityStrictness);
  const args = [
    ...buildBaseArgs(config, { playerClient }),
    '-f', videoFormat,
    '--print', '%(vcodec)s',
    '--skip-download',
    '--no-playlist',
    '--no-warnings',
    `https://youtube.com/watch?v=${youtubeId}`,
  ];
  logger.info({ youtubeId, quality, playerClient }, 'ytstream: probing selected format\'s video codec for transcode=copy compatibility check');
  const stdout = await ytDlpRunner.run(args, { timeoutMs: 30000 });
  const codec = String(stdout).trim().split(/\r?\n/)[0] || '';
  streamDebug({ youtubeId, quality, playerClient, qualityStrictness, videoFormat, codec }, 'ytstream: resolveVideoCodec resolved via live yt-dlp probe');
  codecCache.set(cacheKey, codec);
  return codec;
}

/**
 * Cache-only check for a video's true best-available height - never spawns
 * yt-dlp. Used by resolveMaxAvailableHeight below and by the probe-shortcut
 * resolution lookup in server/routes/ytstream.js.
 * @returns {Promise<number|null>}
 */
async function peekCachedMaxHeight(youtubeId) {
  const height = await youtubeMetadataCache.getCachedMaxHeight(youtubeId);
  streamDebug({ youtubeId, height }, 'ytstream: peekCachedMaxHeight result');
  return height;
}

/**
 * The height `-f bv*` (no height ceiling) would actually select — this
 * video's true best-available resolution. Best-effort: any failure returns
 * null ("unknown, don't cap") rather than blocking playback.
 */
async function resolveMaxAvailableHeight(youtubeId, config, playerClient) {
  const cached = await peekCachedMaxHeight(youtubeId);
  if (cached) return cached;
  streamDebug({ youtubeId, playerClient }, 'ytstream: no cached best-available height; resolving via getVideoInfo (live yt-dlp on a cache miss)');

  try {
    await getVideoInfo(youtubeId, config, playerClient);
    const height = await youtubeMetadataCache.getCachedMaxHeight(youtubeId);
    streamDebug({ youtubeId, height }, 'ytstream: resolveMaxAvailableHeight resolved after live extraction');
    return height;
  } catch (err) {
    logger.warn({ err, youtubeId }, 'ytstream: failed to resolve best-available height; skipping quality auto-cap for this request');
    return null;
  }
}

/**
 * resolveQualityHeight(quality), capped to this video's real
 * best-available height (resolveMaxAvailableHeight) - so requesting 2160
 * for a video that tops out at 1080p streams at 1080p, instead of leaving
 * yt-dlp to silently fall back while every downstream decision (encoder
 * scale/bitrate, placeholder/probe resolution) stays sized for the
 * nonexistent requested height. "best" (null) is left uncapped.
 */
async function resolveEffectiveQualityHeight(youtubeId, quality, config, playerClient) {
  const requestedHeight = resolveQualityHeight(quality);
  if (!requestedHeight) return requestedHeight;
  const maxAvailable = await resolveMaxAvailableHeight(youtubeId, config, playerClient);
  return maxAvailable ? Math.min(requestedHeight, maxAvailable) : requestedHeight;
}

/**
 * Resolves every playback setting the same way for both the real
 * streaming route and the read-only `/simulate` debug route - a single
 * source of truth so the debug trace can never drift from what a real
 * request would do. Each mode is self-contained: mode=hls/hls-buffer
 * fails outright (`ffmpegAvailable: false`) rather than substituting a
 * different mode's behavior when ffmpeg isn't available.
 *
 * strmGenerator.buildStrmContent appends .strm pipe-syntax
 * (`url|User-Agent=value`) directly onto the FULL url including its query
 * string, relying on the player to strip everything from the first `|`
 * before requesting it. Jellyfin's browser htmlVideoPlayer does NOT do
 * this - it requests the raw line, so the suffix glues onto the last
 * query param (e.g. `calculatedLength=1` becomes
 * `calculatedLength=1|User-Agent=Youtarr-Playback%2F1.0` on the wire). A
 * strict `/^(1|true|yes)$/i` match against that silently evaluates to
 * false, taking the whole session down a different, buggy code path with
 * no error. Splitting on `|` first makes boolean flags tolerant of that
 * suffix regardless of which consumer failed to strip it.
 *
 * `probe: false` (/simulate's default) skips the two live yt-dlp probes
 * (resolveEffectiveQualityHeight/resolveVideoCodec) and reports pre-probe
 * values, so a debug call is instant and never touches yt-dlp/YouTube.
 * isFfmpegAvailable() and probeShortcut are always evaluated for real
 * either way - both cheap, pure/cached reads.
 */
async function resolvePlaybackPlan(youtubeId, req, config, { probe }) {
  const ytCfg = config.ytstream || {};
  const steps = [];

  // probeShortcut - evaluateProbeShortcut is the same function the real
  // early-exit block above this route calls, so this can never drift
  // from what actually decides whether a real request short-circuits
  // there. A real request that matches this never reaches any of the
  // logic below at all - this is computed here purely for the trace.
  const probeShortcut = evaluateProbeShortcut(req, config);
  steps.push({ step: 'probeShortcut', detail: probeShortcut.reason, probed: false });

  const forceServerSettings = ytCfg.forceServerSettings === true;
  const queryOverride = createQueryOverrideResolver(req, ytCfg);
  const ignoredQueryParams = forceServerSettings
    ? ['mode', 'container', 'transcode', 'hardware', 'tuning', 'quality', 'qualityStrictness', 'calculatedLength', 'fakeLength'].filter(
      (name) => req.query[name] !== undefined
    )
    : [];
  steps.push({
    step: 'forceServerSettings',
    detail: forceServerSettings
      ? `on - every setting below comes from Settings→Streaming only; ignoring query params present on this request: ${
        ignoredQueryParams.length ? ignoredQueryParams.join(', ') : '(none present on this request)'
      }`
      : 'off - query-string overrides are honored',
    probed: false,
  });

  const requestedMode = String(queryOverride('mode') || ytCfg.defaultMode || 'direct').toLowerCase();
  const requestedModeValid = VALID_MODES.includes(requestedMode);
  let mode;
  if (requestedModeValid) {
    mode = requestedMode;
  } else {
    // Most commonly a stale mode baked into an old .strm file/URL from
    // before a mode was retired (e.g. the removed direct-pipe/ffmpeg
    // modes) - fall back to whatever's CURRENTLY configured rather than a
    // hardcoded 'direct', so retiring a mode doesn't silently downgrade
    // existing .strm files to a much lower quality ceiling than the admin
    // actually has configured. Only trust ytCfg.defaultMode if it's ALSO
    // currently valid - if the config itself still holds a since-removed
    // mode, there's nothing else to fall back to but 'direct'.
    const configuredMode = String(ytCfg.defaultMode || '').toLowerCase();
    const configuredModeValid = VALID_MODES.includes(configuredMode);
    mode = configuredModeValid ? configuredMode : 'direct';
    const detail = `requested mode "${requestedMode}" isn't one of ${VALID_MODES.join('/')}; using the current ${configuredModeValid ? 'configured default' : 'hardcoded'} mode "${mode}" instead`;
    logger.info({ youtubeId, requestedMode, resolvedMode: mode }, `ytstream: ${detail}`);
    steps.push({ step: 'mode', detail, probed: false });
  }

  const ffmpegAvailable = isFfmpegAvailable();
  if ((mode === 'hls' || mode === 'hls-buffer') && !ffmpegAvailable) {
    // No fallback to a different mode - mode=hls/hls-buffer
    // requires ffmpeg, full stop. The real route responds 502 for this
    // rather than silently serving direct instead.
    steps.push({ step: 'mode', detail: `mode=${mode} requested but ffmpeg is unavailable on this host; fails outright (502), no fallback to a different mode`, probed: false });
  } else {
    steps.push({ step: 'mode', detail: `resolved to ${mode}`, probed: false });
  }

  const container = VALID_CONTAINERS.includes(queryOverride('container'))
    ? queryOverride('container')
    : (ytCfg.container || 'mp4');

  let transcode = VALID_TRANSCODE.includes(queryOverride('transcode'))
    ? queryOverride('transcode')
    : (ytCfg.transcode || 'copy');

  const hardwareMode = normalizeHardwareMode(queryOverride('hardware') || ytCfg.hardwareMode || 'none');
  const tuning = normalizeTuning(queryOverride('tuning') || ytCfg.tuning || 'fast');

  const isDirectFamily = mode === 'direct' || mode === 'direct-redirect';

  if (isDirectFamily) {
    steps.push({
      step: 'container/transcode/hardwareMode/tuning',
      detail: `ignored - ${mode} mode always fetches the raw progressive YouTube stream as-is (no remux/transcode)`,
      probed: false,
    });
  }

  const requestedQualityStrictnessRaw = String(queryOverride('qualityStrictness') || ytCfg.qualityStrictness || 'fallback').toLowerCase();
  const qualityStrictnessValues = ['fixed', 'fallback', 'best'];
  let qualityStrictness;
  if (qualityStrictnessValues.includes(requestedQualityStrictnessRaw)) {
    qualityStrictness = requestedQualityStrictnessRaw;
  } else {
    // Same reasoning as mode's fallback above - prefer the currently
    // configured value over a hardcoded 'fallback' when the request (or a
    // stale .strm URL) carries something invalid.
    const configuredQualityStrictness = String(ytCfg.qualityStrictness || '').toLowerCase();
    const configuredValid = qualityStrictnessValues.includes(configuredQualityStrictness);
    qualityStrictness = configuredValid ? configuredQualityStrictness : 'fallback';
    const detail = `requested qualityStrictness "${requestedQualityStrictnessRaw}" isn't fixed/fallback/best; using the current ${configuredValid ? 'configured default' : 'hardcoded'} value "${qualityStrictness}" instead`;
    logger.info({ youtubeId, requestedQualityStrictnessRaw, resolvedQualityStrictness: qualityStrictness }, `ytstream: ${detail}`);
    steps.push({ step: 'qualityStrictness', detail, probed: false });
  }

  const requestedQuality = String(queryOverride('quality') || ytCfg.quality || config.preferredResolution || '720');

  let quality = requestedQuality;
  let qualityCapped = false;
  if (isDirectFamily) {
    steps.push({
      step: 'quality',
      detail: `requested "${requestedQuality}" (strictness: ${qualityStrictness}) used as-is - ${mode} mode's format selector already self-limits to whatever's actually available, so it is never auto-capped`,
      probed: false,
    });
  } else if (qualityStrictness === 'best') {
    steps.push({
      step: 'quality',
      detail: 'quality strictness is "best" - ignoring the configured quality entirely, always uses this video\'s true best-available DASH format (uncapped bv*), no auto-cap probe needed',
      probed: false,
    });
  } else if (qualityStrictness === 'fixed') {
    steps.push({
      step: 'quality',
      detail: `quality strictness is "fixed" - requested "${requestedQuality}" used exactly as configured, no auto-cap; if this video's real best-available height is lower, the request fails rather than silently substituting a lower one`,
      probed: false,
    });
  } else if (!probe) {
    steps.push({
      step: 'quality',
      detail: `requested "${requestedQuality}"; not probed - pass probe=true for this video's real auto-capped value (resolveEffectiveQualityHeight)`,
      probed: false,
    });
  } else {
    const cappedQualityHeight = await resolveEffectiveQualityHeight(youtubeId, requestedQuality, config, ytCfg.playerClient);
    if (cappedQualityHeight) {
      quality = String(cappedQualityHeight);
      qualityCapped = quality !== requestedQuality;
    }
    steps.push({
      step: 'quality',
      detail: qualityCapped
        ? `checked this video's real best-available height via yt-dlp (-f bv*) - requested "${requestedQuality}" auto-capped to "${quality}"`
        : `checked this video's real best-available height via yt-dlp (-f bv*) - requested "${requestedQuality}" used as-is (not capped - already within range, or "best")`,
      probed: true,
    });
  }

  const seekSeconds = req.query.t ? Number(req.query.t) : null;

  // getModeFieldCompatibility is the single canonical source for all of
  // this - both the forced-value ENFORCEMENT below and the dry-run TEXT
  // explaining it derive from the same status+reason, so they can't drift
  // apart the way three independently hand-written versions once did.
  const modeCompat = getModeFieldCompatibility({ mode, transcode, container });

  const calculatedLengthRaw = queryOverride('calculatedLength') ?? queryOverride('fakeLength') ?? ytCfg.calculatedLength;
  const calculatedLengthCompat = modeCompat.calculatedLength;
  const calculatedLength = calculatedLengthCompat.status === 'forced' ? true : parseBooleanQueryFlag(calculatedLengthRaw);
  if (calculatedLengthCompat.status === 'forced' && !parseBooleanQueryFlag(calculatedLengthRaw)) {
    steps.push({ step: 'calculatedLength', detail: `forced on - ${calculatedLengthCompat.reason}`, probed: false });
  } else if (calculatedLengthCompat.status === 'ignored' && calculatedLength) {
    steps.push({ step: 'calculatedLength', detail: `on, but ignored - ${calculatedLengthCompat.reason}`, probed: false });
  } else if (calculatedLengthCompat.status === 'optional' && calculatedLength) {
    steps.push({ step: 'calculatedLength', detail: `on - ${calculatedLengthCompat.reason}`, probed: false });
  }

  const hotSwapToCache = ytCfg.hotSwapToCache === true;
  const hotSwapToCacheCompat = modeCompat.hotSwapToCache;
  if (hotSwapToCache && hotSwapToCacheCompat.status === 'ignored') {
    steps.push({ step: 'hotSwapToCache', detail: `on, but ignored - ${hotSwapToCacheCompat.reason}`, probed: false });
  }

  const backfillMissingSegments = ytCfg.backfillMissingSegments === true;
  const backfillMissingSegmentsCompat = modeCompat.backfillMissingSegments;
  if (backfillMissingSegments && backfillMissingSegmentsCompat.status === 'ignored') {
    steps.push({ step: 'backfillMissingSegments', detail: `on, but ignored - ${backfillMissingSegmentsCompat.reason}`, probed: false });
  } else if (backfillMissingSegments && backfillMissingSegmentsCompat.status === 'optional') {
    steps.push({ step: 'backfillMissingSegments', detail: `on - ${backfillMissingSegmentsCompat.reason}`, probed: false });
  }

  const finalizeToMp4 = ytCfg.finalizeToMp4 === true;
  const finalizeToMp4Compat = modeCompat.finalizeToMp4;
  if (finalizeToMp4 && finalizeToMp4Compat.status === 'ignored') {
    steps.push({ step: 'finalizeToMp4', detail: `on, but ignored - ${finalizeToMp4Compat.reason}`, probed: false });
  } else if (finalizeToMp4 && finalizeToMp4Compat.status === 'optional') {
    steps.push({ step: 'finalizeToMp4', detail: `on - ${finalizeToMp4Compat.reason}`, probed: false });
  }

  const stealthCache = ytCfg.stealthCache === true;
  const stealthCacheCompat = modeCompat.stealthCache;
  if (stealthCache && stealthCacheCompat.status === 'ignored') {
    steps.push({ step: 'stealthCache', detail: `on, but ignored - ${stealthCacheCompat.reason}`, probed: false });
  } else if (stealthCache && stealthCacheCompat.status === 'optional') {
    steps.push({
      step: 'stealthCache',
      detail: finalizeToMp4
        ? `on - ${stealthCacheCompat.reason} (finalizeToMp4 is also on: once the hidden .ts is remuxed, it's swapped for the .mp4 within the hidden cache itself - never promoted to the library)`
        : `on - ${stealthCacheCompat.reason}`,
      probed: false,
    });
  }

  if (transcode === 'copy' && (mode === 'hls' || mode === 'hls-buffer')) {
    if (!probe) {
      steps.push({
        step: 'transcode',
        detail: 'copy requested; not probed - pass probe=true to check whether this video\'s selected format is actually H.264 (resolveVideoCodec auto-upgrade)',
        probed: false,
      });
    } else {
      try {
        const selectedCodec = await resolveVideoCodec(youtubeId, quality, config, ytCfg.playerClient, qualityStrictness);
        if (selectedCodec && !isH264Codec(selectedCodec)) {
          steps.push({
            step: 'transcode',
            detail: `probed selected format's codec via yt-dlp (--print vcodec) - copy requested but codec is "${selectedCodec}" (not H.264); auto-upgraded to h264`,
            probed: true,
          });
          transcode = 'h264';
        } else {
          steps.push({
            step: 'transcode',
            detail: `probed selected format's codec via yt-dlp (--print vcodec) - copy requested and codec is "${selectedCodec}" (H.264); kept as copy`,
            probed: true,
          });
        }
      } catch (err) {
        steps.push({
          step: 'transcode',
          detail: `probed selected format's codec via yt-dlp (--print vcodec) - probe failed (${err.message}); falling back to proceeding with copy as requested, same as the real route does on this same failure`,
          probed: true,
        });
      }
    }
  }

  // Direct-family modes already get their own "ignored" step above;
  // hls/hls-buffer actually run these through an ffmpeg encode, but their
  // wouldCall is just an opaque session key hash - this spells out the
  // resolved values themselves. container is always a real choice here;
  // hardware/tuning only matter once transcode has resolved to h264 (see
  // getModeFieldCompatibility) - copy never touches an encoder.
  if (!isDirectFamily) {
    steps.push({
      step: 'container/transcode/hardwareMode/tuning',
      detail: transcode === 'h264'
        ? `container="${container}", transcode="${transcode}", hardware="${hardwareMode}", tuning="${tuning}"`
        : `container="${container}", transcode="${transcode}" - hardware encoder and tuning are ignored (copy never touches an encoder)`,
      probed: false,
    });
  }

  // Execution/fallback narrative - describes what happens once the
  // resolved mode/quality/transcode is handed to the real serve function,
  // including retry chains (serveDirect/resolveDirectUrl,
  // getOrCreateHlsSession). Static/descriptive, kept in sync by hand
  // rather than derived; skipped entirely when probeShortcut would fire.
  const ffmpegModeBlocked = (mode === 'hls' || mode === 'hls-buffer') && !ffmpegAvailable;
  if (!probeShortcut.wouldFire && !ffmpegModeBlocked) {
    if (mode === 'direct') {
      steps.push({ step: 'execution', detail: 'resolve a direct playback URL via yt-dlp (-g)', probed: false });
      steps.push({ step: 'execution', detail: 'if that yt-dlp call fails with a client/session extraction error, retry once with player_client=android', probed: false });
      steps.push({
        step: 'execution',
        detail: 'once a URL is resolved, fetch it; if that fetch is rejected (e.g. HTTP 403 - a session-bound URL), respond 502 - no fallback',
        probed: false,
      });
    } else if (mode === 'direct-redirect') {
      steps.push({ step: 'execution', detail: 'resolve a direct playback URL via yt-dlp (-g), same as plain direct mode', probed: false });
      steps.push({ step: 'execution', detail: 'if that yt-dlp call fails with a client/session extraction error, retry once with player_client=android', probed: false });
      steps.push({
        step: 'execution',
        detail: 'once resolved, respond with a 302 redirect straight to that URL - Youtarr never fetches the bytes itself, so whatever happens next (success or failure) happens directly between the player and YouTube, invisible to Youtarr\'s own logs',
        probed: false,
      });
    } else {
      const pipelineDesc = (mode === 'hls' || mode === 'hls-buffer')
        ? 'fetch video+audio via yt-dlp (DASH format selectors) piped into ffmpeg, writing real HLS segment files'
        : 'fetch video+audio via yt-dlp (DASH format selectors) piped into a single live ffmpeg connection';
      steps.push({ step: 'execution', detail: pipelineDesc, probed: false });
      steps.push({
        step: 'execution',
        detail: 'if yt-dlp fails to fetch (a client/session extraction error, or a 403) and nothing has reached the client yet, retry once with player_client=android',
        probed: false,
      });
      if (transcode === 'h264' && hardwareMode !== 'none') {
        steps.push({
          step: 'execution',
          detail: `if the hardware encoder (${hardwareMode}) fails to initialize before any bytes are sent, retry once in software (libx264)`,
          probed: false,
        });
      }
      if (mode === 'hls-buffer') {
        // Kept short and user-facing here; the full mechanism (exact
        // timings, DB field names, STRM/untracked bookkeeping) is
        // documented on the code this trace mirrors, not repeated to the
        // user in the dry-run preview.
        steps.push({
          step: 'execution',
          detail: 'a separate background pipeline starts immediately, pulling the whole video once (unthrottled) into a local buffer file - independent of this session\'s playback, so it keeps running even if you seek or stop watching',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'the first pass does not wait for that buffer - it streams from the network right away, same as plain Enhanced HLS. Exception: if this video was already fully buffered from an earlier play, that finished file is used immediately instead',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'later passes (a seek, or a missing-segment restart) wait up to 45s for the buffer to catch up, then read from that local file instead of the network; on timeout, that one pass falls back to streaming from the network (the buffer itself keeps running either way)',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'if this video is already in your library as a STRM placeholder: once buffering finishes, that file replaces the placeholder and every future play uses it directly',
          probed: false,
        });
        steps.push({
          step: 'execution',
          detail: 'if this video is not in your library at all (e.g. an NZB-only grab): the finished buffer file is cached separately instead, and reused on later plays of that same video - it just will not show up in Download History or your library',
          probed: false,
        });
      }
      steps.push({
        step: 'execution',
        detail: (mode === 'hls' || mode === 'hls-buffer')
          ? 'if it still fails, respond 502 (HLS stream failed to start)'
          : 'if it still fails, respond 502 (Stream failed)',
        probed: false,
      });
    }
  }

  return {
    mode,
    requestedMode,
    ffmpegAvailable,
    container,
    transcode,
    hardwareMode,
    tuning,
    requestedQuality,
    quality,
    qualityStrictness,
    qualityCapped,
    seekSeconds,
    calculatedLength,
    hotSwapToCache,
    backfillMissingSegments,
    finalizeToMp4,
    stealthCache,
    forceServerSettings,
    ignoredQueryParams,
    probeShortcut,
    steps,
  };
}

module.exports = {
  init,
  getVideoInfo,
  getVideoDurationSeconds,
  resolveVideoCodec,
  resolveMaxAvailableHeight,
  peekCachedMaxHeight,
  resolveEffectiveQualityHeight,
  resolvePlaybackPlan,
};
