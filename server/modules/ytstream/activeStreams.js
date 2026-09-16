/**
 * server/modules/ytstream/activeStreams.js
 *
 * Streaming-page stream tracking — surfaces active mode=hls/hls-buffer
 * playback (byte counters, client info, start/stop) via
 * GET /api/ytstream/streams and POST /api/ytstream/streams/:id/stop,
 * broadcast over the same WebSocket mechanism as download-job progress
 * (messageEmitter.js). mode=direct is stateless and excluded. Identity: a
 * "stream" is one shared HLS encode session, keyed by its hlsSessions key.
 *
 * Extracted from server/routes/ytstream.js so it's a real importable
 * module instead of trapped in that file's private route-factory closure.
 *
 * Singleton state (this module is only ever evaluated once per process -
 * Node caches it regardless of how many times something requires it):
 * declaring activeStreams/statsTickTimer/the reaper's and exit-handlers'
 * once-only install flags here, rather than inside a per-call factory,
 * preserves the same "one real singleton for the process's whole life"
 * semantics server/routes/ytstream.js used to have directly - important
 * because createYtStreamRoutes itself IS called more than once in this
 * codebase's own test harness (a fresh router per test); a per-call
 * factory would lose previously-tracked streams and install duplicate
 * process-exit listeners / idle-reaper intervals on every call.
 *
 * `snapshotStream`/`ensureHlsIdleReaper`/`ensureProcessExitHandlers` need
 * to read the HLS session engine's live session map and, for the
 * reaper/exit-handler case, tear sessions down - that map (and
 * destroyHlsSession) are still owned by server/routes/ytstream.js today
 * (moves to a dedicated HLS-engine module in a later phase), so `init()`
 * takes them as explicit injected dependencies rather than this module
 * requiring that file directly (which would be circular) or reaching for
 * shared mutable state some other way.
 */
const fs = require('fs');
const logger = require('../../logger');
const messageEmitter = require('../messageEmitter');
const youtubeMetadataCache = require('../youtubeMetadataCache');
const { streamDebug } = require('./streamDebug');
const { killAllChildProcesses } = require('./processRegistry');

const STREAM_STATS_TICK_MS = 1500;
// HLS segments land as one instant whole-file burst per player request, not
// a steady trickle - a naive "since the last tick" rate would read 0 between
// bursts then spike on the tick that catches one, looking stalled even when
// healthy. This longer rolling window smooths bursts into a sustained rate.
const STREAM_THROUGHPUT_WINDOW_MS = 10000;
// Internal HLS session churn, not a real stream ending — suppresses the
// streamStopped broadcast. 'promoted' is a pending-request placeholder
// (see trackPendingRequest) handing off to its real tracked entry - the
// real entry's own trackStream call already announced the row, so the
// placeholder's removal must stay invisible too, not read as a stop.
const SILENT_UNTRACK_REASONS = new Set(['retry', 'stale-failed', 'promoted']);

// How long a stream that failed before ever really starting stays visible
// (state 'failed') on the Streaming page before its row is removed - see
// failStreamThenUntrack. Without this, untrackStream's normal immediate
// removal made a failure invisible: the row just vanished with nothing on
// screen to show it had ever existed or why it stopped.
const FAILED_STATE_LINGER_MS = 5000;

// Only hls/hls-buffer produce discrete numbered segment files on disk at
// all (direct* modes never touch ffmpeg) - snapshotStream below only
// computes/attaches this for those two, so streamProgress's periodic
// broadcast never does the readdir for a mode where it's meaningless.
const SEGMENT_STATUS_MODES = new Set(['hls', 'hls-buffer']);

const activeStreams = new Map(); // streamId -> entry
let statsTickTimer = null;

// Set by init() (called once per createYtStreamRoutes invocation, same
// reassign-is-harmless pattern server/routes/ytstream.js already used for
// its own ytstreamModels).
let models = null;
let hlsSessions = null;
let destroyHlsSession = null;

