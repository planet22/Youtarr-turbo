const axios = require('axios');
const logger = require('../logger');
const ytDlpRunner = require('./ytDlpRunner');
const nzbFeedModule = require('./nzbFeedModule');
const createConcurrencyLimiter = require('./subscriptionImport/concurrencyLimiter');

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
// so once genuinely determined it's cached indefinitely (size-capped, not
// time-limited) rather than re-probed on every search - Sonarr/Radarr/
// Prowlarr repeatedly re-poll the same and overlapping queries (see
// videoSearchModule.js's own rawResultsCache for the same reasoning applied
// to whole search result sets), and the same popular video can surface
// across many different queries. Deliberately keyed independent of that
// query-level cache, and never stores an inconclusive/unconfirmed outcome -
// see fillUnknownDefinitions below for which outcomes qualify.
const MAX_CACHE_ENTRIES = 5000;
const resolutionCache = new Map();

function cacheGet(youtubeId) {
  return resolutionCache.get(youtubeId) || null;
}

function cacheSet(youtubeId, value) {
  if (!resolutionCache.has(youtubeId) && resolutionCache.size >= MAX_CACHE_ENTRIES) {
    // Map preserves insertion order - the first key is the oldest entry.
    const oldestKey = resolutionCache.keys().next().value;
    resolutionCache.delete(oldestKey);
  }
  resolutionCache.set(youtubeId, value);
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
 * @param {Array<{youtubeId: string, definition?: string|null}>} results
 * @param {{useThumb?: boolean, useExtract?: boolean}} [options]
 */
async function fillUnknownDefinitions(results, { useThumb = true, useExtract = true } = {}) {
  const needsProbe = results.filter((r) => r.definition == null && r.youtubeId);
  if (needsProbe.length === 0 || (!useThumb && !useExtract)) return;

  await Promise.all(needsProbe.map(async (r) => {
    const cached = cacheGet(r.youtubeId);
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
}

module.exports = { probeDefinition, probeViaExtraction, fillUnknownDefinitions };
