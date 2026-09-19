import React from 'react';
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  Chip,
  Tooltip,
  Box,
  Link,
  Checkbox,
} from '../../ui';
import { Storage as CachedVideoIcon } from '../../../lib/icons';
import { formatByteSize } from '../../../utils/formatters';
import { StreamHistoryRow } from '../../../hooks/useStreamHistory';
import { YOUTUBE_URL_BASE } from '../../shared/VideoModal/constants';
import { parseClientLabel, formatModeLabel, formatModeChipLabel, modeChipColor } from '../utils';
import {
  FormatResolutionCell,
  FormatContainerCell,
  FormatCodecCell,
  FormatHardwareCell,
  FormatCachedCell,
  FORMAT_COLUMN_CHIP_STYLE,
  FORMAT_COLUMN_LABEL_CLASS,
} from './StreamFormatChips';
import { CLIENT_COLUMN_WIDTH, TIGHT_CELL_STYLE } from './StreamsTable';

export interface StreamHistoryTableProps {
  rows: StreamHistoryRow[];
  selectedIds: string[];
  onToggleSelect: (streamId: string) => void;
  onSelectAll: (checked: boolean) => void;
}

type ResultChip = { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' };

// end_reason values are the exact strings passed to untrackStream throughout
// ytstream.js (destroyHlsSession's `reason` param) plus 'server-restart'
// from this module's own startup orphan-cleanup - see server/routes/ytstream.js.
export const RESULT_CHIPS: Record<string, ResultChip> = {
  completed: { label: 'Completed', color: 'success' },
  redirected: { label: 'Redirected', color: 'success' },
  error: { label: 'Error', color: 'error' },
  'ready-failed': { label: 'Failed to start', color: 'error' },
  'client-disconnected': { label: 'Disconnected', color: 'warning' },
  'manual-stop': { label: 'Stopped', color: 'default' },
  'idle-timeout': { label: 'Idle timeout', color: 'default' },
  'hw-fallback-retry': { label: 'HW fallback', color: 'default' },
  'server-restart': { label: 'Interrupted (restart)', color: 'warning' },
};

/** Shared with StreamHistoryPage's Status filter dropdown - 'in-progress' isn't a real end_reason value, it's the label for ended_at===null (see resultChipFor below). */
export const STREAM_STATUS_OPTIONS = ['in-progress', ...Object.keys(RESULT_CHIPS)];

// resultChipFor/formatStarted/formatDuration are also used by
// StreamHistoryCard (grid view), so both views render identical text/colors.
export function resultChipFor(row: StreamHistoryRow): ResultChip {
  if (!row.endedAt) return { label: 'In progress', color: 'info' };
  return RESULT_CHIPS[row.endReason || ''] || { label: row.endReason || 'Ended', color: 'default' };
}

// Seconds + milliseconds (not just minute) so a "Started" time can be
// cross-referenced against the server log's own millisecond timestamps -
// several rows can otherwise land in the same displayed minute (e.g. a
// probe-shortcut burst) with no way to tell them apart.
export function formatStarted(iso: string): string {
  const date = new Date(iso);
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

// Same info as formatStarted, split into date/time so the table's Started
// column can wrap it onto two lines (date, then time) instead of forcing a
// wide single-line column - there's now more columns competing for width
// (the Format breakdown below).
export function formatStartedParts(iso: string): { date: string; time: string } {
  const date = new Date(iso);
  // Year only when it's not the current year - almost every row is recent,
  // so a bare year would just be clutter in an already-tight column.
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return {
    date: date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: includeYear ? 'numeric' : undefined,
    }),
    time: date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: true,
    }),
  };
}

// Millisecond precision (not just formatElapsed's seconds, which is right
// for the live page's once-a-second ticking clock but useless here) - a
// probe-shortcut/cached-file "session" is a single quick-serve that starts
// and ends within the same request, so its whole duration can be under a
// second; seconds-only would round every one of those down to "0:00".
export function formatDuration(row: StreamHistoryRow): string {
  const startedAt = new Date(row.startedAt).getTime();
  const endedAt = row.endedAt ? new Date(row.endedAt).getTime() : Date.now();
  const totalMs = Math.max(0, endedAt - startedAt);
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ms = totalMs % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const base = hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  return `${base}.${pad(ms, 3)}`;
}

