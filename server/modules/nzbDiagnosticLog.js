const logger = require('../logger');

// Shared read/write/prune for the nzb_diagnostic_log table - backs the NZB
// diagnostics page's Recent Queries (videoSearchModule.js), Search Filter
// Debug traces, and Failed Grabs (both nzb.js) tables. Previously each of
// those was its own capped in-memory array, wiped on every restart; this
// gives all three the same persisted-and-capped behavior via one table
// (see the create-nzb-diagnostic-log migration's doc comment for why one
// table). Deliberately NOT used for the raw-results search cache - that's a
// TTL'd cache, not a log, and stays in-memory on purpose.

async function recordDiagnosticEvent(kind, payload, max) {
  try {
    const { NzbDiagnosticLog } = require('../models');
    await NzbDiagnosticLog.create({ kind, payload: JSON.stringify(payload) });

    // Lazy prune on every write rather than a timer, same approach as
    // videoSearchModule's cache eviction - traffic here is bursty/sparse
    // (Sonarr/Radarr/Prowlarr poll cadence), so an extra count+delete per
    // write is negligible and there's no need for a separate cron-like job.
    const count = await NzbDiagnosticLog.count({ where: { kind } });
    if (count > max) {
      const stale = await NzbDiagnosticLog.findAll({
        where: { kind },
        attributes: ['id'],
        order: [['id', 'ASC']],
        limit: count - max,
      });
      await NzbDiagnosticLog.destroy({ where: { id: stale.map((row) => row.id) } });
    }
  } catch (err) {
    // Diagnostics must never break the actual search/grab flow they're
    // observing - log and move on.
    logger.warn({ err, kind }, 'nzb: failed to persist diagnostic log entry');
  }
}

async function getDiagnosticEvents(kind, max) {
  try {
    const { NzbDiagnosticLog } = require('../models');
    const rows = await NzbDiagnosticLog.findAll({
      where: { kind },
      order: [['id', 'DESC']],
      limit: max,
    });
    return rows.map((row) => JSON.parse(row.payload));
  } catch (err) {
    logger.warn({ err, kind }, 'nzb: failed to read diagnostic log entries');
    return [];
  }
}

module.exports = { recordDiagnosticEvent, getDiagnosticEvents };
