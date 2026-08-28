const { sequelize } = require('../db');
const Video = require('../models/video');
const Channel = require('../models/channel');
const logger = require('../logger');

/**
 * Resolves season/episode numbers for TV Series library mode.
 *
 * Season is the calendar year of a video's upload_date - always derivable
 * synchronously, no DB lookup needed. Episode number is a per-channel,
 * per-season sequential count that does need DB state, and is frozen once
 * assigned: a video keeps its first-assigned episode number forever, even
 * across retries or out-of-order backfills. This avoids ever having to
 * rewrite sibling NFOs (which would risk losing genre/tag data that is
 * only persisted in NFO files today, not in the Video table).
 */
class SeriesEpisodeResolver {
  /**
   * Pure, synchronous. Used for both path construction and NFO content.
   * @param {string|number|null} uploadDateYYYYMMDD
   * @returns {number|null}
   */
  deriveSeasonYear(uploadDateYYYYMMDD) {
    if (!uploadDateYYYYMMDD || String(uploadDateYYYYMMDD).length < 4) return null;
    const year = parseInt(String(uploadDateYYYYMMDD).slice(0, 4), 10);
    return Number.isFinite(year) ? year : null;
  }

  /**
   * Async, DB-backed, transactional. Returns the frozen episode number for
   * a video, assigning one (COUNT of existing videos in this channel+season,
   * plus 1) the first time it's called for that video.
   *
   * channelId must already be the resolved owning channel id from the
   * caller's own channel-attribution logic - this never re-derives
   * ownership itself, to avoid diverging from each pipeline's existing
   * VEVO/Topic-aware channel resolution.
   *
   * @param {{channelId: string|null, youtubeId: string, season: number}} params
   * @returns {Promise<number>}
   */
  async resolveEpisodeNumber({ channelId, youtubeId, season }) {
    return sequelize.transaction(async (t) => {
      const existing = await Video.findOne({
        where: { youtubeId },
        attributes: ['season', 'episode'],
        transaction: t,
      });
      if (existing && existing.episode != null && existing.season === season) {
        return existing.episode;
      }

      // Per-channel mutex: locks the channel row so concurrent finalize runs
      // for the same channel (e.g. overlapping download jobs) serialize
      // their count-then-assign step and never hand out the same episode
      // number twice.
      if (channelId) {
        await Channel.findOne({
          where: { channel_id: channelId },
          attributes: ['id'],
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
      }

      const count = await Video.count({
        where: { channel_id: channelId, season, removed: false },
        transaction: t,
      });
      const episode = count + 1;
      logger.info({ channelId, youtubeId, season, episode }, 'Series library mode: assigned episode number');
      return episode;
    });
  }
}

module.exports = new SeriesEpisodeResolver();
