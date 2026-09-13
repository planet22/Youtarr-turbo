const axios = require('axios');
const logger = require('../logger');
const ytDlpRunner = require('./ytDlpRunner');
const nzbFeedModule = require('./nzbFeedModule');
const youtubeMetadataCache = require('./youtubeMetadataCache');
const createConcurrencyLimiter = require('./subscriptionImport/concurrencyLimiter');
const configModule = require('./configModule');

/**
 * Best-effort resolution detection for the yt-dlp flat-playlist search
 * fallback (see videoSearchModule.js) - flat-playlist carries no
 * resolution/format data at all, so nzb.js can't tell a genuinely-HD result
 * from an SD-only one the way it can on the YouTube Data API path
 * (server/modules/youtubeApi/client.js's contentDetails.definition). Two
 * fallback tiers, both gated by nzb.resolutionDetection config (see nzb.js):
 *
 * 1. probeDefinition (the "thumb" toggle) - cheap: checks whether YouTube's
 *    maxresdefault.jpg is a real thumbnail or its small gray placeholder.
 *    Fast, but a confident "hd" answer can still be wrong (see its doc
 *    comment).
 * 2. probeViaExtraction (the "extract" toggle) - authoritative: a REAL
 *    yt-dlp extraction of the video's watch page, reading its actual
 *    formats list. Slow and comparatively YouTube-rate-limit-sensitive, so
 *    only used to confirm/correct an uncertain result from (1), never run
 *    on every item.
 *
 * See nzb.js for the third, cheapest tier ("fixed" - a previously-downloaded
 * video's already-known real resolution), which never needs this module at
 * all.
 */

const PROBE_TIMEOUT_MS = 3000;
// The placeholder gray image is a fixed ~1-2KB; real maxres thumbnails run
// from ~15KB up. This floor sits comfortably between the two.
const PLACEHOLDER_MAX_BYTES = 5000;

/**
 * @param {string} youtubeId
 * @returns {Promise<'hd'|'sd'|null>} null means the probe itself failed
 *   (network error, timeout) - callers should treat that as "unknown", the
 *   same as if no probe had run at all, never as "sd".
 */
async function probeDefinition(youtubeId) {
  try {
    const url = `https://i.ytimg.com/vi/${encodeURIComponent(youtubeId)}/maxresdefault.jpg`;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: PROBE_TIMEOUT_MS,
      validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Youtarr NZB resolution probe)' },
    });
    // A non-200 here (5xx, rate limiting) is a CDN anomaly, not evidence of
    // anything - YouTube serves this URL with a 200 either way (real
    // thumbnail or placeholder) for any video that still exists.
    if (res.status !== 200) return null;
    const contentLength = Number(res.headers['content-length']);
    const length = Number.isFinite(contentLength) ? contentLength : (res.data ? res.data.length : 0);
    return length > PLACEHOLDER_MAX_BYTES ? 'hd' : 'sd';
  } catch (err) {
    logger.debug({ err, youtubeId }, 'nzb: maxresdefault thumbnail probe failed, treating as unknown');
    return null;
  }
}

// Real per-video extractions are the expensive, YouTube-rate-limit-sensitive
// option below - capped well below the thumbnail probe's effectively
// unlimited fan-out so a search with many uncertain results doesn't fire off
// a burst of simultaneous watch-page fetches.
const EXTRACTION_TIMEOUT_MS = 15000;
const EXTRACTION_CONCURRENCY = 2;
const extractionLimiter = createConcurrencyLimiter(EXTRACTION_CONCURRENCY);

/**
 * Authoritative fallback for when probeDefinition either failed outright or
 * answered "hd" - a confident "hd" from the thumbnail check can still be
 * wrong, because YouTube sometimes auto-regenerates/upscales a large,
 * real-looking maxresdefault.jpg for an old video independent of the actual
 * encoded video resolution (thumbnail quality improvements are decoupled
 * from the underlying stream). This runs a REAL yt-dlp extraction of the
 * video's watch page - the same `--dump-single-json` call already used
 * elsewhere for channel/video metadata (see ytDlpRunner.fetchMetadata) - and
 * reads the true formats list. Authoritative, but a genuine network fetch of
 * the watch page rather than a static image: slower (seconds, not
 * milliseconds) and more likely to draw YouTube's attention if run at
 * volume, so callers only reach for this to confirm/correct an uncertain
 * result, never on every item.
 * @param {string} youtubeId
 * @returns {Promise<{definition: 'hd'|'sd', heightTier: number}|null>} null
 *   if the extraction itself fails - caller falls back to the thumbnail
 *   probe's own answer.
 */
