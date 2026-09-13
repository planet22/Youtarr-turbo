import { NzbSearchTraceItem } from '../../hooks/useNzbStats';

export function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatRelativeTime(timestampMs: number): string {
  const diffSeconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (diffSeconds < 5) return 'just now';
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  return `${diffHours}h ago`;
}

// "Resolution" column on the Recent Queries table - applyResolutionDetection's
// own timing/volume for that search (see NzbSearchTrace.resolutionMs/
// resolutionQueryCount), looked up via the matching trace since it isn't
// known yet when the query itself is recorded. undefined covers both "no
// matching trace" (e.g. the search errored before one was recorded) and
// traces recorded before this field existed - same "-" either way.
export function formatResolutionStats(durationMs: number | undefined, queryCount: number | undefined): string {
  if (durationMs === undefined || queryCount === undefined) return '-';
  return `${formatDurationMs(durationMs)} (${queryCount})`;
}

// Per-source tally for the Resolution column's tooltip, e.g. "Cache: - ·
// Thumb: 8 · Extract: 2" - "-" for a tier that resolved nothing rather than
// "0", since a search usually only exercises one or two of the three.
// Sourced entirely from the matching trace's own items (each already
// carries resolutionSource - see NzbSearchTraceItem) rather than any new
// server field. Deliberately excludes 'fixed'/'api' items: those never
// reach nzbThumbnailProbe.fillUnknownDefinitions at all (see nzb.js's
// applyResolutionDetection), so counting them would make this add up to
// more than the column's own query count. Returns null when there's
// nothing to show (no trace, or every item was already settled by fixed/api).
export function formatResolutionBreakdown(items: NzbSearchTraceItem[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  let cache = 0;
  let thumb = 0;
  let extract = 0;
  for (const item of items) {
    if (item.effectiveHeightTier == null) continue;
    if (item.resolutionSource === 'metadataCache') cache += 1;
    else if (item.resolutionSource === 'thumb') thumb += 1;
    else if (item.resolutionSource === 'extract') extract += 1;
  }
  if (cache + thumb + extract === 0) return null;
  const fmt = (n: number) => (n > 0 ? String(n) : '-');
  return `Cache: ${fmt(cache)} · Thumb: ${fmt(thumb)} · Extract: ${fmt(extract)}`;
}

export function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return 'expired';
  const totalSeconds = Math.round(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
