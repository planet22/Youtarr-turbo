'use strict';

/**
 * stream_history.mode was a strict ENUM('hls', 'ffmpeg') because only those
 * two modes were ever tracked (see 20260827020000-create-stream-history.js's
 * own doc comment: "mode=direct is never tracked here... it's a stateless
 * proxy with no session concept"). ytstream.js now also tracks/history-logs
 * direct, direct-pipe, and direct-redirect, and a strict ENUM means every
 * future mode addition needs its own migration - widened to a plain STRING
 * to match every other descriptive column on this table (quality/container/
 * transcode/hardware_mode/end_reason are all STRING, not ENUM).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('stream_history', 'mode', {
      type: Sequelize.STRING(32),
      allowNull: false,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('stream_history', 'mode', {
      type: Sequelize.ENUM('hls', 'ffmpeg'),
      allowNull: false,
    });
  },
};
