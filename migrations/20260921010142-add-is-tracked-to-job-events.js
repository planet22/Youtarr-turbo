'use strict';
const { addColumnIfMissing, removeColumnIfExists, addIndexIfMissing, removeIndexIfExists } = require('./helpers');

/**
 * Whether the video had a row in the library (was "tracked") at the moment an
 * event was recorded. Captured at write time, like everything else on a
 * job_events row: reading it later cannot answer this, because an imported NZB
 * grab's Video row is deleted afterwards. NULL means it was not known then
 * (including every row written before this column existed).
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'job_events', 'is_tracked', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
    await addIndexIfMissing(queryInterface, 'job_events', ['is_tracked'], {
      name: 'job_events_is_tracked_idx',
    });
  },
  async down(queryInterface) {
    await removeIndexIfExists(queryInterface, 'job_events', 'job_events_is_tracked_idx');
    await removeColumnIfExists(queryInterface, 'job_events', 'is_tracked');
  },
};
