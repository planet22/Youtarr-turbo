import type { ByteRangeProgress } from '../hooks/useByteRangeProgress';
import { formatByteSize } from '../../../utils/formatters';

export type SegmentKind = 'cached' | 'done' | 'active' | 'pending';

export interface SegmentCell {
  kind: SegmentKind;
  label: string;
}

// A typical cluster length; the map's slices are this long whatever the file's clusters really are.
const SEGMENT_MS = 5000;
const MAX_CELLS = 1200;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const PERCENT_CAP_WHILE_RUNNING = 99;
// When several clusters share one cell, the cell shows the "least finished" state among them.
const GROUP_KIND_PRIORITY: SegmentKind[] = ['active', 'pending', 'cached', 'done'];

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = total % SECONDS_PER_MINUTE;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Overall progress 0-100 for an mkv session, or null when nothing yet says how far along it is. */
export function getMkvPercent(progress: ByteRangeProgress): number | null {
  if (progress.complete) return 100;
  const mkv = progress.mkv;
  if (!mkv) return null;
  if (mkv.declaredTotalBytes && progress.currentSizeBytes) {
    return Math.min(PERCENT_CAP_WHILE_RUNNING, (progress.currentSizeBytes / mkv.declaredTotalBytes) * 100);
  }
  if (mkv.durationSeconds && mkv.encodedSeconds) {
    return Math.min(PERCENT_CAP_WHILE_RUNNING, (mkv.encodedSeconds / mkv.durationSeconds) * 100);
  }
  return null;
}

function groupCells(cells: SegmentCell[]): SegmentCell[] {
  const groupSize = Math.ceil(cells.length / MAX_CELLS);
  const grouped: SegmentCell[] = [];
  for (let i = 0; i < cells.length; i += groupSize) {
    const slice = cells.slice(i, i + groupSize);
    const uniform = slice.every((cell) => cell.kind === slice[0].kind);
    const kind = uniform ? slice[0].kind : GROUP_KIND_PRIORITY.find((k) => slice.some((cell) => cell.kind === k)) || 'done';
    grouped.push({ kind, label: `${slice[0].label.split(' · ')[0]} +${slice.length - 1} more` });
  }
  return grouped;
}

/**
 * The segment map: one cell per fixed SEGMENT_MS slice of the video, so the
 * number of cells depends only on the video's length and never changes while
 * it downloads. A slice is done once the clusters covering it have been
 * written (read from the file), cached when it lies in the cached head of a
 * resumed encode, active while its cluster is still being written, and
 * pending after that. Beyond MAX_CELLS neighbouring slices share a cell.
 */
export function buildSegmentCells(progress: ByteRangeProgress): SegmentCell[] {
  const mkv = progress.mkv;
  if (!mkv) return [];
  const starts = mkv.clusterStartsMs;
  const lastStartMs = starts.length ? starts[starts.length - 1] : (mkv.resumeSeamMs ?? 0);
  const writtenUntilMs = progress.complete ? Infinity : lastStartMs;
  const cachedUntilMs = mkv.resumeSeamMs ?? 0;
  const expectedTotal = mkv.durationSeconds ? Math.ceil((mkv.durationSeconds * MS_PER_SECOND) / SEGMENT_MS) : 0;
  const total = Math.max(expectedTotal, Math.ceil((lastStartMs + 1) / SEGMENT_MS));

  const cells: SegmentCell[] = [];
  for (let i = 0; i < total; i += 1) {
    const startMs = i * SEGMENT_MS;
    const endMs = startMs + SEGMENT_MS;
    const range = `${formatClock(startMs)} – ${formatClock(endMs)}`;
    if (endMs <= cachedUntilMs) {
      cells.push({ kind: 'cached', label: `${range} · cached` });
    } else if (endMs <= writtenUntilMs) {
      let clusterCount = 0;
      let bytes = 0;
      starts.forEach((clusterStart, index) => {
        if (clusterStart >= startMs && clusterStart < endMs) {
          clusterCount += 1;
          bytes += mkv.clusterBytes[index];
        }
      });
      const detail = clusterCount ? ` · ${formatByteSize(bytes)}` : '';
      cells.push({ kind: 'done', label: `${range}${detail}` });
    } else if (startMs <= writtenUntilMs) {
      cells.push({ kind: 'active', label: `${range} · writing` });
    } else {
      cells.push({ kind: 'pending', label: `${range} · waiting` });
    }
  }
  return cells.length > MAX_CELLS ? groupCells(cells) : cells;
}
