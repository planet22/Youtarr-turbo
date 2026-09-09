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
import { Stop as StopIcon, Search as ProbeIcon, Storage as CachedVideoIcon } from '../../../lib/icons';
import { formatFileSize } from '../../../utils/formatters';
import { StreamSnapshot } from '../../../hooks/useActiveStreams';
import { YOUTUBE_URL_BASE } from '../../shared/VideoModal/constants';
import {
  formatBytesPerSecond,
  parseClientLabel,
  isLikelyProbeRequest,
  formatModeLabel,
  formatModeChipLabel,
  modeChipColor,
} from '../utils';
import { useStreamRowActions } from '../hooks/useStreamRowActions';
import { SegmentActivityStrip } from './SegmentActivityGrid';
import {
  FormatResolutionCell,
  FormatContainerCell,
  FormatCodecCell,
  FormatHardwareCell,
  FormatCachedCell,
  FORMAT_COLUMN_CHIP_STYLE,
  FORMAT_COLUMN_LABEL_CLASS,
} from './StreamFormatChips';

export interface StreamsTableProps {
  streams: StreamSnapshot[];
  token: string | null;
  onStopped: (streamId: string) => void;
  onOpenSegments: (streamId: string) => void;
}

// An IPv4 address never needs more than "255.255.255.255" (15 chars) worth
// of width - the old 180px column was sized for the client-label subtext,
// not the address itself. Shared with StreamHistoryTable so both Client
// columns match.
export const CLIENT_COLUMN_WIDTH = 130;

// Mode + the 5 format-breakdown columns (Res/Cont/Codec/HW/Cache) each hold
// one short chip - tight padding (vs. the table's normal cell padding) so
// six columns of single chips don't blow the table out wide. Shared with
// StreamHistoryTable so both tables' columns match.
export const TIGHT_CELL_STYLE: React.CSSProperties = { padding: '2px 4px' };

// Shared with StreamCard's State chip (grid view), so both views color a
// given state identically.
export const STATE_CHIP_COLOR: Record<StreamSnapshot['state'], 'default' | 'success' | 'warning' | 'error'> = {
  starting: 'warning',
  active: 'success',
  cached: 'default',
  failed: 'error',
};

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
      <TableCell style={TIGHT_CELL_STYLE}>
        <Tooltip title={formatModeLabel(stream.mode)}>
          <Chip
            size="small"
            label={formatModeChipLabel(stream.mode)}
            color={modeChipColor(stream.mode)}
            variant="filled"
            labelClassName={FORMAT_COLUMN_LABEL_CLASS}
            style={FORMAT_COLUMN_CHIP_STYLE}
          />
        </Tooltip>
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatResolutionCell quality={stream.quality} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatContainerCell container={stream.container} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatCodecCell transcode={stream.transcode} hardwareMode={stream.hardwareMode} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatHardwareCell hardwareMode={stream.hardwareMode} />
      </TableCell>
      <TableCell style={TIGHT_CELL_STYLE}>
        <FormatCachedCell mode={stream.mode} />
      </TableCell>
      <TableCell style={{ maxWidth: CLIENT_COLUMN_WIDTH }}>
        <Tooltip title={stream.userAgent || 'No user-agent reported'}>
          <Box style={{ maxWidth: CLIENT_COLUMN_WIDTH - 12, overflow: 'hidden' }}>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Typography variant="body2" style={{ whiteSpace: 'nowrap' }}>{stream.clientIp}</Typography>
              {isLikelyProbeRequest(stream.userAgent) && (
                <Tooltip title="Likely a metadata probe (e.g. Jellyfin's ffprobe), not a real viewer — bare default User-Agent (Lavf/...), no override applied">
                  <ProbeIcon size={14} style={{ color: 'var(--warning)' }} data-testid="ProbeIcon" />
                </Tooltip>
              )}
            </Box>
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
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 52 }} title="Mode">Mode</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 38 }} title="Resolution">Res</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 38 }} title="Container">Cont</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 38 }} title="Codec">Codec</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 32 }} title="Hardware">HW</TableCell>
              <TableCell component="th" style={{ ...TIGHT_CELL_STYLE, width: 24 }} title="Cached">
                <CachedVideoIcon size={12} />
              </TableCell>
              <TableCell component="th" style={{ width: CLIENT_COLUMN_WIDTH }}>Client</TableCell>
              <TableCell component="th" style={{ width: 80 }}>Duration</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Throughput</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Total</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Segments</TableCell>
              <TableCell component="th" style={{ width: 90 }}>State</TableCell>
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
