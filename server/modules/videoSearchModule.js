const ytDlpRunner = require('./ytDlpRunner');
const ytdlpCommandBuilder = require('./download/ytdlpCommandBuilder');
const logger = require('../logger');
const { Video } = require('../models');
const youtubeApi = require('./youtubeApi');

const SEARCH_TIMEOUT_MS = 60_000;
const ALLOWED_COUNTS = [10, 25, 50, 100];

class SearchCanceledError extends Error {
  constructor() { super('Search canceled'); this.name = 'SearchCanceledError'; }
}
class SearchTimeoutError extends Error {
  constructor() { super('Search timed out'); this.name = 'SearchTimeoutError'; }
}

// Raw (pre-local-status, pre-sort) search results, keyed by the exact
// query+count sent to the API/yt-dlp - see _fetchRaw. Sonarr/Radarr poll
// Newznab searches (server/routes/nzb.js) on their own schedule and often
// re-send the identical query well within a human's sense of "just
// searched this", so a short TTL avoids spawning a redundant yt-dlp
// process (or burning API quota) for a query this module already just
// answered. Configurable via nzb.searchCacheMinutes; 0 disables it
// entirely (checked fresh on every call, not just at startup, so toggling
// the setting takes effect immediately without a restart).
const rawResultsCache = new Map();

// Diagnostics for the NZB settings/status page (server/routes/config.js's
// GET /api/nzb/stats) - recorded ONLY for origin: 'nzb' calls (from
// server/routes/nzb.js's Newznab search handler), never for the unrelated
// manual "Find Videos" UI search, so the page reflects Sonarr/Radarr/
// Prowlarr traffic specifically rather than a human browsing YouTube.
const MAX_RECENT_NZB_QUERIES = 50;
const QPS_WINDOW_MS = 60_000;
const nzbStats = {
  totalQueries: 0,
  cacheHits: 0,
  cacheMisses: 0,
  recentQueries: [],
  recentTimestamps: [],
};

function recordNzbQuery({ query, count, source, cacheHit, resultCount, durationMs }) {
  const now = Date.now();
  nzbStats.totalQueries += 1;
  if (cacheHit) nzbStats.cacheHits += 1;
  else nzbStats.cacheMisses += 1;

  nzbStats.recentQueries.unshift({ query, count, source, cacheHit, resultCount, durationMs, timestamp: now });
  if (nzbStats.recentQueries.length > MAX_RECENT_NZB_QUERIES) {
    nzbStats.recentQueries.length = MAX_RECENT_NZB_QUERIES;
  }

  nzbStats.recentTimestamps.push(now);
  const cutoff = now - QPS_WINDOW_MS;
  while (nzbStats.recentTimestamps.length && nzbStats.recentTimestamps[0] < cutoff) {
    nzbStats.recentTimestamps.shift();
  }
}

function getCacheSnapshot() {
  const now = Date.now();
  return Array.from(rawResultsCache.entries())
    .map(([key, entry]) => ({
      key,
      query: entry.query,
      count: entry.count,
      source: entry.source,
      resultCount: entry.results.length,
      cachedAt: entry.cachedAt,
      expiresAt: entry.expiresAt,
      expiresInMs: Math.max(0, entry.expiresAt - now),
    }))
    .sort((a, b) => b.expiresAt - a.expiresAt);
}

function deleteCacheEntries(keys) {
  let removed = 0;
  for (const key of keys) {
    if (rawResultsCache.delete(key)) removed += 1;
  }
  return removed;
}

function getNzbStats() {
  const now = Date.now();
  const cutoff = now - QPS_WINDOW_MS;
  // recentTimestamps is already pruned to the window on every write, but
  // pruning only happens on the next recordNzbQuery call - filter again here
  // so a stats read during a quiet period doesn't report stale QPS.
  const windowCount = nzbStats.recentTimestamps.filter((t) => t >= cutoff).length;
  return {
    totalQueries: nzbStats.totalQueries,
    cacheHits: nzbStats.cacheHits,
    cacheMisses: nzbStats.cacheMisses,
    cacheHitRate: nzbStats.totalQueries > 0 ? nzbStats.cacheHits / nzbStats.totalQueries : 0,
    queriesPerSecond: windowCount / (QPS_WINDOW_MS / 1000),
    recentQueries: nzbStats.recentQueries,
    cachedEntries: getCacheSnapshot(),
  };
}

