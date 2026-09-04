'use strict';
const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

/**
 * Persistent cache of cheap-but-not-free YouTube metadata (currently just
 * duration) for videos that have no Video library row to read it from -
 * untracked NZB grabs and plain played-once-but-never-downloaded videos.
 * server/routes/ytstream.js's getVideoDurationSeconds already has an
 * in-memory Map for this, but that's wiped on every server restart and
 * re-fetches (a live yt-dlp `--print duration` call) on the very next play.
 * This table survives restarts AND survives the video's own on-disk cache
 * being purged - the point is to never have to ask yt-dlp for the same
 * video's duration twice, for as long as anyone keeps re-watching it.
 * Swept on a long, fixed retention (see cronJobs.js) rather than tied to
 * any per-video disk cache lifetime.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfNotExists(queryInterface, 'youtube_metadata_cache', {
      youtube_id: { type: Sequelize.STRING, primaryKey: true, allowNull: false },
      duration_seconds: { type: Sequelize.INTEGER, allowNull: false },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      last_accessed_at: { type: Sequelize.DATE, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    await addIndexIfMissing(queryInterface, 'youtube_metadata_cache', ['last_accessed_at'], {
      name: 'youtube_metadata_cache_last_accessed_at_idx',
    });
  },
  async down(queryInterface) {
    await dropTableIfExists(queryInterface, 'youtube_metadata_cache');
  },
};
