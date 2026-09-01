const pino = require('pino');

/**
 * Pino logger configuration for Youtarr backend.
 *
 * Features:
 * - Configurable log level via LOG_LEVEL env var (default: info)
 * - Pretty printing in development for readability
 * - JSON structured logs in production
 * - Sensitive data redaction (passwords, tokens, API keys)
 * - Request correlation via request IDs
 * - Mirrored to rolling files under the existing config volume (see
 *   LOG_FILE_PATH below) so logs are readable directly from the host
 *   filesystem, not just via `docker logs` - reuses the
 *   ${CONFIG_ROOT}/config bind mount that's already there for config.json,
 *   same "subfolder of config" precedent as configModule.js's
 *   /app/config/temp_downloads.
 */
const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Overridable for non-Docker/dev runs (defaults to the container path, which
// only exists when /app/config is actually the mounted volume) - LOG_FILE_PATH
// lets a bare `node server.js` or a differently-laid-out host point elsewhere.
// pino-roll appends its own rotation/date suffix to this (e.g.
// youtarr.1.log) - see LOG_FILE_MAX_SIZE/LOG_FILE_MAX_COUNT below for the
// rotation policy; it also creates the directory itself (mkdir: true), so
// nothing here needs to pre-create /app/config/logs.
const logFilePath = process.env.LOG_FILE_PATH || '/app/config/logs/youtarr.log';
// Rotate at 10MB, keep 5 rotated files plus the active one (~60MB ceiling) -
// matches the cap a Docker json-file logging driver would give for free,
// picked for the same reason: bounded disk use on a long-running NAS
// install without needing to babysit it.
const logFileMaxSize = process.env.LOG_FILE_MAX_SIZE || '10m';
const logFileMaxCount = Number.parseInt(process.env.LOG_FILE_MAX_COUNT, 10) || 5;

const pinoConfig = {
  level: logLevel,

  // Pretty-printed to stdout (docker logs / dev console) and mirrored as
  // plain newline-delimited JSON to rolling files at logFilePath - same log
  // record, two destinations, each with their own formatting needs. Both
  // targets are deliberately pinned to 'trace' (pino's lowest level, i.e.
  // "don't filter anything further here") rather than `logLevel` - a
  // per-target level is fixed at startup and does NOT track setLevel()'s
  // later runtime changes to the root logger, so pinning it low keeps the
  // root logger.level check below as the only gate, which is what
  // setLevel() actually updates live.
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        level: 'trace',
        options: {
          colorize: true,
          translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l o',
          ignore: 'pid,hostname',
          singleLine: true, // Keep structured data as compact JSON
          messageFormat: '{if req.id}[{req.id}] {end}{msg}',
          destination: 1, // stdout
        },
      },
      {
        target: 'pino-roll',
        level: 'trace',
        options: {
          file: logFilePath,
          size: logFileMaxSize,
          limit: { count: logFileMaxCount },
          mkdir: true,
        },
      },
    ],
  },

  // Redact sensitive data from logs
  redact: {
    paths: [
      // Authentication
      'password',
      'passwordHash',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',

      // Tokens and keys
      'token',
      'authToken',
      'plexAuthToken',
      'session_token',
      'plexApiKey',
      'plexPlaylistToken',
      'jellyfinApiKey',
      'embyApiKey',
      'youtubeApiKey',
      'req.body.apiKey',
      'req.headers.authorization',
      'req.headers["x-access-token"]',
      'req.headers["x-api-key"]',
      'authorization',

      // Cookies
      'cookie',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
    remove: true // Completely remove instead of replacing with [Redacted]
  },

  // Add custom serializers
  serializers: {
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
    err: pino.stdSerializers.err,
  },

  // Base fields for all logs
  base: {
    pid: process.pid,
  },
};

const logger = pino(pinoConfig);

const VALID_LOG_LEVELS = new Set(['warn', 'info', 'debug']);

/**
 * Overrides the logger's level at runtime (see configModule.js's
 * updateConfig, which calls this whenever the top-level `logLevel` Settings
 * field changes) - pino's own `.level` is a live, mutable property, so this
 * takes effect immediately for every log call from this point on, no
 * container restart/recreate needed (unlike the LOG_LEVEL environment
 * variable, which is only read once at startup - see the module comment
 * above). A falsy/invalid value reverts to whatever LOG_LEVEL was set to
 * at startup (or 'info' if that was unset too), i.e. back to this module's
 * own original default.
 */
function setLevel(level) {
  const normalized = typeof level === 'string' ? level.toLowerCase() : level;
  logger.level = VALID_LOG_LEVELS.has(normalized) ? normalized : logLevel;
}

// Export logger instance
module.exports = logger;
module.exports.setLevel = setLevel;
