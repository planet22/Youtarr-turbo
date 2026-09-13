/**
 * server/modules/ytstream/processRegistry.js
 *
 * Tracks yt-dlp/ffmpeg child processes spawned by ytstream's playback
 * modes so they can all be killed together on client disconnect or process
 * exit, plus the ffmpeg-on-PATH availability check that gates mode=hls/
 * hls-buffer. Extracted from server/routes/ytstream.js so both are a real
 * importable module instead of trapped in that file's private route-
 * factory closure.
 */
const logger = require('../../logger');
const { spawnSync } = require('child_process');

// Active child processes for Enhanced mode (the video/audio yt-dlp feeders
// and the ffmpeg muxer on pipe:3/pipe:4), tracked so they're killed
// together on client disconnect and process exit.
const activeChildProcesses = new Set();

function registerChildProcess(proc) {
  activeChildProcesses.add(proc);
  const forget = () => activeChildProcesses.delete(proc);
  proc.once('exit', forget);
  proc.once('error', forget);
}

function killChildProcess(proc, reason) {
  if (!proc || proc.killed || proc.exitCode !== null) return false;
  try {
    logger.info({ pid: proc.pid, reason }, 'ytstream: killing child process');
    // Prefer SIGTERM so ffmpeg can release hardware encoder contexts (QSV/NVENC)
    proc.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 3000);
    // Don't keep the event loop alive solely for the force-kill timer
    if (typeof forceTimer.unref === 'function') forceTimer.unref();
    return true;
  } catch (err) {
    logger.warn({ err, pid: proc.pid }, 'ytstream: failed to kill child process');
    return false;
  }
}

function killAllChildProcesses(reason) {
  for (const proc of [...activeChildProcesses]) {
    killChildProcess(proc, reason);
  }
}

// Only ever holds `true` (once confirmed, ffmpeg isn't going to vanish from
// PATH mid-run) - a `false`/not-yet-determined result is deliberately NEVER
// cached, unlike almost every other cache in this file. Confirmed live
// 2026-09-02: a container that had just started could hit this check before
// ffmpeg was actually resolvable on PATH yet (an entrypoint/PATH-setup race
// at boot), and caching that transient `false` for the rest of the process's
// life meant every request for the container's entire uptime kept getting
// the "ffmpeg unavailable" fallback - the only way out was a full restart to
// get a fresh process (and a fresh roll of the same race, hopefully won this
// time). Re-checking on every call this returns false for is deliberately
// cheap insurance against that: `spawnSync('ffmpeg', ['-version'])` is a few
// ms, trivial next to the actual streaming work a false positive here breaks.
let ffmpegAvailableCache = null;

function isFfmpegAvailable() {
  if (ffmpegAvailableCache === true) return true;
  let available;
  try {
    const result = spawnSync('ffmpeg', ['-version'], { timeout: 5000 });
    available = !result.error && result.status === 0;
  } catch {
    available = false;
  }
  if (available) {
    ffmpegAvailableCache = true;
  } else {
    logger.warn(
      'ffmpeg was not found on PATH. mode=hls/hls-buffer require it and will ' +
        'fail outright until it is installed. See docs/YTSTREAM.md for install instructions.'
    );
  }
  return available;
}

module.exports = {
  activeChildProcesses,
  registerChildProcess,
  killChildProcess,
  killAllChildProcesses,
  isFfmpegAvailable,
};
