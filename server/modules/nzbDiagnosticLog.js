const logger = require('../logger');

// Mirrors client/src/config/configSchema.ts's nzb.diagnosticLogLimits default
// and clamp range - kept here since this is the module both call sites
// (server/routes/nzb.js, server/modules/videoSearchModule.js) already go
// through to read/write these logs.
const DEFAULT_LOG_LIMITS = { recentQueries: 50, searchTraces: 20, failedGrabs: 20 };

function resolveLogLimit(cfg, key) {
  const raw = cfg?.nzb?.diagnosticLogLimits?.[key];
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LOG_LIMITS[key];
  return Math.min(100, Math.max(1, Math.round(n)));
}

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

// The three kinds this table holds - see recordDiagnosticEvent's callers in
// nzb.js/videoSearchModule.js. Settings UI's "Diagnostic Log Limits" clear
// button resets all three together, since they're presented there as one
// group of settings.
const ALL_KINDS = ['query', 'trace', 'failedGrab'];

/** Total rows across all three log kinds - Settings UI's row count. */
async function countAllDiagnosticEvents() {
  const { NzbDiagnosticLog } = require('../models');
  return NzbDiagnosticLog.count({ where: { kind: ALL_KINDS } });
}

/** Bulk clear-all - Settings UI's "Clear Diagnostic Logs" button. */
async function clearAllDiagnosticEvents() {
  const { NzbDiagnosticLog } = require('../models');
  return NzbDiagnosticLog.destroy({ where: { kind: ALL_KINDS } });
}

module.exports = {
  recordDiagnosticEvent,
  getDiagnosticEvents,
  resolveLogLimit,
  countAllDiagnosticEvents,
  clearAllDiagnosticEvents,
};
