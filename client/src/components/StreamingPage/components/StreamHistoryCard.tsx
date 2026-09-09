import React from 'react';
import { Chip, Tooltip, Box, Typography, Checkbox } from '../../ui';
import { formatFileSize } from '../../../utils/formatters';
import { StreamHistoryRow } from '../../../hooks/useStreamHistory';
import { parseClientLabel, formatModeLabel, formatModeChipLabel, modeChipColor } from '../utils';
import { resultChipFor, formatStarted, formatDuration } from './StreamHistoryTable';
import StreamCardLayout, { StreamCardStat } from './StreamCardLayout';
import StreamFormatChips from './StreamFormatChips';

export interface StreamHistoryCardProps {
  row: StreamHistoryRow;
  isSelected: boolean;
  onToggleSelect: (streamId: string) => void;
}

/** Grid-view counterpart to StreamHistoryTable's row - same data, card layout. */
function StreamHistoryCard({ row, isSelected, onToggleSelect }: StreamHistoryCardProps) {
  const chip = resultChipFor(row);
  const chipElement = <Chip size="small" label={chip.label} color={chip.color} variant="filled" />;

  return (
    <StreamCardLayout
      youtubeId={row.youtubeId}
      title={row.title || row.youtubeId}
      thumbnailOverlay={
        <Checkbox
          checked={isSelected}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleSelect(row.streamId)}
          inputProps={{ 'aria-label': `Select ${row.title || row.youtubeId}` }}
          style={{
            position: 'absolute',
            top: 4,
            left: 4,
            backgroundColor: 'var(--media-overlay-background)',
            color: 'var(--media-overlay-foreground)',
          }}
        />
      }
      headerChips={
        <>
          <Tooltip title={formatModeLabel(row.mode)}>
            <Chip size="small" label={formatModeChipLabel(row.mode)} color={modeChipColor(row.mode)} variant="filled" />
          </Tooltip>
          {row.errorMessage ? <Tooltip title={row.errorMessage}>{chipElement}</Tooltip> : chipElement}
        </>
      }
    >
      <StreamFormatChips
        quality={row.quality}
        container={row.container}
        transcode={row.transcode}
        hardwareMode={row.hardwareMode}
        mode={row.mode}
      />

      <Tooltip title={row.userAgent || 'No user-agent reported'}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <Typography variant="body2">{row.clientIp}</Typography>
          <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
            {parseClientLabel(row.userAgent)}
          </Typography>
        </Box>
      </Tooltip>

      <Box className="grid grid-cols-2 gap-x-2 gap-y-1">
        <StreamCardStat label="Started" value={formatStarted(row.startedAt)} />
        <StreamCardStat label="Duration" value={formatDuration(row)} />
        <StreamCardStat label="Total" value={formatFileSize(row.bytesTransferred) || '0MB'} />
      </Box>
    </StreamCardLayout>
  );
}

export default StreamHistoryCard;