/**
 * @param {object} params.models - Sequelize models (for StreamHistory
 *   persistence); may be left unset (persistence best-effort no-ops) for a
 *   test harness bypassing the real route factory.
 * @param {Map} params.hlsSessions - the HLS session engine's live session map.
 * @param {(session: object, reason: string) => void} params.destroyHlsSession
 */
function init(params) {
  models = params.models;
  hlsSessions = params.hlsSessions;
  destroyHlsSession = params.destroyHlsSession;
}

/**
 * Per-segment on-disk status for the Streaming page's live segment-activity
 * grid. `encoded[i]` mirrors ensureHlsSegmentAvailable's fs.existsSync check
 * (one readdir per call instead of N stats). `bufferedThroughIndex` is a
 * separate, coarser signal: how far the independent hls-buffer raw fetch has
 * reached, converted to a segment index — a segment can be buffered without
 * being `encoded` yet (bytes present but not yet transcoded), so a seek into
 * that range is still fast (local -ss) even though the dot isn't green.
 */
function computeSegmentStatus(session) {
  if (!session || !session.totalSegments || !session.dir) return null;
  let files;
  try {
    files = fs.readdirSync(session.dir);
  } catch {
    return null;
  }
  const encoded = new Array(session.totalSegments).fill(false);
  let highestEncodedIndex = -1;
  for (const filename of files) {
    const match = filename.match(/^segment(\d{5})\.\w+$/);
    if (!match) continue;
    const index = Number(match[1]);
    if (index >= 0 && index < encoded.length) {
      encoded[index] = true;
      if (index > highestEncodedIndex) highestEncodedIndex = index;
    }
  }

  // session.totalSegments is only ever an ESTIMATE (yt-dlp's reported
  // duration, divided into fixed-length segments) - the real encode can
  // legitimately produce fewer segments than that if the estimate rounded
  // up or slightly overshot the actual encodable content. Once the encode
  // pass has genuinely finished (see encodeEnded above) and nothing is
  // still running that could add more, report the true final count instead
  // of the original estimate - otherwise the trailing slots the estimate
  // over-reserved would show as permanently "not yet available" even
  // though the stream played to completion with no seek ever involved.
  const totalSegments =
    session.encodeEnded && highestEncodedIndex >= 0 && highestEncodedIndex + 1 < session.totalSegments
      ? highestEncodedIndex + 1
      : session.totalSegments;
  const encodedForDisplay = totalSegments === encoded.length ? encoded : encoded.slice(0, totalSegments);

  const bufferedThroughIndex = session.bufferEnabled
    ? Math.min(totalSegments, Math.max(0, Math.floor((session.bufferedSeconds || 0) / session.segmentDurationSeconds)))
    : 0;
  // -1 (no gap left) can briefly be true right as a backfill pass finishes
  // its last write, just before session.backfillInProgress itself flips
  // back to false - never report that as a segment index.
  const backfillGapIndex = encodedForDisplay.indexOf(false);
  return {
    totalSegments,
    segmentDurationSeconds: session.segmentDurationSeconds,
    encoded: encodedForDisplay,
    bufferedThroughIndex,
    bufferComplete: session.bufferFetchDone === true,
    // Set by the segment-serving route (see session.lastServedSegmentIndex)
    // every time the player actually fetches a .ts/.m4s segment - the
    // Streaming page's segment grid uses this to highlight which segment is
    // currently being delivered, not just which ones are encoded on disk.
    currentSegmentIndex: typeof session.lastServedSegmentIndex === 'number' ? session.lastServedSegmentIndex : null,
    // Only meaningful while session.backfillInProgress is true (see
    // maybeBackfillMissingSegments) - the next segment the backfill pass is
    // about to (re)produce. NOT highestEncodedIndex+1: that tracks whichever
    // pass has encoded furthest overall, which is the DELIVERING pass once
    // it's run ahead of the gap backfill is still filling - a real case
    // (deliver from a seek target forward, backfill the skipped range behind
    // it), and using it here made the indicator jump to the delivering
    // pass's position instead of backfill's own. The backfill pass always
    // starts at the first gap (maybeBackfillMissingSegments's gapIndex) and
    // writes forward sequentially from there, so its real leading edge is
    // simply the first still-missing index.
    // Distinct from currentSegmentIndex above: backfill runs against a
    // local source in the background and never affects what's actually
    // being delivered to the viewer.
    backfillSegmentIndex: session.backfillInProgress && backfillGapIndex !== -1 ? backfillGapIndex : null,
  };
}

