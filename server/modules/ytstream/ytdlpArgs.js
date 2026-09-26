/**
 * server/modules/ytstream/ytdlpArgs.js
 *
 * Small yt-dlp/ffmpeg request-building primitives shared across ytstream's
 * playback modes - extracted from server/routes/ytstream.js so they're a
 * real importable module instead of trapped in that file's private route-
 * factory closure.
 */
const fs = require('fs');
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');
const YtdlpCommandBuilder = require('../download/ytdlpCommandBuilder');
const { DEFAULT_PLAYER_CLIENT } = require('./configResolution');

const UPSTREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Shared yt-dlp base argument set (cookies/proxy/rate-limit/player-client)
 * for every ytstream playback mode's own yt-dlp invocation - direct-family's
 * one-shot `-g` resolve, the duration/codec/height probes, and the HLS
 * engine's video/audio feeder processes all build on this.
 */
function buildBaseArgs(config, opts = {}) {
  // buildCommonArgs() already appends `--cookies <path>` via
  // configModule.getCookiesPath() internally - don't add it again here,
  // yt-dlp rejects a duplicate --cookies flag.
  const args = YtdlpCommandBuilder.buildCommonArgs(config, { skipSleepRequests: true });

  const ytCfg = config.ytstream || {};
  const playerClient = opts.playerClient || ytCfg.playerClient || DEFAULT_PLAYER_CLIENT;
  args.push('--extractor-args', `youtube:player_client=${playerClient}`);

  // Power-user network tuning (Settings -> Streaming). 0/unset means
  // "don't pass the flag" for every field here - yt-dlp's own default
  // applies. httpChunkSizeMiB/concurrentFragments only matter for modes
  // that actually stream media bytes through yt-dlp (hls/hls-buffer);
  // harmless no-ops on direct/direct-redirect's one-shot -g resolve calls,
  // which every buildBaseArgs caller (including those) shares this
  // helper with.
  const httpChunkSizeMiB = Number(ytCfg.httpChunkSizeMiB);
  if (Number.isFinite(httpChunkSizeMiB) && httpChunkSizeMiB > 0) {
    args.push('--http-chunk-size', `${httpChunkSizeMiB}M`);
  }

  const concurrentFragments = Number(ytCfg.concurrentFragments);
  if (Number.isFinite(concurrentFragments) && concurrentFragments > 1) {
    args.push('--concurrent-fragments', String(concurrentFragments));
  }

  const throttledRateKBps = Number(ytCfg.throttledRateKBps);
  if (Number.isFinite(throttledRateKBps) && throttledRateKBps > 0) {
    args.push('--throttled-rate', `${throttledRateKBps}K`);
  }

  const socketTimeoutSeconds = Number(ytCfg.socketTimeoutSeconds);
  if (Number.isFinite(socketTimeoutSeconds) && socketTimeoutSeconds > 0) {
    args.push('--socket-timeout', String(socketTimeoutSeconds));
  }

  return args;
}

const HTTP_ONLY_PREFIX = '#HttpOnly_';

/**
 * Parse a Netscape cookie file into a Cookie header value for YouTube/
 * googlevideo requests. yt-dlp -g URLs often 403 in ffmpeg without the
 * same session cookies attached.
 * @param {string|null} cookiePath
 * @returns {string} e.g. "SID=...; HSID=..." or ""
 */
function loadYoutubeCookieHeader(cookiePath) {
  streamDebug({ cookiePath }, 'ytstream: loading cookie file for ffmpeg headers');
  if (!cookiePath) return '';
  try {
    if (!fs.existsSync(cookiePath)) return '';
    const lines = fs.readFileSync(cookiePath, 'utf8').split(/\r?\n/);
    const pairs = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Netscape files mark HttpOnly cookies as "#HttpOnly_<domain>"; every
      // other line starting with # is a comment.
      const isHttpOnly = trimmed.startsWith(HTTP_ONLY_PREFIX);
      if (trimmed.startsWith('#') && !isHttpOnly) continue;
      // Netscape: domain \t flag \t path \t secure \t expiry \t name \t value
      // Split the untrimmed line: an empty value leaves a trailing tab that
      // trim() would strip, dropping the seventh column.
      const parts = line.trimStart().split('\t');
      if (isHttpOnly) parts[0] = parts[0].slice(HTTP_ONLY_PREFIX.length);
      if (parts.length < 7) continue;
      const domain = parts[0].replace(/^\./, '').toLowerCase();
      if (
        !domain.includes('youtube.com') &&
        !domain.includes('google.com') &&
        !domain.includes('googlevideo.com') &&
        !domain.includes('youtu.be')
      ) {
        continue;
      }
      const name = parts[5];
      const value = parts[6];
      if (name) pairs.push(`${name}=${value}`);
    }
    return pairs.join('; ');
  } catch (err) {
    logger.warn({ err }, 'ytstream: failed to read cookie file for ffmpeg headers');
    return '';
  }
}

module.exports = { UPSTREAM_USER_AGENT, loadYoutubeCookieHeader, buildBaseArgs };
