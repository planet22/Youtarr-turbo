/**
 * server/modules/ytstream/streamDebug.js
 *
 * ytstream.debugLogging: ytstream's per-request/per-segment diagnostic
 * lines (segment serves, playlist polls, buffer-fetch progress ticks, etc.)
 * are genuinely too high-volume for logger.info by default, but gating them
 * behind the global Log Level=debug setting also turns on every OTHER
 * module's debug output (most visibly databaseHealthModule's ~15s health
 * check line) - unrelated noise with no way to see just ytstream's own
 * traffic. This flag decouples the two: off (default), behaves exactly like
 * logger.debug always has; on, these specific lines print at info instead,
 * regardless of the global Log Level, without touching any other module's
 * verbosity. Read live per call (same pattern as every other config.ytstream
 * field), so it takes effect immediately, no restart.
 */
const logger = require('../../logger');
const configModule = require('../configModule');

function streamDebug(obj, msg) {
  if ((configModule.getConfig().ytstream || {}).debugLogging === true) {
    logger.info(obj, msg);
  } else {
    logger.debug(obj, msg);
  }
}

module.exports = { streamDebug };