/**
 * Fills in `titleById` (in place) for any youtubeId still missing a title
 * after the Video-table lookup, from youtube_metadata_cache - the fallback
 * source for videos not (or no longer) in the library: an NZB-only grab
 * that was only ever streamed/buffered, or a video whose Video row has
 * since been removed (e.g. via Obliterate). Without this, those rows
 * permanently showed the bare YouTube id instead of a title, even though
 * the title was sitting right there in the metadata cache.
 */
async function fillMissingTitlesFromMetadataCache(youtubeIds, titleById) {
  const missing = youtubeIds.filter((id) => !titleById[id]);
  if (!missing.length) return;
  const titles = await youtubeMetadataCache.getCachedTitles(missing);
  streamDebug({ requested: missing.length, found: Object.keys(titles).length }, 'ytstream: fillMissingTitlesFromMetadataCache resolved titles from the metadata cache');
  Object.assign(titleById, titles);
}

// Stream History: persisted audit trail for ytstream playback sessions,
// backed by the `stream_history` table. Best-effort — failures are caught
// and logged, never allowed to affect the actual stream. Keyed by
// `stream_id` (upsert on start) so a silent HLS retry re-tracking the same
// streamId refreshes the row instead of erroring on the unique constraint.
async function persistStreamHistoryStart(entry) {
  if (!models || !models.StreamHistory) return;
  try {
    await models.StreamHistory.upsert({
      stream_id: entry.streamId,
      youtube_id: entry.youtubeId,
      mode: entry.mode,
      quality: entry.quality || null,
      container: entry.container || null,
      transcode: entry.transcode || null,
      hardware_mode: entry.hardwareMode || null,
      client_ip: entry.clientIp || null,
      user_agent: entry.userAgent || null,
      started_at: new Date(entry.startedAt),
      ended_at: null,
      bytes_transferred: 0,
      end_reason: null,
      error_message: null,
    });
  } catch (err) {
    logger.warn({ err, streamId: entry.streamId }, 'ytstream: failed to persist stream-history start row');
  }
}

async function persistStreamHistoryEnd(entry, reason, errorMessage) {
  if (!models || !models.StreamHistory) return;
  try {
    await models.StreamHistory.update(
      {
        ended_at: new Date(),
        bytes_transferred: entry.bytesTransferred || 0,
        end_reason: reason,
        error_message: errorMessage || null,
      },
      { where: { stream_id: entry.streamId } }
    );
  } catch (err) {
    logger.warn({ err, streamId: entry.streamId }, 'ytstream: failed to persist stream-history end row');
  }
}

function snapshotStream(entry) {
  const hlsSession = SEGMENT_STATUS_MODES.has(entry.mode) ? hlsSessions.get(entry.streamId) : null;
  return {
    streamId: entry.streamId,
    mode: entry.mode,
    youtubeId: entry.youtubeId,
    quality: entry.quality,
    container: entry.container,
    transcode: entry.transcode,
    hardwareMode: entry.hardwareMode,
    tuning: entry.tuning,
    clientIp: entry.clientIp,
    userAgent: entry.userAgent,
    viewerCount: entry.viewers ? entry.viewers.size : undefined,
    state: entry.state,
    error: entry.error || null,
    startedAt: entry.startedAt,
    bytesTransferred: entry.bytesTransferred,
    bytesPerSecond: entry.bytesPerSecond,
    lastActivityAt: entry.lastActivityAt,
    segments: hlsSession ? computeSegmentStatus(hlsSession) : null,
  };
}

