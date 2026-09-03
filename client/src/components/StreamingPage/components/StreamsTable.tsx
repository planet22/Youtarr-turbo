import React, { useEffect, useState } from 'react';
import axios from 'axios';
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
import { formatBytesPerSecond, formatElapsed, parseClientLabel, isLikelyProbeRequest, formatModeLabel } from '../utils';
import { SegmentActivityStrip, SegmentActivityDialog } from './SegmentActivityGrid';

export interface StreamsTableProps {
  streams: StreamSnapshot[];
  token: string | null;
  onStopped: (streamId: string) => void;
}

const STATE_CHIP_COLOR: Record<StreamSnapshot['state'], 'default' | 'success' | 'warning' | 'error'> = {
  starting: 'warning',
  active: 'success',
  cached: 'default',
  failed: 'error',
};

function formatDetail(stream: StreamSnapshot): string {
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
  // Plain wall-clock elapsed since the session started. A lastActivityAt-based
  // freeze (tried and reverted) sounds appealing for "pause the clock when
  // paused," but a healthy player pre-buffers several segments ahead and then
  // goes quiet on the network for a while *while still actively playing* from
  // that buffer - indistinguishable, from the server's request-timing view,
  // from a real pause. That froze the display during completely normal
  // playback, which is worse than this column just being a "since started"
  // session-age clock rather than a live playback-position indicator.
  const [elapsed, setElapsed] = useState(() => formatElapsed(stream.startedAt));
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(formatElapsed(stream.startedAt)), 1000);
    return () => clearInterval(timer);
  }, [stream.startedAt]);

  const handleStop = async () => {
    if (!token || stopping) return;
    setStopping(true);
    try {
      await axios.post(
        `/api/ytstream/streams/${encodeURIComponent(stream.streamId)}/stop`,
        {},
        { headers: { 'x-access-token': token } }
      );
      onStopped(stream.streamId);
    } catch {
      setStopping(false);
    }
  };

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

function StreamsTable({ streams, token, onStopped }: StreamsTableProps) {
  // Stores the id, not a snapshot of the stream object - `streams` refreshes
  // every 1.5s (streamProgress), so re-deriving `selectedStream` from the
  // current `streams` prop below on every render is what makes the open
  // dialog's segment grid keep updating live instead of freezing at
  // whatever it looked like the moment it was opened.
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const selectedStream = selectedStreamId ? streams.find((s) => s.streamId === selectedStreamId) || null : null;

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
                onOpenSegments={setSelectedStreamId}
              />
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <SegmentActivityDialog
        open={selectedStream !== null}
        onClose={() => setSelectedStreamId(null)}
        title={selectedStream?.title || selectedStream?.youtubeId || ''}
        segments={selectedStream?.segments ?? null}
      />
    </Paper>
  );
}

export default StreamsTable;
