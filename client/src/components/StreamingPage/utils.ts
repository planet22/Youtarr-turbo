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
  return 'Unknown client';
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

export function formatElapsed(startedAt: number, now: number = Date.now()): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
