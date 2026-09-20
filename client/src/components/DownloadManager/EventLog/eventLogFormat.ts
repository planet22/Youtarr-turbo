import { formatByteSize, formatDownloadSpeed } from '../../../utils/formatters';
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

// Filter dates arrive as local YYYY-MM-DD strings (the shared date-range
// filter's format); the server wants instants, so a day runs from local
// midnight to the last millisecond of that local day.
function localDayInstant(dateKey: string, endOfDay: boolean): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return undefined;
  const [, year, month, day] = match.map(Number);
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export const dayStartIso = (dateKey: string): string | undefined => localDayInstant(dateKey, false);
export const dayEndIso = (dateKey: string): string | undefined => localDayInstant(dateKey, true);

// Event type families the server can filter on (prefix before the first dot).
export const EVENT_CATEGORY_OPTIONS: readonly string[] = ['job', 'video', 'nzb', 'strm', 'cache'];
export const EVENT_LEVEL_FILTER_OPTIONS: readonly string[] = ['error', 'warn', 'info'];

// ---- Expansion row: every recorded detail, readable ----------------------

const BYTE_KEYS = new Set(['fileSize', 'newFileSize', 'freedBytes']);

// "avgDownloadMBps" -> "Avg download MBps", "filePath" -> "File path"
export function detailLabel(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function detailValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (BYTE_KEYS.has(key) && typeof value === 'number') return formatByteSize(value);
  if (key === 'avgDownloadMBps' && typeof value === 'number') return formatDownloadSpeed(value) || String(value);
  if (key === 'downloadDurationSeconds' && typeof value === 'number') return `${value}s`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export interface DetailEntry {
  label: string;
  value: string;
}

// The event's recorded detail as label/value rows; empty values are dropped.
export function describeDetailEntries(detail: Record<string, unknown> | null): DetailEntry[] {
  if (!detail) return [];
  return Object.entries(detail)
    .map(([key, value]) => ({ label: detailLabel(key), value: detailValue(key, value) }))
    .filter((entry) => entry.value !== '');
}
