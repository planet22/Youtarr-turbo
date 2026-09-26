'use strict';
const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

/**
 * Append-only event log behind the video/events history (server/modules/
 * jobEventLog). One row per step in a video's or job's life - queued,
 * started, downloaded, failed, imported, deleted, ... - written once at the
 * moment it happens and never updated, so history cannot drift the way the
 * Download History table does (that one recomputes status text from live
 * Jobs/Videos state on every read).
 *
 * Deliberately no foreign keys: rows must outlive the Jobs/Videos rows they
 * describe (compacting job history or untracking a video must not erase what
 * happened). video_title/channel_name/job_type are therefore a snapshot taken
 * at write time, so a row stays readable after its Video or Job row is gone.
 *
 * occurred_at is DATETIME(3) - the app stamps it from Date.now() at the call
 * site, and closely spaced steps (an import, a history-delete, an untrack)
 * routinely land within the same second (see the stream_history precision
 * migration for the same reasoning).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfNotExists(queryInterface, 'job_events', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      occurred_at: { type: Sequelize.DATE(3), allowNull: false },
      job_id: { type: Sequelize.STRING(36), allowNull: true },
      youtube_id: { type: Sequelize.STRING(20), allowNull: true },
      event_type: { type: Sequelize.STRING(64), allowNull: false },
      level: { type: Sequelize.STRING(8), allowNull: false, defaultValue: 'info' },
      actor: { type: Sequelize.STRING(48), allowNull: true },
      message: { type: Sequelize.STRING(512), allowNull: false },
      detail: { type: Sequelize.TEXT('medium'), allowNull: true },
      video_title: { type: Sequelize.STRING(512), allowNull: true },
      channel_name: { type: Sequelize.STRING(255), allowNull: true },
      job_type: { type: Sequelize.STRING(255), allowNull: true },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    // Per-job timeline, per-video timeline, type filter, and the retention
    // prune / newest-first log page all filter on one of these plus id or time.
    await addIndexIfMissing(queryInterface, 'job_events', ['job_id', 'id'], {
      name: 'job_events_job_id_id_idx',
    });
    await addIndexIfMissing(queryInterface, 'job_events', ['youtube_id', 'id'], {
      name: 'job_events_youtube_id_id_idx',
    });
    await addIndexIfMissing(queryInterface, 'job_events', ['event_type', 'id'], {
      name: 'job_events_event_type_id_idx',
    });
    await addIndexIfMissing(queryInterface, 'job_events', ['occurred_at'], {
      name: 'job_events_occurred_at_idx',
    });
  },
  async down(queryInterface) {
    await dropTableIfExists(queryInterface, 'job_events');
  },
};
