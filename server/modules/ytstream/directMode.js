/**
 * server/modules/ytstream/directMode.js
 *
 * `mode=direct`/`mode=direct-redirect`: resolve a playable URL via yt-dlp
 * and either proxy the bytes through this server or send the player a 302
 * straight to it. Also home to the upstream-header/logging-redaction
 * helpers `buildFfmpegUpstreamHeaders`/`redactFfArgsForLogging` (also used
 * by the HLS engine's own seek-restart direct-URL fetch) and
 * `redactIncomingHeadersForLogging` (used by the main route handler's
 * incoming-request log for every mode, not just direct). Extracted from
 * server/routes/ytstream.js so it's a real importable module instead of
 * trapped in that file's private route-factory closure.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const logger = require('../../logger');
const ytDlpRunner = require('../ytDlpRunner');
const { UPSTREAM_USER_AGENT, buildBaseArgs } = require('./ytdlpArgs');
const { getDirectFormatSelector } = require('./formatSelection');
const { RETRY_PLAYER_CLIENT, isRetryableExtractionError } = require('./configResolution');
const { persistStreamHistoryStart, persistStreamHistoryEnd } = require('./activeStreams');
const { streamDebug } = require('./streamDebug');

function isManifestUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('://googlevideo.com') ||
    u.includes('.m3u8') ||
    u.includes('/api/manifest/')
  );
}

async function resolveDirectUrl(youtubeId, config, quality, forcedPlayerClient, qualityStrictness) {
  const format = getDirectFormatSelector(quality, qualityStrictness);
  const runOnce = async (playerClient) => {
    const args = [
      ...buildBaseArgs(config, { playerClient }),
      '-f', format,
      '-g',
      '--no-playlist',
      '--no-warnings',
      `https://youtube.com/watch?v=${youtubeId}`,
    ];
    logger.info({ youtubeId, format, quality, playerClient }, 'ytstream: resolving direct URL via yt-dlp');
    return ytDlpRunner.run(args, { timeoutMs: 90000 });
  };

  let stdout;
  let usedRetryClient = false;
  try {
    stdout = await runOnce(forcedPlayerClient);
  } catch (err) {
    if (!forcedPlayerClient && isRetryableExtractionError(err.message)) {
      logger.warn(
        { youtubeId, err: err.message },
        `ytstream: direct resolve hit a client/session error, retrying once with player_client=${RETRY_PLAYER_CLIENT}`
      );
      usedRetryClient = true;
      stdout = await runOnce(RETRY_PLAYER_CLIENT);
    } else {
      throw err;
    }
  }

  const urls = String(stdout)
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l));

  if (urls.length === 0) {
    throw new Error(`yt-dlp -g returned no URL: ${String(stdout).slice(0, 200)}`);
  }

  const manifest = urls.find(isManifestUrl);
  if (manifest) {
    streamDebug({ youtubeId, usedRetryClient, urlCount: urls.length, urlType: 'manifest' }, 'ytstream: resolveDirectUrl resolved a manifest URL');
    return manifest;
  }

  if (urls.length > 1) {
    logger.warn(
      { youtubeId, count: urls.length },
      'ytstream: direct mode got multiple URLs without a manifest; using first URL only'
    );
  }

  streamDebug({ youtubeId, usedRetryClient, urlCount: urls.length, urlType: 'plain' }, 'ytstream: resolveDirectUrl resolved a plain URL');
  return urls[0];
}

/**
 * `-headers` value for ffmpeg fetching a resolved googlevideo URL
 * directly (HLS's own direct-source seek-restart path) — mirrors
 * proxyDirectStream's headers. See docs/YTSTREAM_SEEK_FIX.md for vprv=1
 * URL caveats.
 */
function buildFfmpegUpstreamHeaders(cookieHeader) {
  let headers = `User-Agent: ${UPSTREAM_USER_AGENT}\r\nReferer: https://youtube.com\r\nOrigin: https://youtube.com\r\n`;
  if (cookieHeader) headers += `Cookie: ${cookieHeader}\r\n`;
  return headers;
}

// ffArgs for a direct-URL pass embeds the full YouTube auth cookie
// (session tokens like __Secure-3PSID/LOGIN_INFO) inside a -headers blob -
// logging ffArgs verbatim for debugging would leak live account
// credentials into the log file. Only used for the logged copy; the real
// ffArgs passed to spawn() must keep the actual cookie intact.
function redactFfArgsForLogging(args) {
  return args.map((arg) => (
    typeof arg === 'string' && /Cookie:/i.test(arg)
      ? arg.replace(/Cookie:\s*[^\r\n]*/gi, 'Cookie: [REDACTED]')
      : arg
  ));
}

// Diagnostic-only: names of incoming request headers never worth logging
// verbatim, in case a caller ever attaches one of these to a plain media
// URL (unexpected for /api/ytstream, which is intentionally unauthenticated
// - .strm files embed it as a bare URL - but redact defensively anyway).
const SENSITIVE_INCOMING_HEADER_NAMES = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-access-token']);

/**
 * Redacts sensitive header values before the 'incoming request' log call
 * dumps every header a caller sent, alongside isLikelyMetadataProbeRequest's
 * verdict - lets a real playback request be told apart from other Jellyfin
 * traffic (a library scan/ffprobe, thumbnail preview) from the log alone.
 */
