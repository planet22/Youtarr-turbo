'use strict';

/**
 * StreamHistoryTable/StreamHistoryCard's "Started"/"Duration" columns render
 * millisecond precision (formatStarted/formatDuration in
 * client/src/components/StreamingPage/components/StreamHistoryTable.tsx) so
 * that closely-spaced sessions - e.g. a probe-shortcut burst - can be told
 * apart. That only works if the stored timestamps actually carry
 * milliseconds: plain MySQL DATETIME truncates to whole seconds, so every
 * row was rendering ".000" regardless of when it actually started/ended.
 * DATETIME(3) keeps millisecond precision; the app already writes JS Date
 * objects (Date.now()/new Date()) which have millisecond resolution, so no
 * application-code change is needed, just the wider column type.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('stream_history', 'started_at', {
      type: Sequelize.DATE(3),
      allowNull: false,
    });
    await queryInterface.changeColumn('stream_history', 'ended_at', {
      type: Sequelize.DATE(3),
      allowNull: true,
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('stream_history', 'started_at', {
      type: Sequelize.DATE,
      allowNull: false,
    });
    await queryInterface.changeColumn('stream_history', 'ended_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
};
