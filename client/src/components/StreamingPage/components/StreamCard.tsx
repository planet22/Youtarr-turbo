import React from 'react';
import { Chip, Tooltip, IconButton, Box, Typography } from '../../ui';
import { Stop as StopIcon, Search as ProbeIcon } from '../../../lib/icons';
import { formatFileSize } from '../../../utils/formatters';
import { StreamSnapshot } from '../../../hooks/useActiveStreams';
import { formatBytesPerSecond, parseClientLabel, isLikelyProbeRequest, formatModeLabel } from '../utils';
import { useStreamRowActions } from '../hooks/useStreamRowActions';
import { formatDetail, STATE_CHIP_COLOR } from './StreamsTable';
import { SegmentActivityStrip } from './SegmentActivityGrid';
import StreamCardLayout, { StreamCardStat } from './StreamCardLayout';

export interface StreamCardProps {
  stream: StreamSnapshot;
  token: string | null;
  onStopped: (id: string) => void;
  onOpenSegments: (streamId: string) => void;
}

/** Grid-view counterpart to StreamsTable's row - same data/actions, card layout. */
function StreamCard({ stream, token, onStopped, onOpenSegments }: StreamCardProps) {
  const { elapsed, stopping, handleStop } = useStreamRowActions(stream, token, onStopped);

  return (
    <StreamCardLayout
      youtubeId={stream.youtubeId}
      title={stream.title || stream.youtubeId}
      headerChips={
        <>
          <Chip size="small" label={formatModeLabel(stream.mode)} variant="filled" />
          <Chip size="small" label={stream.state} color={STATE_CHIP_COLOR[stream.state]} variant="filled" />
        </>
      }
    >
      <Tooltip title={`hardware: ${stream.hardwareMode}`}>
        <Typography variant="caption" color="secondary" style={{ display: 'block' }}>
          {formatDetail(stream)}
        </Typography>
      </Tooltip>

      <Tooltip title={stream.userAgent || 'No user-agent reported'}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <Typography variant="body2">{stream.clientIp}</Typography>
          {isLikelyProbeRequest(stream.userAgent) && (
            <ProbeIcon size={14} style={{ color: 'var(--warning)' }} data-testid="ProbeIcon" />
          )}
          <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
            {parseClientLabel(stream.userAgent)}
            {stream.viewerCount && stream.viewerCount > 1 ? ` · +${stream.viewerCount - 1} viewers` : ''}
          </Typography>
        </Box>
      </Tooltip>

      <Box className="grid grid-cols-2 gap-x-2 gap-y-1">
        <StreamCardStat label="Duration" value={elapsed} />
        <StreamCardStat label="Rate" value={formatBytesPerSecond(stream.bytesPerSecond)} />
        <StreamCardStat label="Total" value={formatFileSize(stream.bytesTransferred) || '0MB'} />
      </Box>

      <Box style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {stream.segments ? (
          <SegmentActivityStrip segments={stream.segments} onClick={() => onOpenSegments(stream.streamId)} />
        ) : (
          <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>—</Typography>
        )}
        <Tooltip title="Stop stream">
          <span>
            <IconButton size="small" onClick={handleStop} disabled={stopping} aria-label="Stop stream">
              <StopIcon size={18} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
    </StreamCardLayout>
  );
}

export default StreamCard;