class VideoSearchModule {
  async searchVideos(query, count, { signal, origin } = {}) {
    if (!ALLOWED_COUNTS.includes(count)) {
      throw new Error(`count must be one of ${ALLOWED_COUNTS.join(', ')}`);
    }

    const startedAt = Date.now();
    const { results, source } = await this._fetchRaw(query, count, { signal });

    // Cloned per-call (even on a cache hit) so _applyLocalStatus's in-place
    // mutation of each entry never corrupts what's sitting in the cache -
    // otherwise a second cache hit would read back whatever DB state was
    // true the first time, not merely be stale by the cache's own TTL.
    const resultsCopy = results.map((r) => ({ ...r }));
    if (resultsCopy.length > 0) await this._applyLocalStatus(resultsCopy);
    this._sortByPublishedAtDesc(resultsCopy);
    logger.info({ query, count, resultCount: resultsCopy.length, source }, 'video search complete');

    if (origin === 'nzb') {
      recordNzbQuery({
        query,
        count,
        source,
        cacheHit: source.endsWith('-cache'),
        resultCount: resultsCopy.length,
        durationMs: Date.now() - startedAt,
      });
    }

    return resultsCopy;
  }

  /**
   * The expensive half of searchVideos - the actual API/yt-dlp round trip -
   * split out so it alone can be cache-wrapped. Returns raw normalized
   * entries with no local DB status applied and no sort order yet.
   * @private
   */
  async _fetchRaw(query, count, { signal }) {
    // Lazy, not top-level: configModule's constructor has side effects
    // (logger.setLevel, a config-file watcher) that every consumer of this
    // module - including its own unit tests, which mock '../logger' with a
    // bare jest.fn() lacking setLevel - would otherwise be forced to also
    // mock just to require this file at all.
    const configModule = require('./configModule');
    // Mirrors the Settings UI's own fallback (NzbSettingsSection.tsx's
    // `nzb.searchCacheMinutes ?? 10`) - that default is cosmetic-only on the
    // frontend (never written back to config.json until the field is
    // actually edited), so an install whose config predates this setting has
    // no searchCacheMinutes key at all. Without an equivalent fallback here,
    // Number(undefined) is NaN and caching silently never activates despite
    // the settings page appearing to show it already on at 10 minutes.
    const rawSearchCacheMinutes = configModule.getConfig().nzb?.searchCacheMinutes;
    const cacheTtlMinutes = rawSearchCacheMinutes === undefined ? 10 : Number(rawSearchCacheMinutes);
    const cacheKey = `${count} ${query}`;

    if (Number.isFinite(cacheTtlMinutes) && cacheTtlMinutes > 0) {
      const cached = rawResultsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        logger.debug({ query, count }, 'video search: using cached raw results, skipping API/yt-dlp fetch');
        return { results: cached.results, source: `${cached.source}-cache` };
      }
    }

    let results = null;
    let source = null;

    if (youtubeApi.isAvailable()) {
      try {
        const apiKey = youtubeApi.getApiKey();
        const apiResults = await youtubeApi.client.searchVideos(apiKey, query, count, { signal });
        results = apiResults;
        source = 'youtube-api';
      } catch (apiErr) {
        if (apiErr?.code === youtubeApi.YoutubeApiErrorCode.CANCELED) {
          throw new SearchCanceledError();
        }
        logger.warn(
          { err: apiErr, query, code: apiErr?.code },
          'YouTube API searchVideos failed, falling back to yt-dlp'
        );
      }
    }

    if (results === null) {
      const args = ytdlpCommandBuilder.buildSearchArgs(query, count);
      let stdout;
      try {
        stdout = await ytDlpRunner.run(args, { timeoutMs: SEARCH_TIMEOUT_MS, signal });
      } catch (err) {
        if (err.name === 'AbortError') throw new SearchCanceledError();
        if (err.code === 'YTDLP_TIMEOUT') throw new SearchTimeoutError();
        throw err;
      }
      results = this._parseNdjson(stdout, query);
      source = 'yt-dlp';
    }