function tickStreamStats() {
  if (activeStreams.size === 0) {
    if (statsTickTimer) {
      clearInterval(statsTickTimer);
      statsTickTimer = null;
    }
    return;
  }
  const now = Date.now();
  const snapshots = [];
  for (const entry of activeStreams.values()) {
    if (!entry.history) entry.history = [];
    entry.history.push({ t: now, bytes: entry.bytesTransferred });
    // Keep one sample at/before the window edge as the rate calc's start
    // point, not just samples strictly inside it - otherwise the window
    // shrinks to nothing right after a burst, recreating the spike-then-zero
    // pattern this window exists to smooth out.
    while (entry.history.length > 2 && now - entry.history[1].t >= STREAM_THROUGHPUT_WINDOW_MS) {
      entry.history.shift();
    }
    const oldest = entry.history[0];
    const deltaBytes = entry.bytesTransferred - oldest.bytes;
    const deltaMs = now - oldest.t;
    entry.bytesPerSecond = deltaMs > 0 ? deltaBytes / (deltaMs / 1000) : 0;
    snapshots.push(snapshotStream(entry));
  }
  messageEmitter.emitMessage('broadcast', null, 'server', 'streamProgress', { streams: snapshots });
}

function ensureStatsTicker() {
  if (statsTickTimer) return;
  statsTickTimer = setInterval(tickStreamStats, STREAM_STATS_TICK_MS);
  if (typeof statsTickTimer.unref === 'function') statsTickTimer.unref();
}

function addStreamEntry(entry) {
  activeStreams.set(entry.streamId, entry);
  messageEmitter.emitMessage('broadcast', null, 'server', 'streamStarted', snapshotStream(entry));
  ensureStatsTicker();
}

function trackStream(entry) {
  addStreamEntry(entry);
  persistStreamHistoryStart(entry);
}

/**
 * Tracks an incoming stream request the instant it's received - before
 * mode resolution, format probing, or HLS session creation has happened -
 * so the Streaming page shows a row immediately instead of only once
 * ffmpeg/yt-dlp setup finishes (which can take several seconds on its
 * own). Deliberately never persisted to StreamHistory: there's no
 * complete picture yet, and this placeholder's lifetime ends one of two
 * ways - handed off to the real tracked entry once one exists
 * (untrackStream(id, 'promoted'), silent - see SILENT_UNTRACK_REASONS), or
 * failed out via failStreamThenUntrack if resolution never gets that far.
 */
function trackPendingRequest(entry) {
  addStreamEntry({
    bytesTransferred: 0,
    bytesPerSecond: 0,
    lastActivityAt: Date.now(),
    ...entry,
  });
}

/**
 * Mutates an already-tracked entry's fields in place and broadcasts the
 * change immediately, in the same shape the 1.5s stats ticker uses - so a
 * step transition (e.g. 'requested' -> 'resolving') reaches the Streaming
 * page right away instead of waiting for the next tick or a REST refetch.
 */
function updateStream(streamId, patch) {
  const entry = activeStreams.get(streamId);
  if (!entry) return null;
  Object.assign(entry, patch);
  messageEmitter.emitMessage('broadcast', null, 'server', 'streamProgress', { streams: [snapshotStream(entry)] });
  return entry;
}

/**
 * Marks an entry 'failed' and broadcasts that immediately, but delays the
 * actual removal (untrackStream) by FAILED_STATE_LINGER_MS so a genuine
 * failure is visible on the Streaming page for a few seconds instead of
 * the row just disappearing the instant it happens.
 *
 * Identity-checked before the delayed removal fires: a new session can
 * reuse the same streamId (e.g. an HLS sessionKey) before the linger
 * elapses (immediate retry), in which case activeStreams already holds a
 * DIFFERENT (live) entry under that id by then - that entry's own
 * teardown owns its own removal, so this must not delete it out from
 * under it.
 */
