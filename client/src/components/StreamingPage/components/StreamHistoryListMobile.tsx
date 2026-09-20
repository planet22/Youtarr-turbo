import React from 'react';
import { Box, Chip, Tooltip, Typography, Checkbox } from '../../ui';
import { formatByteSize } from '../../../utils/formatters';
import { StreamHistoryRow } from '../../../hooks/useStreamHistory';
import { parseClientLabel, formatModeLabel, formatModeChipLabel, modeChipColor } from '../utils';
import { resultChipFor, formatStarted, formatDuration } from './StreamHistoryTable';
import StreamFormatChips from './StreamFormatChips';
import { SHARED_STATUS_CHIP_SMALL_STYLE, SHARED_COMPACT_CHIP_OVERRIDES } from '../../shared/chipStyles';

export interface StreamHistoryListMobileProps {
  rows: StreamHistoryRow[];
  selectedIds: string[];
  onToggleSelect: (streamId: string) => void;
}

const COMPACT_CHIP_STYLE: React.CSSProperties = {
  ...SHARED_STATUS_CHIP_SMALL_STYLE,
  ...SHARED_COMPACT_CHIP_OVERRIDES,
};

/** Mobile-list-view counterpart to StreamHistoryTable's row / StreamHistoryCard's tile - same data, denser layout. */
function StreamHistoryListMobile({ rows, selectedIds, onToggleSelect }: StreamHistoryListMobileProps) {
  return (
    <Box>
      {rows.map((row) => {
        const isSelected = selectedIds.includes(row.streamId);
        const chip = resultChipFor(row);
        const chipElement = (
          <Chip size="small" label={chip.label} color={chip.color} variant="filled" style={COMPACT_CHIP_STYLE} />
        );

        return (
          <Box
            key={row.streamId}
            role="button"
            tabIndex={0}
            onClick={() => onToggleSelect(row.streamId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggleSelect(row.streamId);
              }
            }}
            style={{
              display: 'flex',
              gap: 10,
              padding: '10px 4px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              backgroundColor: isSelected ? 'var(--muted)' : undefined,
            }}
          >
            <Box style={{ position: 'relative', flexShrink: 0, width: 96, height: 54 }} onClick={(e) => e.stopPropagation()}>
              <Box
                component="img"
                src={`/images/videothumb-${row.youtubeId}.jpg`}
                alt={row.title || row.youtubeId}
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-thumb)' }}
              />
              <Checkbox
                checked={isSelected}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onToggleSelect(row.streamId)}
                inputProps={{ 'aria-label': `Select ${row.title || row.youtubeId}` }}
                style={{
                  position: 'absolute',
                  top: -6,
                  left: -6,
                  padding: 2,
                  backgroundColor: 'var(--media-overlay-background)',
                  color: 'var(--media-overlay-foreground)',
                }}
              />
            </Box>

            <Box style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Typography
                variant="subtitle2"
                className="font-semibold"
                style={{
                  fontSize: '0.85rem',
                  lineHeight: 1.25,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {row.title || row.youtubeId}
              </Typography>

              <Box style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                <Tooltip title={formatModeLabel(row.mode)}>
                  <Chip size="small" label={formatModeChipLabel(row.mode)} color={modeChipColor(row.mode)} variant="filled" style={COMPACT_CHIP_STYLE} />
                </Tooltip>
                {row.errorMessage ? <Tooltip title={row.errorMessage}>{chipElement}</Tooltip> : chipElement}
              </Box>

              <StreamFormatChips
                quality={row.quality}
                container={row.container}
                transcode={row.transcode}
                hardwareMode={row.hardwareMode}
                mode={row.mode}
                compact
              />

              <Tooltip title={row.userAgent || 'No user-agent reported'}>
                <Typography variant="caption" style={{ fontSize: '0.7rem' }}>
                  {row.clientIp}
                  {row.clientIp ? ' · ' : ''}
                  {parseClientLabel(row.userAgent)}
                </Typography>
              </Tooltip>

              <Typography variant="caption" style={{ fontSize: '0.65rem', color: 'var(--muted-foreground)' }}>
                {formatStarted(row.startedAt)} · {formatDuration(row)} · {formatByteSize(row.bytesTransferred ?? 0)}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export default StreamHistoryListMobile;
