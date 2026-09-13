/**
 * formatFileSize (utils/formatters.ts) isn't rate-aware and returns '' for
 * falsy input — wrong for a live-updating MB/s column where 0 is a normal,
 * meaningful value (e.g. right after a stream starts).
 */
export function formatBytesPerSecond(bytesPerSecond: number): string {
  const mbps = bytesPerSecond / (1024 * 1024);
  return `${mbps.toFixed(2)} MB/s`;
}

/**
 * Best-effort client label from a User-Agent string — inherently fragile
 * (Jellyfin's server-side UA varies by version, etc.), meant as a helpful
 * hint in the table, not a guarantee. The raw UA is always available in a
 * tooltip alongside this.
 */
export function parseClientLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown client';
  const ua = userAgent.toLowerCase();
  if (ua.includes('jellyfin')) return 'Jellyfin';
  if (ua.includes('vlc')) return 'VLC';
  if (ua.includes('curl')) return 'curl';
  if (ua.includes('wget')) return 'wget';
  if (ua.includes('kodi')) return 'Kodi';
  if (ua.includes('infuse')) return 'Infuse';
  if (ua.includes('edg/')) return 'Edge';
  if (ua.includes('firefox')) return 'Firefox';
  if (ua.includes('chrome')) return 'Chrome';
  if (ua.includes('safari')) return 'Safari';
  // No known pattern matched - fall back to the UA's own product token
  // (e.g. "Youtarr-Playback/1.0" -> "Youtarr-Playback", "Lavf/61.7.103" ->
  // "Lavf") instead of a flat "Unknown client" that hides information the
  // raw UA - already shown in this cell's own tooltip - already has.
  const productToken = userAgent.trim().match(/^([^\s/(]+)/);
  return productToken ? productToken[1] : 'Unknown client';
}

/**
 * Same heuristic as the server's ytstream.js isLikelyMetadataProbeRequest:
 * a bare libavformat default User-Agent ("Lavf/x.y.z", no override applied)
 * usually means a media server's metadata probe (Jellyfin's ffprobe, or
 * similar) rather than a real viewer - see jellyfin/jellyfin#10175 and
 * ytstream.probeShortcut's doc comment for why that's a reliable signal.
 * This only flags streams that actually show up here at all - a
 * probeShortcut=true, transcode=h264 probe never creates a tracked session
 * in the first place, so it never reaches this table to be flagged. This
 * is what surfaces the remaining cases: probeShortcut off, or a
 * transcode=copy session (probeShortcut never applies there since no
 * single cached clip could match every video's own passthrough codec).
 */
export function isLikelyProbeRequest(userAgent: string | null | undefined): boolean {
  return !!userAgent && /^Lavf\//i.test(userAgent);
}

export const MODE_LABELS: Record<string, string> = {
  hls: 'HLS',
  'hls-buffer': 'HLS + Buffered Download',
  direct: 'Direct',
  'direct-redirect': 'Direct (redirect)',
  'cached-file': 'Cached file',
  'probe-cache-hit': 'Probe (cached)',
  'probe-shortcut': 'Probe (synthetic clip)',
};

/** Falls back to the raw mode string for anything not listed above, rather than mislabeling it. */
export function formatModeLabel(mode: string): string {
  return MODE_LABELS[mode] || mode;
}

/** Shared with StreamHistoryPage's Mode filter dropdown, so its option list always matches this labeling. */
export const STREAM_MODE_OPTIONS = Object.keys(MODE_LABELS);

/**
 * Short labels for the Mode chip in StreamsTable/StreamHistoryTable -
 * MODE_LABELS's full text (e.g. "HLS + Buffered Download") reads fine as a
 * filter dropdown option, but forces the Mode column wide enough to push the
 * whole table into horizontal scroll. The chip shows this instead and keeps
 * the full label in its tooltip.
 */
const MODE_CHIP_LABELS: Record<string, string> = {
  'hls-buffer': 'HLS+Buf',
  'direct-redirect': 'Direct (redir)',
  'cached-file': 'Cached',
  'probe-cache-hit': 'Probe',
  'probe-shortcut': 'Probe',
};

export function formatModeChipLabel(mode: string): string {
  return MODE_CHIP_LABELS[mode] || formatModeLabel(mode);
}

export type ChipColor = 'default' | 'primary' | 'secondary' | 'error' | 'warning' | 'success' | 'info';

/**
 * Modes that skip the whole quality/transcode pipeline and hand back an
 * already-downloaded file byte-for-byte (see resolveActualServedFileInfo in
 * server/routes/ytstream.js) - their Format chip shows that file's own real
 * quality/container, not a requested/configured value, so both get an
 * "Actual" chip to make the distinction visible.
 */
export const ACTUAL_FILE_MODES = new Set(['probe-cache-hit', 'cached-file']);

/** Color-codes the Mode chip so the shortcut/passthrough modes stand out from the modes that run a live encode. */
export function modeChipColor(mode: string): ChipColor {
  if (ACTUAL_FILE_MODES.has(mode)) return 'success';
  if (mode === 'hls' || mode === 'hls-buffer') return 'info';
  return 'default';
}

/** Color-codes the Format chip by how expensive the transcode is - copy is free, hardware h264 is cheap, software h264 is the most CPU-intensive case and worth calling out. */
export function formatChipColor(transcode: string | null | undefined, hardwareMode: string | null | undefined): ChipColor {
  if (!transcode || transcode === 'copy') return 'default';
  if (transcode === 'h264') return hardwareMode && hardwareMode !== 'none' ? 'success' : 'warning';
  return 'info';
}

export function formatElapsed(startedAt: number, now: number = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