function failStreamThenUntrack(streamId, reason, errorMessage) {
  const entry = activeStreams.get(streamId);
  if (!entry) {
    untrackStream(streamId, reason, errorMessage);
    return;
  }
  entry.state = 'failed';
  entry.error = errorMessage || null;
  messageEmitter.emitMessage('broadcast', null, 'server', 'streamProgress', { streams: [snapshotStream(entry)] });
  const timer = setTimeout(() => {
    if (activeStreams.get(streamId) === entry) {
      untrackStream(streamId, reason, errorMessage);
    }
  }, FAILED_STATE_LINGER_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function untrackStream(streamId, reason, errorMessage) {
  const entry = activeStreams.get(streamId);
  if (!entry) {
    streamDebug({ streamId, reason }, 'ytstream: untrackStream called for a streamId not in activeStreams - no-op (already removed, or never tracked)');
    return;
  }
  activeStreams.delete(streamId);
  streamDebug({ streamId, reason, remainingActiveStreams: activeStreams.size }, 'ytstream: untrackStream removed entry from activeStreams');
  if (!SILENT_UNTRACK_REASONS.has(reason)) {
    messageEmitter.emitMessage('broadcast', null, 'server', 'streamStopped', {
      streamId,
      mode: entry.mode,
      youtubeId: entry.youtubeId,
      reason,
    });
    persistStreamHistoryEnd(entry, reason, errorMessage);
  }
  if (activeStreams.size === 0 && statsTickTimer) {
    clearInterval(statsTickTimer);
    statsTickTimer = null;
  }
}

function getStream(streamId) {
  return activeStreams.get(streamId);
}

function listStreams() {
  return [...activeStreams.values()];
}

// Once-only idle-session reaper — mirrors ManagedTranscodeService.cs's
// idle-session cleanup in the reference plugin. unref()'d so the interval
// itself never keeps the Node process alive.
let hlsReaperInstalled = false;
function ensureHlsIdleReaper(HLS_IDLE_TIMEOUT_MS, HLS_IDLE_SWEEP_INTERVAL_MS) {
  if (hlsReaperInstalled) return;
  hlsReaperInstalled = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...hlsSessions.values()]) {
      if (now - session.lastAccess > HLS_IDLE_TIMEOUT_MS) {
        // A backfillMissingSegments pass runs entirely after playback has
        // gone idle by design - reaping the session (and deleting its
        // directory 3.5s later - see destroyHlsSession) out from under that
        // still-running ffmpeg would kill it mid-write and throw away the
        // work. Left alone for one more sweep interval; once that pass
        // either finishes or gets superseded, spawnHlsEncodePass/the clean-
        // finish handler always clears this flag (see their own comments),
        // so this can never wedge a session here permanently.
        if (session.backfillInProgress) {
          logger.debug({ sessionKey: session.key }, 'ytstream: idle HLS session has a backfill pass in progress; deferring reap');
          continue;
        }
        logger.info({ sessionKey: session.key }, 'ytstream: reaping idle HLS session');
        destroyHlsSession(session, 'idle-timeout');
      }
    }
  }, HLS_IDLE_SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// Once-only process-level cleanup so a Node shutdown does not leave orphaned yt-dlp/ffmpeg.
let processHandlersInstalled = false;
function ensureProcessExitHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  const onExit = (signal) => {
    killAllChildProcesses(signal || 'process-exit');
    for (const session of [...hlsSessions.values()]) {
      try { fs.rmSync(session.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
  process.once('exit', () => onExit('exit'));
  process.once('SIGTERM', () => onExit('SIGTERM'));
  process.once('SIGINT', () => onExit('SIGINT'));
}

module.exports = {
  init,
  computeSegmentStatus,
  fillMissingTitlesFromMetadataCache,
  persistStreamHistoryStart,
  persistStreamHistoryEnd,
  snapshotStream,
  trackStream,
  trackPendingRequest,
  updateStream,
  failStreamThenUntrack,
  untrackStream,
  getStream,
  listStreams,
  ensureHlsIdleReaper,
  ensureProcessExitHandlers,
};
