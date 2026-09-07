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
  IconButton,
  Box,
} from '../../ui';
import { Stop as StopIcon, Search as ProbeIcon } from '../../../lib/icons';
import { formatFileSize } from '../../../utils/formatters';
import { StreamSnapshot } from '../../../hooks/useActiveStreams';
import { YOUTUBE_URL_BASE } from '../../shared/VideoModal/constants';
import { formatBytesPerSecond, parseClientLabel, isLikelyProbeRequest, formatModeLabel } from '../utils';
import { useStreamRowActions } from '../hooks/useStreamRowActions';
import { SegmentActivityStrip } from './SegmentActivityGrid';

export interface StreamsTableProps {
  streams: StreamSnapshot[];
  token: string | null;
  onStopped: (streamId: string) => void;
  onOpenSegments: (streamId: string) => void;
}

// Shared with StreamCard's State chip (grid view), so both views color a
// given state identically.
export const STATE_CHIP_COLOR: Record<StreamSnapshot['state'], 'default' | 'success' | 'warning' | 'error'> = {
  starting: 'warning',
  active: 'success',
  cached: 'default',
  failed: 'error',
};

// Shared with StreamCard (grid view).
export function formatDetail(stream: StreamSnapshot): string {
  const parts = [stream.quality, stream.container, stream.transcode];
  if (stream.hardwareMode && stream.hardwareMode !== 'none') {
    parts.push(stream.hardwareMode);
  }
  return parts.filter(Boolean).join(' · ');
}

function StreamRow({
  stream,
  token,
  onStopped,
  onOpenSegments,
}: {
  stream: StreamSnapshot;
  token: string | null;
  onStopped: (id: string) => void;
  onOpenSegments: (streamId: string) => void;
}) {
  const { elapsed, stopping, handleStop } = useStreamRowActions(stream, token, onStopped);

  return (
    <TableRow hover>
      <TableCell>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Box
            component="img"
            src={`/images/videothumb-${stream.youtubeId}.jpg`}
            alt={stream.title || stream.youtubeId}
            style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
          />
          <Box style={{ minWidth: 0 }}>
            <Typography
              variant="body2"
              component="a"
              href={`${YOUTUBE_URL_BASE}${stream.youtubeId}`}
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
              {stream.title || stream.youtubeId}
            </Typography>
          </Box>
        </Box>
      </TableCell>
      <TableCell>
        <Chip size="small" label={formatModeLabel(stream.mode)} variant="filled" />
      </TableCell>
      <TableCell>
        <Tooltip title={`hardware: ${stream.hardwareMode}`}>
          <Typography variant="body2" style={{ whiteSpace: 'nowrap' }}>
            {formatDetail(stream)}
          </Typography>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip title={stream.userAgent || 'No user-agent reported'}>
          <Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Typography variant="body2">{stream.clientIp}</Typography>
              {isLikelyProbeRequest(stream.userAgent) && (
                <Tooltip title="Likely a metadata probe (e.g. Jellyfin's ffprobe), not a real viewer — bare default User-Agent (Lavf/...), no override applied">
                  <ProbeIcon size={14} style={{ color: 'var(--warning)' }} data-testid="ProbeIcon" />
                </Tooltip>
              )}
            </Box>
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
              {parseClientLabel(stream.userAgent)}
              {stream.viewerCount && stream.viewerCount > 1 ? ` · +${stream.viewerCount - 1} viewers` : ''}
            </Typography>
          </Box>
        </Tooltip>
      </TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{elapsed}</TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{formatBytesPerSecond(stream.bytesPerSecond)}</TableCell>
      <TableCell style={{ whiteSpace: 'nowrap' }}>{formatFileSize(stream.bytesTransferred) || '0MB'}</TableCell>
      <TableCell>
        {stream.segments ? (
          <SegmentActivityStrip segments={stream.segments} onClick={() => onOpenSegments(stream.streamId)} />
        ) : (
          <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>—</Typography>
        )}
      </TableCell>
      <TableCell>
        <Chip size="small" label={stream.state} color={STATE_CHIP_COLOR[stream.state]} variant="filled" />
      </TableCell>
      <TableCell>
        <Tooltip title="Stop stream">
          <span>
            <IconButton size="small" onClick={handleStop} disabled={stopping} aria-label="Stop stream">
              <StopIcon size={18} />
            </IconButton>
          </span>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

function StreamsTable({ streams, token, onStopped, onOpenSegments }: StreamsTableProps) {
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
              <TableCell component="th" style={{ width: 90 }}>Duration</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Throughput</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Total</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Segments</TableCell>
              <TableCell component="th" style={{ width: 100 }}>State</TableCell>
              <TableCell component="th" style={{ width: 60 }}>Stop</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {streams.map((stream) => (
              <StreamRow
                key={stream.streamId}
                stream={stream}
                token={token}
                onStopped={onStopped}
                onOpenSegments={onOpenSegments}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default StreamsTable;
