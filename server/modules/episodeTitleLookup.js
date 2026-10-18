const axios = require('axios');
const logger = require('../logger');

const SKYHOOK_BASE_URL = 'https://skyhook.sonarr.tv/v1/tvdb';
// Skyhook rejects axios' default User-Agent.
const USER_AGENT = 'Youtarr';
const REQUEST_TIMEOUT_MS = 8000;
const HIT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

function normalizeName(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Resolves a series + season/episode number to the episode's title through
 * Sonarr's Skyhook (TVDB) metadata proxy. Sonarr sends only the series name
 * and numbers on a tvsearch, but archive TV on YouTube is titled by episode
 * name, so the title is what makes an episode search findable.
 * Fail-soft: any error resolves to null.
 */
class EpisodeTitleLookup {
  constructor() {
    this.cache = new Map();
  }

  _getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  _setCached(key, value) {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { value, expires: Date.now() + (value ? HIT_TTL_MS : MISS_TTL_MS) });
  }

  async _get(url, params) {
    const res = await axios.get(url, {
      params,
      timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    return res.data;
  }

  async _resolveTvdbId(series) {
    const results = await this._get(`${SKYHOOK_BASE_URL}/search/en/`, { term: series });
    if (!Array.isArray(results) || results.length === 0) return null;
    const wanted = normalizeName(series);
    const match = results.find((r) => normalizeName(r.title) === wanted);
    return (match || results[0]).tvdbId || null;
  }

  /**
   * @returns {Promise<string|null>} the episode title, or null when unknown.
   */
  async lookup({ series, tvdbid, season, ep }) {
    if (season == null || ep == null || (!tvdbid && !series)) return null;
    const key = `${tvdbid || normalizeName(series)}|${season}|${ep}`;
    const cached = this._getCached(key);
    if (cached !== undefined) return cached;

    let title = null;
    try {
      const id = tvdbid || await this._resolveTvdbId(series);
      if (id) {
        const show = await this._get(`${SKYHOOK_BASE_URL}/shows/en/${encodeURIComponent(id)}`);
        const episode = (show && show.episodes || []).find(
          (e) => e.seasonNumber === season && e.episodeNumber === ep
        );
        title = episode && episode.title ? String(episode.title).trim() : null;
      }
    } catch (err) {
      logger.warn({ err, series, tvdbid, season, ep }, 'nzb: episode title lookup failed');
      return null;
    }
    this._setCached(key, title);
    return title;
  }
}

module.exports = new EpisodeTitleLookup();