async function probeViaExtraction(youtubeId) {
  try {
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}`;
    const data = await ytDlpRunner.fetchMetadata(url, EXTRACTION_TIMEOUT_MS);
    const formats = Array.isArray(data?.formats) ? data.formats : [];
    let maxHeight = 0;
    for (const fmt of formats) {
      if (!fmt || !fmt.vcodec || fmt.vcodec === 'none') continue;
      if (typeof fmt.height === 'number' && fmt.height > maxHeight) maxHeight = fmt.height;
    }
    if (maxHeight <= 0) return null;
    // Reuses the same tier-snapping nzbFeedModule already applies to the
    // configured quality, so an odd real height (e.g. 288) lands on the same
    // small set of tiers Sonarr's release parser recognizes, rather than an
    // arbitrary number.
    const heightTier = nzbFeedModule.resolveQualityTier(String(maxHeight));
    return { definition: maxHeight >= 720 ? 'hd' : 'sd', heightTier };
  } catch (err) {
    logger.debug({ err, youtubeId }, 'nzb: real yt-dlp extraction fallback failed');
    return null;
  }
}

// Per-video resolution essentially never changes (barring a rare re-upload),
// so once genuinely determined it's cached indefinitely rather than
// re-probed on every search - Sonarr/Radarr/Prowlarr repeatedly re-poll the
// same and overlapping queries (see videoSearchModule.js's own
// rawResultsCache for the same reasoning applied to whole search result
// sets), and the same popular video can surface across many different
// queries. Persisted in its own `nzb_resolution_cache` table (see the
// create-nzb-resolution-cache migration's doc comment) rather than an
// in-memory Map, so it survives a restart, and deliberately NOT in
// youtube_metadata_cache - see getFromLibraryMetadataCache below for why.
// Never stores an inconclusive/unconfirmed outcome - see
// fillUnknownDefinitions below for which outcomes qualify.
async function cacheGet(youtubeId) {
  try {
    const { NzbResolutionCache } = require('../models');
    const row = await NzbResolutionCache.findByPk(youtubeId);
    if (!row) return null;
    return { definition: row.definition, heightTier: row.height_tier, source: row.source };
  } catch (err) {
    logger.warn({ err, youtubeId }, 'nzb: resolution cache lookup failed');
    return null;
  }
}

// nzb.videoResolutionCacheLimit (Settings -> Sonarr/Radarr/Prowlarr (NZB) ->
// NZB Video Cache), 100-10,000 - replaces the old in-memory Map's 5000-entry
// manual LRU eviction now that this cache is a DB table (see
// create-nzb-resolution-cache migration's doc comment). Read live per call,
// same pattern as nzb.js's nzbDebug.
const DEFAULT_VIDEO_RESOLUTION_CACHE_LIMIT = 5000;

function resolveVideoResolutionCacheLimit(cfg) {
  const raw = cfg?.nzb?.videoResolutionCacheLimit;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_VIDEO_RESOLUTION_CACHE_LIMIT;
  return Math.min(10000, Math.max(100, Math.round(n)));
}

function cacheSet(youtubeId, value) {
  const { NzbResolutionCache } = require('../models');
  NzbResolutionCache.upsert({
    youtube_id: youtubeId,
    definition: value.definition,
    height_tier: value.heightTier,
    source: value.source,
  }).then(async () => {
    // Lazy prune on every write rather than a timer, same approach as
    // nzbDiagnosticLog.js's eviction - an extra count+delete per write is
    // negligible against yt-dlp/thumbnail-probe latency.
    const max = resolveVideoResolutionCacheLimit(configModule.getConfig());
    const count = await NzbResolutionCache.count();
    if (count > max) {
      const stale = await NzbResolutionCache.findAll({
        attributes: ['youtube_id'],
        order: [['createdAt', 'ASC']],
        limit: count - max,
      });
      await NzbResolutionCache.destroy({ where: { youtube_id: stale.map((row) => row.youtube_id) } });
    }
  }).catch((err) => {
    logger.warn({ err, youtubeId }, 'nzb: failed to persist resolution cache entry');
  });
}

/**
 * Read-only check of the SHARED youtube_metadata_cache table (see
 * youtubeMetadataCache.js) - the single place any real yt-dlp extraction
 * Youtarr has ever run for this video (a download, an ytstream live
 * warm-up, STRM materialization) already gets persisted. If a full
 * extraction already happened for another reason, that's authoritative and
 * free - no need for this module's own thumb/extract probes at all.
 * Deliberately never WRITES here: Sonarr/Radarr/Prowlarr's NZB searches
 * probe far more videos than are ever downloaded or played, and this table
 * doubles as the Library page's "untracked" bucket (videosModule.js's
 * _getUntrackedCandidates) - writing every searched-but-untouched video's
 * metadata here would flood that view. See cacheGet/cacheSet above for
 * where an nzb-probed result (thumb/extract) actually gets persisted
 * instead.
 * @param {string} youtubeId
 * @returns {Promise<{definition: 'hd'|'sd', heightTier: number}|null>}
 */
async function getFromLibraryMetadataCache(youtubeId) {
  const maxHeight = await youtubeMetadataCache.getCachedMaxHeight(youtubeId);
  if (!maxHeight) return null;
  return {
    definition: maxHeight >= 720 ? 'hd' : 'sd',
    heightTier: nzbFeedModule.resolveQualityTier(String(maxHeight)),
  };
}

/**
 * Fills in `definition`/`actualHeightTier`/`resolutionSource` (mutating in
 * place) for every result that doesn't already have a `definition` - i.e.
 * results the YouTube Data API never enriched (yt-dlp fallback searches, an
 * API enrichment failure, or one nzb.js's "fixed" known-local-resolution
 * check didn't match). Deliberately called on the FINAL result set only -
 * after title filtering and offset/limit slicing in nzb.js - since that's
 * typically a fraction of the raw candidates a search fetches.
 *
 * useThumb/useExtract mirror the nzb.resolutionDetection.thumb/extract
 * config toggles (see nzb.js), both defaulting true. When useThumb is off,
 * the cheap heuristic is skipped entirely and, if useExtract is on, every
 * remaining item goes straight to the real extraction - i.e. extract is
 * always the fallback of last resort once the cheaper options ahead of it
 * (fixed, thumb) are unavailable or disabled. A confident "sd" from the
 * thumbnail probe (a genuine placeholder image) is trusted outright and
 * never re-verified - only "hd" (which can be a false positive) or an
 * inconclusive probe reaches the extraction step.
 *
 * Ahead of all of that (regardless of the useThumb/useExtract toggles,
 * same as this module's own persisted cache), each item first checks the
 * shared youtube_metadata_cache table via getFromLibraryMetadataCache - a
 * real extraction Youtarr already has on file from downloading or
 * streaming this exact video, read-only, never re-probed.
 * @param {Array<{youtubeId: string, definition?: string|null}>} results
 * @param {{useThumb?: boolean, useExtract?: boolean}} [options]
 * @returns {Promise<number>} how many items actually needed a resolution
 *   lookup here (already had no `definition` from the API/fixed tiers) -
 *   surfaced by nzb.js's applyResolutionDetection as the NZB diagnostics
 *   page's "Resolution" query count, regardless of whether each one was
 *   answered from a cache or a real probe.
 */
async function fillUnknownDefinitions(results, { useThumb = true, useExtract = true } = {}) {
  const needsProbe = results.filter((r) => r.definition == null && r.youtubeId);
  if (needsProbe.length === 0) return 0;

  await Promise.all(needsProbe.map(async (r) => {
    const fromLibrary = await getFromLibraryMetadataCache(r.youtubeId);
    if (fromLibrary) {
      r.definition = fromLibrary.definition;
      r.actualHeightTier = fromLibrary.heightTier;
      r.resolutionSource = 'metadataCache';
      return;
    }

    if (!useThumb && !useExtract) return;

    const cached = await cacheGet(r.youtubeId);
    if (cached) {
      r.definition = cached.definition;
      r.actualHeightTier = cached.heightTier;
      r.resolutionSource = cached.source;
      return;
    }

    let thumbResult = null;
    if (useThumb) {
      thumbResult = await probeDefinition(r.youtubeId);
      if (thumbResult === 'sd') {
        r.definition = 'sd';
        r.resolutionSource = 'thumb';
        cacheSet(r.youtubeId, { definition: 'sd', heightTier: null, source: 'thumb' });
        return;
      }
    }

    if (useExtract) {
      const extracted = await extractionLimiter(() => probeViaExtraction(r.youtubeId));
      if (extracted) {
        r.definition = extracted.definition;
        r.actualHeightTier = extracted.heightTier;
        r.resolutionSource = 'extract';
        cacheSet(r.youtubeId, { definition: extracted.definition, heightTier: extracted.heightTier, source: 'extract' });
        return;
      }
    }

    // Nothing authoritative available - fall back to whatever the thumbnail
    // probe said (an unconfirmed "hd" guess, or null if it was off/failed
    // too). Deliberately never cached: null should be retried on the next
    // search rather than stuck permanently "unknown", and an unconfirmed
    // "hd" is exactly the case that might be wrong - caching it would lock
    // in a possibly-false answer instead of giving a later attempt (e.g.
    // once useExtract gets turned on, or the extraction succeeds next time)
    // a chance to correct it.
    if (thumbResult) {
      r.definition = thumbResult;
      r.resolutionSource = 'thumb';
    }
  }));

  return needsProbe.length;
}

module.exports = { probeDefinition, probeViaExtraction, fillUnknownDefinitions };
