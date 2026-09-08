'use strict';

const {
  addColumnIfMissing,
  removeColumnIfExists,
} = require('./helpers');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    // How long the actual download+post-process took for this video, and
    // the resulting average throughput - see
    // server/modules/download/videoMetadataProcessor.js. Nullable: only set
    // once a real file was verified AND a matching JobVideoDownload start
    // timestamp was found (e.g. never for STRM-only rows, and not for rows
    // that predate this column).
    await addColumnIfMissing(queryInterface, 'Videos', 'downloadDurationSeconds', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'Videos', 'avgDownloadMBps', {
      type: Sequelize.FLOAT,
      allowNull: true,
    });

    // The exact yt-dlp argv used for this job, space-joined - see
    // server/modules/download/downloadExecutor.js. Debugging aid only (e.g.
    // "why did this job's format selector pick this codec"); never parsed
    // back out programmatically.
    await addColumnIfMissing(queryInterface, 'Jobs', 'ytdlpCommand', {
      type: Sequelize.TEXT('medium'),
      allowNull: true,
    });
  },

  async down (queryInterface) {
    await removeColumnIfExists(queryInterface, 'Videos', 'downloadDurationSeconds');
    await removeColumnIfExists(queryInterface, 'Videos', 'avgDownloadMBps');
    await removeColumnIfExists(queryInterface, 'Jobs', 'ytdlpCommand');
  }
};
