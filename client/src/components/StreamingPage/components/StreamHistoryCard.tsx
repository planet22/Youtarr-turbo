import React from 'react';
import { Chip, Tooltip, Box, Typography, Checkbox } from '../../ui';
import { formatFileSize } from '../../../utils/formatters';
import { StreamHistoryRow } from '../../../hooks/useStreamHistory';
import { parseClientLabel, formatModeLabel, formatModeChipLabel, modeChipColor, ACTUAL_FILE_MODES } from '../utils';
import { resultChipFor, formatDetail, formatStarted, formatDuration } from './StreamHistoryTable';
import StreamCardLayout, { StreamCardStat } from './StreamCardLayout';

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
          {ACTUAL_FILE_MODES.has(row.mode) && (
            <Tooltip title="Serving the real, already-downloaded file directly - this is that file's own actual quality/container, not a requested or configured value">
              <Chip size="small" variant="outlined" color="success" label="Cached" />
            </Tooltip>
          )}
        </>
      }
    >
      <Tooltip title={`hardware: ${row.hardwareMode || 'none'}`}>
        <Typography variant="caption" color="secondary" style={{ display: 'block' }}>
          {formatDetail(row)}
        </Typography>
      </Tooltip>

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
