'use strict';
const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

/**
 * Persisted audit trail for ytstream playback sessions (server/routes/ytstream.js's
 * trackStream/untrackStream), so what got streamed and when survives past
 * server restarts and the in-memory activeStreams Map. One row per stream
 * session ("stream_id" = the HLS session key, or the per-request UUID for
 * mode=ffmpeg) - inserted when the stream starts, updated with an end time/
 * reason/error once it stops. mode=direct is never tracked here, same as
 * the live Streaming page - it's a stateless proxy with no session concept.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfNotExists(queryInterface, 'stream_history', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      stream_id: { type: Sequelize.STRING, allowNull: false, unique: true },
      youtube_id: { type: Sequelize.STRING, allowNull: false },
      mode: { type: Sequelize.ENUM('hls', 'ffmpeg'), allowNull: false },
      quality: { type: Sequelize.STRING, allowNull: true },
      container: { type: Sequelize.STRING, allowNull: true },
      transcode: { type: Sequelize.STRING, allowNull: true },
      hardware_mode: { type: Sequelize.STRING, allowNull: true },
      client_ip: { type: Sequelize.STRING, allowNull: true },
      user_agent: { type: Sequelize.STRING(512), allowNull: true },
      started_at: { type: Sequelize.DATE, allowNull: false },
      ended_at: { type: Sequelize.DATE, allowNull: true },
      bytes_transferred: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      end_reason: { type: Sequelize.STRING, allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    await addIndexIfMissing(queryInterface, 'stream_history', ['youtube_id'], {
      name: 'stream_history_youtube_id_idx',
    });
    await addIndexIfMissing(queryInterface, 'stream_history', ['started_at'], {
      name: 'stream_history_started_at_idx',
    });
  },
  async down(queryInterface) {
    await dropTableIfExists(queryInterface, 'stream_history');
  },
};
