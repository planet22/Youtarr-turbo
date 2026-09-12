'use strict';
const { createTableIfNotExists, dropTableIfExists, addIndexIfMissing } = require('./helpers');

/**
 * Persisted, capped log backing the NZB diagnostics page's "Recent Queries",
 * "Search Filter Debug" traces, and "Failed Grabs" tables (server/modules/
 * videoSearchModule.js's recordNzbQuery, server/routes/nzb.js's
 * recordSearchTrace/recordFailedGrab) - these previously lived in plain
 * in-memory arrays and were wiped on every restart. One table for all three
 * kinds (distinguished by `kind`, with the original object serialized into
 * `payload`) rather than three tables, since the shapes are diagnostics-only
 * (never joined/filtered on individual fields) and this avoids three near-
 * identical migrations. Deliberately excludes the raw-results search cache
 * (rawResultsCache in videoSearchModule.js) - that's a TTL'd cache, not a
 * log, and stays in-memory on purpose.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await createTableIfNotExists(queryInterface, 'nzb_diagnostic_log', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      kind: { type: Sequelize.ENUM('query', 'trace', 'failedGrab'), allowNull: false },
      payload: { type: Sequelize.TEXT('medium'), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    }, { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    // Every read is "last N rows of this kind" and every prune is "delete
    // the oldest rows of this kind past N" - both filter on kind and order
    // by id, so a composite index on exactly that pair is what both queries
    // actually use.
    await addIndexIfMissing(queryInterface, 'nzb_diagnostic_log', ['kind', 'id'], {
      name: 'nzb_diagnostic_log_kind_id_idx',
    });
  },
  async down(queryInterface) {
    await dropTableIfExists(queryInterface, 'nzb_diagnostic_log');
  },
};