function StreamHistoryRowView({
  row,
  isSelected,
  onToggleSelect,
}: {
  row: StreamHistoryRow;
  isSelected: boolean;
  onToggleSelect: (streamId: string) => void;
}) {
  const chip = resultChipFor(row);
  const chipElement = (
    <Chip size="small" label={chip.label} color={chip.color} variant="filled" />
  );

  return (
    <TableRow hover style={{ backgroundColor: isSelected ? 'var(--muted)' : undefined }}>
      <TableCell style={{ width: 48 }}>
        <Checkbox
          checked={isSelected}
          onChange={() => onToggleSelect(row.streamId)}
          inputProps={{ 'aria-label': `Select ${row.title || row.youtubeId}` }}
        />
      </TableCell>
      <TableCell>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Box
            component="img"
            src={`/images/videothumb-${row.youtubeId}.jpg`}
            alt={row.title || row.youtubeId}
            style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
          />
          <Link
            href={`${YOUTUBE_URL_BASE}${row.youtubeId}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 240,
            }}
          >
            {row.title || row.youtubeId}
          </Link>
        </Box>
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <Tooltip title={formatModeLabel(row.mode)}>
          <Chip
            size="small"
            label={formatModeChipLabel(row.mode)}
            color={modeChipColor(row.mode)}
            variant="filled"
            labelClassName={FORMAT_COLUMN_LABEL_CLASS}
            style={FORMAT_COLUMN_CHIP_STYLE}
          />
        </Tooltip>
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatResolutionCell quality={row.quality} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatContainerCell container={row.container} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatCodecCell transcode={row.transcode} hardwareMode={row.hardwareMode} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatHardwareCell hardwareMode={row.hardwareMode} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatCachedCell mode={row.mode} />
      </TableCell>
      <TableCell style={{ maxWidth: CLIENT_COLUMN_WIDTH }}>
        <Tooltip title={row.userAgent || 'No user-agent reported'}>
          <Box style={{ maxWidth: CLIENT_COLUMN_WIDTH - 12, overflow: 'hidden' }}>
            <Typography variant="body2" style={{ whiteSpace: 'nowrap' }}>{row.clientIp}</Typography>
            <Typography
              variant="caption"
              style={{
                color: 'var(--muted-foreground)',
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {parseClientLabel(row.userAgent)}
            </Typography>
          </Box>
        </Tooltip>
      </TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>
        {(() => {
          const { date, time } = formatStartedParts(row.startedAt);
          return (
            <>
              <Typography variant="body2" style={{ lineHeight: 1.3 }}>{date}</Typography>
              <Typography variant="caption" style={{ color: 'var(--muted-foreground)', display: 'block' }}>{time}</Typography>
            </>
          );
        })()}
      </TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{formatDuration(row)}</TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{formatByteSize(row.bytesTransferred ?? 0)}</TableCell>
      <TableCell>
        {row.errorMessage ? (
          <Tooltip title={row.errorMessage}>{chipElement}</Tooltip>
        ) : (
          chipElement
        )}
      </TableCell>
    </TableRow>
  );
}

function StreamHistoryTable({ rows, selectedIds, onToggleSelect, onSelectAll }: StreamHistoryTableProps) {
  const allSelected = rows.length > 0 && rows.every((row) => selectedIds.includes(row.streamId));
  const someSelected = !allSelected && rows.some((row) => selectedIds.includes(row.streamId));

  return (
    <Paper style={{ overflow: 'hidden' }}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell component="th" style={{ width: 48 }}>
                <Checkbox
                  indeterminate={someSelected}
                  checked={allSelected}
                  onChange={(event) => onSelectAll(event.target.checked)}
                  inputProps={{ 'aria-label': 'Select all history entries' }}
                />
              </TableCell>
              <TableCell component="th">Video</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 52 }} title="Mode">Mode</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 38 }} title="Resolution">Res</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 38 }} title="Container">Cont</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 38 }} title="Codec">Codec</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 32 }} title="Hardware">HW</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 24 }} title="Cached">
                <CachedVideoIcon size={12} />
              </TableCell>
              <TableCell component="th" style={{ width: CLIENT_COLUMN_WIDTH }}>Client</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Started</TableCell>
              <TableCell component="th" style={{ width: 80 }}>Duration</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Total</TableCell>
              <TableCell component="th" style={{ width: 120 }}>Result</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <StreamHistoryRowView
                key={row.streamId}
                row={row}
                isSelected={selectedIds.includes(row.streamId)}
                onToggleSelect={onToggleSelect}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default StreamHistoryTable;
