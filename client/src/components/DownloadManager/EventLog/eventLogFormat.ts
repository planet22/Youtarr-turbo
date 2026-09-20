import type { JobEventLevel } from '../../../types/JobEvent';

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

// Seconds + milliseconds, so entries a few ms apart (an import, a
// history-delete, an untrack) stay distinguishable and can be matched against
// the server log's own millisecond timestamps.
export function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: true,
  });
}

// Elapsed time from one entry to the next, e.g. "+45 ms", "+1.234 s", "+2m 03s".
// Null when either timestamp is unusable or the order is reversed.
export function formatEventDelta(previousIso: string, currentIso: string): string | null {
  const previous = new Date(previousIso).getTime();
  const current = new Date(currentIso).getTime();
  if (Number.isNaN(previous) || Number.isNaN(current) || current < previous) return null;

  const ms = current - previous;
  if (ms < MS_PER_SECOND) return `+${ms} ms`;
  if (ms < MS_PER_SECOND * SECONDS_PER_MINUTE) return `+${(ms / MS_PER_SECOND).toFixed(3)} s`;

  const totalSeconds = Math.floor(ms / MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = String(totalSeconds % SECONDS_PER_MINUTE).padStart(2, '0');
  return `+${minutes}m ${seconds}s`;
}

export type EventChipColor = 'default' | 'warning' | 'error';

export function eventLevelColor(level: JobEventLevel | string): EventChipColor {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warning';
  return 'default';
}

export const EVENT_LEVEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All levels' },
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Info' },
];
