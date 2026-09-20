import React from 'react';
import { Chip, Tooltip, IconButton, Box, Typography } from '../../ui';
import { Stop as StopIcon, Search as ProbeIcon } from '../../../lib/icons';
import { StreamSnapshot } from '../../../hooks/useActiveStreams';
import {
  formatStreamRate,
  formatStreamTotal,
  parseClientLabel,
  isLikelyProbeRequest,
  formatModeLabel,
  formatModeChipLabel,
  modeChipColor,
} from '../utils';
import { useStreamRowActions } from '../hooks/useStreamRowActions';
import { STATE_CHIP_COLOR, STATE_CHIP_LABEL } from './StreamsTable';
import { SegmentActivityStrip, segmentVariantForMode } from './SegmentActivityGrid';
import { ByteRangeProgressStrip } from './ByteRangeProgressGrid';
import StreamCardLayout, { StreamCardStat } from './StreamCardLayout';
import StreamFormatChips from './StreamFormatChips';

export interface StreamCardProps {
  stream: StreamSnapshot;
  token: string | null;
  onStopped: (id: string) => void;
  onOpenSegments: (streamId: string) => void;
  onOpenByteRange?: (streamId: string) => void;
}

/** Grid-view counterpart to StreamsTable's row - same data/actions, card layout. */
function StreamCard({ stream, token, onStopped, onOpenSegments, onOpenByteRange }: StreamCardProps) {
  const { elapsed, stopping, handleStop } = useStreamRowActions(stream, token, onStopped);

  return (
    <StreamCardLayout
      youtubeId={stream.youtubeId}
      title={stream.title || stream.youtubeId}
      headerChips={
        <>
          <Tooltip title={formatModeLabel(stream.mode)}>
            <Chip size="small" label={formatModeChipLabel(stream.mode)} color={modeChipColor(stream.mode)} variant="filled" />
          </Tooltip>
          {stream.state === 'failed' && stream.error ? (
            <Tooltip title={stream.error}>
              <Chip size="small" label={STATE_CHIP_LABEL[stream.state]} color={STATE_CHIP_COLOR[stream.state]} variant="filled" />
            </Tooltip>
          ) : (
            <Chip size="small" label={STATE_CHIP_LABEL[stream.state]} color={STATE_CHIP_COLOR[stream.state]} variant="filled" />
          )}
        </>
      }
    >
      <StreamFormatChips
        quality={stream.quality}
        container={stream.container}
        transcode={stream.transcode}
        hardwareMode={stream.hardwareMode}
        mode={stream.mode}
      />

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
        <StreamCardStat label="Rate" value={formatStreamRate(stream)} />
        <StreamCardStat label="Total" value={formatStreamTotal(stream)} />
      </Box>

      <Box style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {stream.segments ? (
          <SegmentActivityStrip segments={stream.segments} variant={segmentVariantForMode(stream.mode)} onClick={() => onOpenSegments(stream.streamId)} />
        ) : stream.mode === 'hls-byterange' && onOpenByteRange ? (
          <ByteRangeProgressStrip
            youtubeId={stream.youtubeId}
            sessionKey={stream.streamId}
            token={token}
            onClick={() => onOpenByteRange(stream.streamId)}
          />
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
