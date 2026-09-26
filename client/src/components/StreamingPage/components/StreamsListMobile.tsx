import React from 'react';
import { Box, Chip, Tooltip, IconButton, Typography, Link } from '../../ui';
import { Stop as StopIcon, Search as ProbeIcon } from '../../../lib/icons';
import { StreamSnapshot } from '../../../hooks/useActiveStreams';
import { YOUTUBE_URL_BASE } from '../../shared/VideoModal/constants';
import { formatStreamRate, formatStreamTotal, parseClientLabel, isLikelyProbeRequest, formatModeLabel, formatModeChipLabel, modeChipColor } from '../utils';
import { useStreamRowActions } from '../hooks/useStreamRowActions';
import { STATE_CHIP_COLOR, STATE_CHIP_LABEL } from './StreamsTable';
import { SegmentActivityStrip, segmentVariantForMode } from './SegmentActivityGrid';
import { ByteRangeProgressStrip } from './ByteRangeProgressGrid';
import StreamFormatChips from './StreamFormatChips';
import { SHARED_STATUS_CHIP_SMALL_STYLE, SHARED_COMPACT_CHIP_OVERRIDES } from '../../shared/chipStyles';
import StreamThumbnail from './StreamThumbnail';

export interface StreamsListMobileProps {
  streams: StreamSnapshot[];
  token: string | null;
  onStopped: (streamId: string) => void;
  onOpenSegments: (streamId: string) => void;
  onOpenByteRange?: (streamId: string) => void;
}

const COMPACT_CHIP_STYLE: React.CSSProperties = {
  ...SHARED_STATUS_CHIP_SMALL_STYLE,
  ...SHARED_COMPACT_CHIP_OVERRIDES,
};

/** Mobile-list-view counterpart to StreamsTable's row / StreamCard's tile - same data/actions, denser layout. */
function StreamListRow({
  stream,
  token,
  onStopped,
  onOpenSegments,
  onOpenByteRange,
}: {
  stream: StreamSnapshot;
  token: string | null;
  onStopped: (id: string) => void;
  onOpenSegments: (streamId: string) => void;
  onOpenByteRange?: (streamId: string) => void;
}) {
  const { elapsed, stopping, handleStop } = useStreamRowActions(stream, token, onStopped);

  return (
    <Box style={{ display: 'flex', gap: 10, padding: '10px 4px', borderBottom: '1px solid var(--border)' }}>
      <StreamThumbnail
        youtubeId={stream.youtubeId}
        alt={stream.title || stream.youtubeId}
        style={{ width: 96, height: 54, objectFit: 'cover', borderRadius: 'var(--radius-thumb)', flexShrink: 0 }}
      />
      <Box style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Link
          href={`${YOUTUBE_URL_BASE}${stream.youtubeId}`}
          target="_blank"
          rel="noopener noreferrer"
          underline="none"
          className="font-sans font-semibold"
          style={{
            fontSize: '0.85rem',
            lineHeight: 1.25,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {stream.title || stream.youtubeId}
        </Link>

        <Box style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <Tooltip title={formatModeLabel(stream.mode)}>
            <Chip size="small" label={formatModeChipLabel(stream.mode)} color={modeChipColor(stream.mode)} variant="filled" style={COMPACT_CHIP_STYLE} />
          </Tooltip>
          {stream.state === 'failed' && stream.error ? (
            <Tooltip title={stream.error}>
              <Chip size="small" label={STATE_CHIP_LABEL[stream.state]} color={STATE_CHIP_COLOR[stream.state]} variant="filled" style={COMPACT_CHIP_STYLE} />
            </Tooltip>
          ) : (
            <Chip size="small" label={STATE_CHIP_LABEL[stream.state]} color={STATE_CHIP_COLOR[stream.state]} variant="filled" style={COMPACT_CHIP_STYLE} />
          )}
        </Box>

        <StreamFormatChips
          quality={stream.quality}
          container={stream.container}
          transcode={stream.transcode}
          hardwareMode={stream.hardwareMode}
          mode={stream.mode}
          compact
        />

        <Tooltip title={stream.userAgent || 'No user-agent reported'}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
            <Typography variant="caption" style={{ fontSize: '0.7rem' }}>{stream.clientIp}</Typography>
            {isLikelyProbeRequest(stream.userAgent) && (
              <ProbeIcon size={12} style={{ color: 'var(--warning)' }} data-testid="ProbeIcon" />
            )}
            <Typography variant="caption" style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
              {parseClientLabel(stream.userAgent)}
              {stream.viewerCount && stream.viewerCount > 1 ? ` · +${stream.viewerCount - 1} viewers` : ''}
            </Typography>
          </Box>
        </Tooltip>

        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Typography variant="caption" style={{ fontSize: '0.65rem', color: 'var(--muted-foreground)' }}>
            {elapsed} · {formatStreamRate(stream)} · {formatStreamTotal(stream)}
          </Typography>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {stream.segments && (
              <SegmentActivityStrip segments={stream.segments} variant={segmentVariantForMode(stream.mode)} onClick={() => onOpenSegments(stream.streamId)} />
            )}
            {!stream.segments && stream.mode === 'hls-byterange' && onOpenByteRange && (
              <ByteRangeProgressStrip
                youtubeId={stream.youtubeId}
                sessionKey={stream.streamId}
                token={token}
                onClick={() => onOpenByteRange(stream.streamId)}
              />
            )}
            <Tooltip title="Stop stream">
              <span>
                <IconButton size="small" onClick={handleStop} disabled={stopping} aria-label="Stop stream">
                  <StopIcon size={16} />
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function StreamsListMobile({ streams, token, onStopped, onOpenSegments, onOpenByteRange }: StreamsListMobileProps) {
  return (
    <Box>
      {streams.map((stream) => (
        <StreamListRow
          key={stream.streamId}
          stream={stream}
          token={token}
          onStopped={onStopped}
          onOpenSegments={onOpenSegments}
          onOpenByteRange={onOpenByteRange}
        />
      ))}
    </Box>
  );
}

export default StreamsListMobile;