    if (Number.isFinite(cacheTtlMinutes) && cacheTtlMinutes > 0) {
      rawResultsCache.set(cacheKey, {
        results,
        source,
        query,
        count,
        cachedAt: Date.now(),
        expiresAt: Date.now() + cacheTtlMinutes * 60_000,
      });
    }

    return { results, source };
  }

  _parseNdjson(stdout, query) {
    const lines = stdout.split('\n');
    const results = [];
    const seenIds = new Set();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const normalized = this._normalize(entry);
        if (normalized.youtubeId && seenIds.has(normalized.youtubeId)) continue;
        if (normalized.youtubeId) seenIds.add(normalized.youtubeId);
        results.push(normalized);
      } catch (err) {
        logger.warn({ err, query, line: trimmed.slice(0, 200) }, 'skipping unparseable yt-dlp line');
      }
    }
    return results;
  }

  _normalize(entry) {
    const thumbnailUrl = entry.thumbnail
      || (Array.isArray(entry.thumbnails) && entry.thumbnails.length
        ? entry.thumbnails[entry.thumbnails.length - 1].url
        : null);
    const publishedAt = this._derivePublishedAt(entry);
    return {
      youtubeId: entry.id,
      title: entry.title || '',
      channelName: entry.channel || entry.uploader || '',
      channelId: entry.channel_id || null,
      duration: typeof entry.duration === 'number' ? entry.duration : null,
      thumbnailUrl,
      publishedAt,
      viewCount: typeof entry.view_count === 'number' ? entry.view_count : null,
      status: 'never_downloaded',
    };
  }

  _derivePublishedAt(entry) {
    if (typeof entry.timestamp === 'number' && entry.timestamp > 0) {
      return new Date(entry.timestamp * 1000).toISOString();
    }
    if (typeof entry.release_timestamp === 'number' && entry.release_timestamp > 0) {
      return new Date(entry.release_timestamp * 1000).toISOString();
    }
    if (typeof entry.upload_date === 'string' && /^\d{8}$/.test(entry.upload_date)) {
      const y = entry.upload_date.slice(0, 4);
      const m = entry.upload_date.slice(4, 6);
      const d = entry.upload_date.slice(6, 8);
      const iso = `${y}-${m}-${d}T00:00:00.000Z`;
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return null;
  }

  async _applyLocalStatus(results) {
    const youtubeIds = results.map(r => r.youtubeId).filter(Boolean);
    if (youtubeIds.length === 0) return;
    const existing = await Video.findAll({
      where: { youtubeId: youtubeIds },
      attributes: [
        'id',
        'youtubeId',
        'removed',
        'filePath',
        'fileSize',
        'audioFilePath',
        'audioFileSize',
        'last_downloaded_at',
        'protected',
        'normalized_rating',
        'rating_source',
      ],
    });
    const recordByYoutubeId = new Map(existing.map(v => [v.youtubeId, v]));
    for (const r of results) {
      const record = recordByYoutubeId.get(r.youtubeId);
      if (!record) continue;
      r.status = record.removed ? 'missing' : 'downloaded';
      r.databaseId = record.id;
      r.filePath = record.filePath;
      r.fileSize = record.fileSize;
      r.audioFilePath = record.audioFilePath;
      r.audioFileSize = record.audioFileSize;
      r.addedAt = record.last_downloaded_at ? new Date(record.last_downloaded_at).toISOString() : null;
      r.isProtected = Boolean(record.protected);
      r.normalizedRating = record.normalized_rating;
      r.ratingSource = record.rating_source;
    }
  }

  _sortByPublishedAtDesc(results) {
    results.sort((a, b) => {
      if (a.publishedAt && b.publishedAt) {
        return b.publishedAt.localeCompare(a.publishedAt);
      }
      if (a.publishedAt) return -1;
      if (b.publishedAt) return 1;
      return 0;
    });
  }
}

module.exports = new VideoSearchModule();
module.exports.SearchCanceledError = SearchCanceledError;
module.exports.SearchTimeoutError = SearchTimeoutError;
module.exports.ALLOWED_COUNTS = ALLOWED_COUNTS;
module.exports.getNzbStats = getNzbStats;
module.exports.deleteCacheEntries = deleteCacheEntries;
