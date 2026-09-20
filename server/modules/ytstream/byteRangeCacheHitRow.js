/**
 * server/modules/ytstream/byteRangeCacheHitRow.js
 *
 * Live Streams row for mode=hls-byterange (Plain file) when a request is
 * answered straight from the stealth cache. There is no encode session in
 * that case (Youtarr just streams the finished file to the player), so
 * nothing else would show that a player is reading it.
 *
 * One row per cache entry, shared by every request for it (a player reads a
 * file as many Range requests). The row lives while any request is still in
 * flight, then for IDLE_HOLD_MS after the last one (long enough for a seek's
 * abort-and-reconnect) - or until Stop, which also cuts the transfers still
 * running. trackStream/untrackStream also write the
 * Stream History row.
 */
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');
const { trackStream, untrackStream, getStream, createBytesCounter } = require('./activeStreams');

const CACHE_HIT_MODE = 'byterange-cache-hit';
// A player that stops closes its connection (a paused one keeps it open), so
// the row only has to outlast a seek's abort-and-reconnect.
const IDLE_HOLD_MS = 15 * 1000;
// Also the interval of the throughput heartbeat logged while a player is reading.
const SWEEP_INTERVAL_MS = 5 * 1000;
const BYTES_PER_MB = 1024 * 1024;
const MS_PER_SECOND = 1000;

/** streamId -> { lastRequestAt, inFlight, responses, startedAt, requestCount, lastBeat } */
const rows = new Map();
let sweepTimer = null;

function megabytesPerSecond(bytes, ms) {
  return ms > 0 ? Number(((bytes / BYTES_PER_MB) / (ms / MS_PER_SECOND)).toFixed(2)) : null;
}

function stopRow(streamId, reason) {
  const state = rows.get(streamId);
  if (!state) return;
  rows.delete(streamId);
  for (const res of state.responses) res.destroy();
  const entry = getStream(streamId);
  const totalBytes = entry ? entry.bytesTransferred : null;
  const elapsedMs = Date.now() - state.startedAt;
  logger.info(
    {
      streamId, reason, cutTransfers: state.responses.size, requests: state.requestCount, elapsedMs,
      totalMB: totalBytes === null ? null : Number((totalBytes / BYTES_PER_MB).toFixed(1)),
      averageMBps: totalBytes === null ? null : megabytesPerSecond(totalBytes, elapsedMs),
    },
    'ytstream: byte-range cache-hit Live Streams row ended'
  );
  untrackStream(streamId, reason, null);
}

function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [streamId, state] of [...rows]) {
      const entry = getStream(streamId);
      const bytes = entry ? entry.bytesTransferred : 0;
      const sinceMs = now - state.lastBeat.at;
      const sinceBytes = bytes - state.lastBeat.bytes;
      if (state.inFlight > 0 || sinceBytes > 0) {
        streamDebug(
          {
            streamId, inFlight: state.inFlight, requests: state.requestCount,
            readMB: Number((sinceBytes / BYTES_PER_MB).toFixed(2)), MBps: megabytesPerSecond(sinceBytes, sinceMs),
            totalMB: Number((bytes / BYTES_PER_MB).toFixed(1)),
          },
          'ytstream: byte-range cache hit - throughput heartbeat (reading the cached file)'
        );
      }
      state.lastBeat = { at: now, bytes };
      if (state.inFlight > 0 || now - state.lastRequestAt <= IDLE_HOLD_MS) continue;
      stopRow(streamId, 'idle-timeout');
    }
    if (rows.size === 0) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/**
 * Registers one request being answered from the cache, creating the row on
 * the first one. Call before serving `res`.
 *
 * @param {object} params
 * @param {string} params.streamId - stable per cache entry
 * @param {string} params.youtubeId
 * @param {string} params.quality
 * @param {string} params.transcode
 * @param {'mkv'|'mp4'} params.container
 * @param {string|null} params.clientIp
 * @param {string|null} params.userAgent
 * @param {import('express').Response} res
 * @returns {{onServed: () => void, onBytesSent: (bytes: number) => void}} callbacks for serveFileWithRangeSupport
 */
function beginCacheHit({ streamId, youtubeId, quality, transcode, container, clientIp, userAgent }, res) {
  const now = Date.now();
  const viewer = { userAgent: userAgent || null, lastSeen: now };
  let state = rows.get(streamId);
  let entry = getStream(streamId);
  if (!state || !entry) {
    trackStream({
      streamId,
      mode: CACHE_HIT_MODE,
      youtubeId,
      quality,
      container,
      transcode,
      clientIp,
      userAgent,
      state: 'active',
      startedAt: now,
      bytesTransferred: 0,
      bytesPerSecond: 0,
      lastActivityAt: now,
      viewers: new Map([[clientIp || 'unknown', viewer]]),
      stop: () => stopRow(streamId, 'manual-stop'),
    });
    state = { lastRequestAt: now, inFlight: 0, responses: new Set(), startedAt: now, requestCount: 0, lastBeat: { at: now, bytes: 0 } };
    rows.set(streamId, state);
    entry = getStream(streamId);
    ensureSweeper();
    logger.info({ streamId, youtubeId, quality, container, clientIp, userAgent }, 'ytstream: byte-range cache hit - showing on Live Streams');
  } else if (entry.viewers) {
    entry.viewers.set(clientIp || 'unknown', viewer);
  }

  state.inFlight += 1;
  state.requestCount += 1;
  state.lastRequestAt = now;
  state.responses.add(res);
  const range = res.req && res.req.headers ? res.req.headers.range || null : null;
  let requestBytes = 0;
  streamDebug({ streamId, request: state.requestCount, inFlight: state.inFlight, clientIp, userAgent, range }, 'ytstream: byte-range cache hit - request started');
  res.on('close', () => {
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.lastRequestAt = Date.now();
    state.responses.delete(res);
    const ms = Date.now() - now;
    streamDebug(
      {
        streamId, clientIp, range, inFlight: state.inFlight,
        sentMB: Number((requestBytes / BYTES_PER_MB).toFixed(2)), ms, MBps: megabytesPerSecond(requestBytes, ms),
        totalMB: entry ? Number((entry.bytesTransferred / BYTES_PER_MB).toFixed(1)) : null,
      },
      'ytstream: byte-range cache hit - request finished'
    );
  });

  const countBytes = createBytesCounter(entry);
  return {
    onServed: () => {
      state.lastRequestAt = Date.now();
      if (entry) entry.lastActivityAt = Date.now();
    },
    onBytesSent: (bytes) => {
      requestBytes += bytes;
      state.lastRequestAt = Date.now();
      countBytes(bytes);
    },
  };
}

/** Test hook: forgets every row and stops the sweeper. */
function resetCacheHitRows() {
  rows.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = { CACHE_HIT_MODE, IDLE_HOLD_MS, beginCacheHit, resetCacheHitRows };
