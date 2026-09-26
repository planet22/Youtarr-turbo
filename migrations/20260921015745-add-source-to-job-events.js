'use strict';
const { addColumnIfMissing, removeColumnIfExists, addIndexIfMissing, removeIndexIfExists } = require('./helpers');
const { sourceLabelForJobType } = require('../server/modules/jobEventLog/sourceLabels');

/**
 * The source label (Channels, Playlists, NZB (TV), ...) of the job an event
 * belongs to, written when the event is recorded like every other column on a
 * job_events row. Rows that already exist get it filled in once here from
 * their stored job_type; NULL means the event has no job.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'job_events', 'source', {
      type: Sequelize.STRING(96),
      allowNull: true,
    });
    await addIndexIfMissing(queryInterface, 'job_events', ['source'], {
      name: 'job_events_source_idx',
    });

    const [rows] = await queryInterface.sequelize.query(
      'SELECT DISTINCT job_type FROM job_events WHERE job_type IS NOT NULL AND source IS NULL'
    );
    for (const { job_type: jobType } of rows) {
      await queryInterface.sequelize.query(
        'UPDATE job_events SET source = :source WHERE job_type = :jobType AND source IS NULL',
        { replacements: { source: sourceLabelForJobType(jobType), jobType } }
      );
    }
  },
  async down(queryInterface) {
    await removeIndexIfExists(queryInterface, 'job_events', 'job_events_source_idx');
    await removeColumnIfExists(queryInterface, 'job_events', 'source');
  },
};
