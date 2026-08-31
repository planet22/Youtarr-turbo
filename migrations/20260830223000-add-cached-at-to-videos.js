'use strict';

/**
 * Tracks when a video was materialized from STRM into a real file via STRM
 * cache-on-play (server/modules/strmCacheOnPlay.js) - set only for that one
 * transition (see videoPersistence.js's upsertVideoForJob, gated on the
 * triggering job's type carrying strmCacheOnPlay's STRM_CACHE_LABEL_PREFIX),
 * never for a genuine/forced download that was never STRM to begin with.
 * Powers a scheduled sweep (videoDeletionModule.sweepExpiredCachedVideos,
 * registered in cronJobs.js) that reverts a cached video back to STRM once
 * it's older than strm.cacheOnPlayExpiryHours, so an opportunistic cache
 * doesn't silently become a permanent download.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Videos', 'cached_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('Videos', 'cached_at');
  },
};
