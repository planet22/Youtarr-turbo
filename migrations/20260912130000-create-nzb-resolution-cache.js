'use strict';
const { createTableIfNotExists, dropTableIfExists } = require('./helpers');

/**
 * Persists nzbThumbnailProbe.js's thumb/extract resolution findings, which
 * previously lived only in an in-memory Map (wiped on every restart, capped
 * at 5000 entries via manual LRU eviction). Deliberately its own table
 * rather than reusing youtube_metadata_cache: that table's rows are surfaced
 * as "untracked" Library entries (videosModule.js's _getUntrackedCandidates)
 * for anything Youtarr has ever fetched real yt-dlp metadata for, and
 * Sonarr/Radarr/Prowlarr's NZB searches probe far more videos than are ever
 * actually downloaded/played - writing there would flood that view with
 * thousands of just-searched, never-touched videos. This table is never
 * joined into the Library query at all.
 *
 * Per-video resolution essentially never changes (barring a rare re-upload),
 * so rows are kept indefinitely rather than time-expired - see
 * nzbThumbnailProbe.js's own doc comment.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfNotExists(queryInterface, 'nzb_resolution_cache', {
      youtube_id: { type: Sequelize.STRING, primaryKey: true, allowNull: false },
      definition: { type: Sequelize.ENUM('hd', 'sd'), allowNull: false },
      height_tier: { type: Sequelize.INTEGER, allowNull: true },
      source: { type: Sequelize.ENUM('thumb', 'extract'), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
  },
  async down(queryInterface) {
    await dropTableIfExists(queryInterface, 'nzb_resolution_cache');
  },
};
