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
} from '../../ui';
import { formatFileSize } from '../../../utils/formatters';
import { StreamHistoryRow } from '../../../hooks/useStreamHistory';
import { YOUTUBE_URL_BASE } from '../../shared/VideoModal/constants';
import { parseClientLabel, formatElapsed } from '../utils';

export interface StreamHistoryTableProps {
  rows: StreamHistoryRow[];
}

type ResultChip = { label: string; color: 'default' | 'success' | 'warning' | 'error' | 'info' };

// end_reason values are the exact strings passed to untrackStream throughout
// ytstream.js (destroyHlsSession's `reason` param, streamViaFfmpeg's
// handleFailure/onClientGone/ff.on('close')) plus 'server-restart' from this
// module's own startup orphan-cleanup - see server/routes/ytstream.js.
const RESULT_CHIPS: Record<string, ResultChip> = {
  completed: { label: 'Completed', color: 'success' },
  error: { label: 'Error', color: 'error' },
  'ready-failed': { label: 'Failed to start', color: 'error' },
  'client-disconnected': { label: 'Disconnected', color: 'warning' },
  'manual-stop': { label: 'Stopped', color: 'default' },
  'idle-timeout': { label: 'Idle timeout', color: 'default' },
  'hw-fallback-retry': { label: 'HW fallback', color: 'default' },
  'server-restart': { label: 'Interrupted (restart)', color: 'warning' },
};

function resultChipFor(row: StreamHistoryRow): ResultChip {
  if (!row.endedAt) return { label: 'In progress', color: 'info' };
  return RESULT_CHIPS[row.endReason || ''] || { label: row.endReason || 'Ended', color: 'default' };
}

function formatDetail(row: StreamHistoryRow): string {
  const parts = [row.quality, row.container, row.transcode];
  if (row.hardwareMode && row.hardwareMode !== 'none') {
    parts.push(row.hardwareMode);
  }
  return parts.filter(Boolean).join(' · ');
}

function formatStarted(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatDuration(row: StreamHistoryRow): string {
  const startedAt = new Date(row.startedAt).getTime();
  const endedAt = row.endedAt ? new Date(row.endedAt).getTime() : Date.now();
  return formatElapsed(startedAt, endedAt);
}

function StreamHistoryRowView({ row }: { row: StreamHistoryRow }) {
  const chip = resultChipFor(row);
  const chipElement = (
    <Chip size="small" label={chip.label} color={chip.color} variant="filled" />
  );

  return (
    <TableRow hover>
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
      <TableCell>
        <Chip size="small" label={row.mode === 'hls' ? 'HLS' : 'FFmpeg'} variant="filled" />
      </TableCell>
      <TableCell>
        <Tooltip title={`hardware: ${row.hardwareMode || 'none'}`}>
          <Typography variant="body2" style={{ whiteSpace: 'nowrap' }}>
            {formatDetail(row)}
          </Typography>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip title={row.userAgent || 'No user-agent reported'}>
          <Box>
            <Typography variant="body2">{row.clientIp}</Typography>
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
              {parseClientLabel(row.userAgent)}
            </Typography>
          </Box>
        </Tooltip>
      </TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{formatStarted(row.startedAt)}</TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{formatDuration(row)}</TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{formatFileSize(row.bytesTransferred) || '0MB'}</TableCell>
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

function StreamHistoryTable({ rows }: StreamHistoryTableProps) {
  return (
    <Paper style={{ overflow: 'hidden' }}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell component="th">Video</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Mode</TableCell>
              <TableCell component="th" style={{ width: 160 }}>Format</TableCell>
              <TableCell component="th" style={{ width: 200 }}>Client</TableCell>
              <TableCell component="th" style={{ width: 150 }}>Started</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Duration</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Total</TableCell>
              <TableCell component="th" style={{ width: 140 }}>Result</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <StreamHistoryRowView key={row.streamId} row={row} />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default StreamHistoryTable;
