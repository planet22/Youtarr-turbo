const logger = require('../logger');
const videoSearchModule = require('./videoSearchModule');

// Radarr/Sonarr's indexer Test (and RSS sync) send a query-less request and
// treat an empty feed as a failed indexer. When Youtarr has no known channel
// videos to answer with, a live YouTube search for a generic term stands in
// for an upstream "recent items" feed. videoSearchModule caches the search, so
// repeated RSS polls don't re-run yt-dlp.
const LIVE_FEED_COUNT = 10;
const LIVE_FEED_TERMS = {
  movie: 'full movie',
  tvsearch: 'full episode',
  search: 'new',
};
const DEFAULT_TERM = LIVE_FEED_TERMS.search;

class NzbRssFeed {
  /**
   * Live results to top up a blank-query feed. Never throws: a failed search
   * just yields no extra items.
   * @param {string} searchType - newznab `t` value
   * @param {Set<string>} excludeIds - youtube ids already in the feed
   * @param {number} needed - how many more items the feed can take
   * @returns {Promise<Array<{youtubeId:string,title:string,publishedAt:*,duration:*}>>}
   */
  async getLiveFill(searchType, excludeIds, needed) {
    if (needed <= 0) return [];
    const term = LIVE_FEED_TERMS[searchType] || DEFAULT_TERM;
    try {
      // No `origin: 'nzb'` - feed polls shouldn't clutter Recent Queries.
      const found = await videoSearchModule.searchVideos(term, LIVE_FEED_COUNT);
      return found
        .filter((r) => r.youtubeId && !excludeIds.has(r.youtubeId))
        .slice(0, needed)
        .map((r) => ({
          youtubeId: r.youtubeId,
          title: r.title,
          publishedAt: r.publishedAt,
          duration: r.duration,
          definition: r.definition,
        }));
    } catch (err) {
      logger.warn({ err, term }, 'nzbRssFeed: live feed search failed');
      return [];
    }
  }
}

module.exports = new NzbRssFeed();