function redactIncomingHeadersForLogging(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = SENSITIVE_INCOMING_HEADER_NAMES.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return out;
}

/**
 * Streams a resolved googlevideo.com URL back through this server rather
 * than a bare 302 redirect. A raw redirect would have the player fetch
 * googlevideo.com directly with none of the cookies/Referer/User-Agent
 * yt-dlp used to resolve the URL — age-restricted or members-only videos
 * get rejected. Proxying keeps this server in the loop, and forwards
 * Range so `mode=direct` stays seekable.
 *
 * @param {(bytes: number) => void} [onBytesSent] - called with each chunk of
 *   the upstream body relayed to the client (for the stream history's byte total)
 */
function proxyDirectStream(targetUrl, req, res, cookieHeader, redirectsLeft = 5, onBytesSent = undefined) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      reject(new Error('Invalid upstream URL'));
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': UPSTREAM_USER_AGENT,
      Referer: 'https://youtube.com',
      Origin: 'https://youtube.com',
    };
    if (cookieHeader) headers.Cookie = cookieHeader;
    if (req.headers.range) headers.Range = req.headers.range;

    let isAbortedByClient = false;
    const upstreamReq = mod.get(parsed, { headers, timeout: 25000 }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;

      if ([301, 302, 303, 307, 308].includes(status) && upstreamRes.headers.location && redirectsLeft > 0) {
        upstreamRes.resume();
        streamDebug({ status, location: upstreamRes.headers.location, redirectsLeft }, 'ytstream: proxyDirectStream following upstream redirect');
        proxyDirectStream(new URL(upstreamRes.headers.location, parsed).href, req, res, cookieHeader, redirectsLeft - 1, onBytesSent)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status >= 400) {
        upstreamRes.resume();
        const err = new Error(`Upstream returned HTTP ${status}`);
        err.status = status;
        reject(err);
        return;
      }

      streamDebug({ status, contentType: upstreamRes.headers['content-type'], contentLength: upstreamRes.headers['content-length'] }, 'ytstream: proxyDirectStream piping upstream response to client');
      res.status(status);
      ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']
        .forEach((h) => {
          if (upstreamRes.headers[h]) res.set(h, upstreamRes.headers[h]);
        });

      if (onBytesSent) upstreamRes.on('data', (chunk) => onBytesSent(chunk.length));
      upstreamRes.pipe(res);
      upstreamRes.on('error', (err) => {
        if (isAbortedByClient || err.code === 'ECONNRESET' || err.message === 'aborted') {
          resolve();
        } else {
          reject(err);
        }
      });
      res.on('finish', resolve);
    });

    upstreamReq.on('error', (err) => {
      if (isAbortedByClient || err.code === 'ECONNRESET' || err.message === 'aborted') {
        resolve();
      } else {
        reject(err);
      }
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      reject(new Error('Upstream request timed out'));
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        isAbortedByClient = true;
        upstreamReq.destroy();
        resolve();
      }
    });
  });
}

/**
 * mode=direct-redirect: resolves a playback URL via yt-dlp, same as
 * mode=direct, but sends the player a 302 straight to it instead of
 * Youtarr fetching/proxying the bytes - real bandwidth/CPU savings, at a
 * real reliability cost:
 *
 * - No cookies/Referer/User-Agent travel with the redirect - age-
 *   restricted or members-only videos fail outright for a player that
 *   can't supply them, where mode=direct's proxied fetch works.
 * - A vprv=1 session-bound URL is, if anything, more likely to 403 here:
 *   the fetch comes from the player's own client/network, a bigger
 *   mismatch from the resolving session than Youtarr's own proxy fetch.
 * - Whatever happens after the redirect is invisible to Youtarr - a
 *   failure there never reaches this server's logs.
 *
 * No fallback on any of the above - this either works as described or
 * the player's own request fails on its own.
 * @param {(req: import('express').Request) => string} resolveClientIp
 */
async function redirectToDirectUrl(youtubeId, config, quality, qualityStrictness, playerClient, req, res, resolveClientIp) {
  // Not a live/trackable session (no bytes pass through Youtarr at all,
  // see doc comment) - just a StreamHistory audit row, so the request
  // and its result (redirected, or a resolve failure) at least show up
  // somewhere instead of this mode being completely unaccounted for.
  const streamId = crypto.randomUUID();
  const historyEntry = {
    streamId,
    mode: 'direct-redirect',
    youtubeId,
    quality,
    clientIp: resolveClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    startedAt: Date.now(),
  };
  persistStreamHistoryStart(historyEntry);
  try {
    const url = await resolveDirectUrl(youtubeId, config, quality, playerClient, qualityStrictness);
    logger.info({ youtubeId, quality }, 'ytstream: redirecting player directly to resolved URL (mode=direct-redirect)');
    res.redirect(302, url);
    persistStreamHistoryEnd(historyEntry, 'redirected', null);
  } catch (err) {
    persistStreamHistoryEnd(historyEntry, 'error', err.message);
    throw err;
  }
}

module.exports = {
  isManifestUrl,
  resolveDirectUrl,
  buildFfmpegUpstreamHeaders,
  redactFfArgsForLogging,
  redactIncomingHeadersForLogging,
  proxyDirectStream,
  redirectToDirectUrl,
};
