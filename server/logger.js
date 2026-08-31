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
 */
const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

const pinoConfig = {
  level: logLevel,

  // Use pino-pretty
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l o',
      ignore: 'pid,hostname',
      singleLine: true, // Keep structured data as compact JSON
      messageFormat: '{if req.id}[{req.id}] {end}{msg}'
    }
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
