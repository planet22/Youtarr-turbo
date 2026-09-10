import React from 'react';
import { Box, Chip, Tooltip } from '../../ui';
import { Storage as CachedVideoIcon } from '../../../lib/icons';
import { formatChipColor, ACTUAL_FILE_MODES } from '../utils';
import { SHARED_STATUS_CHIP_SMALL_STYLE, SHARED_COMPACT_CHIP_OVERRIDES } from '../../shared/chipStyles';

export interface StreamFormatChipsProps {
  quality: string | null;
  container: string | null;
  transcode: string | null;
  hardwareMode: string | null;
  mode: string;
  // Tighter chip sizing for the mobile list rows - same override other
  // mobile lists (e.g. VideosListMobile) use for their compact chip rows.
  compact?: boolean;
}

const CACHED_TOOLTIP =
  "Cached — serving the real, already-downloaded file directly, not a requested/configured format";

/**
 * One colored chip per format attribute (resolution / container / codec /
 * hardware), plus an icon-only "cached" chip, instead of a single merged
 * "1080p · mp4 · h264 · vaapi" chip - each value reads and scans on its own.
 * Shared by the table, grid-card, and mobile-list views on both the live
 * Streaming page and Stream History, so all of them render format info
 * identically.
 */
function StreamFormatChips({ quality, container, transcode, hardwareMode, mode, compact }: StreamFormatChipsProps) {
  const chipStyle: React.CSSProperties = compact
    ? { ...SHARED_STATUS_CHIP_SMALL_STYLE, ...SHARED_COMPACT_CHIP_OVERRIDES }
    : SHARED_STATUS_CHIP_SMALL_STYLE;
  const hasHardware = Boolean(hardwareMode && hardwareMode !== 'none');
  const isCached = ACTUAL_FILE_MODES.has(mode);

  if (!quality && !container && !transcode && !hasHardware && !isCached) {
    return <span style={{ color: 'var(--muted-foreground)' }}>—</span>;
  }

  return (
    <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {quality && (
        <Chip size="small" variant="outlined" color="primary" label={quality} style={chipStyle} />
      )}
      {container && (
        <Chip size="small" variant="outlined" color="secondary" label={container.toUpperCase()} style={chipStyle} />
      )}
      {transcode && (
        <Chip
          size="small"
          variant="outlined"
          color={formatChipColor(transcode, hardwareMode)}
          label={transcode === 'copy' ? 'Copy' : transcode.toUpperCase()}
          style={chipStyle}
        />
      )}
      {hasHardware && (
        <Chip size="small" variant="outlined" color="success" label={(hardwareMode as string).toUpperCase()} style={chipStyle} />
      )}
      {isCached && (
        <Tooltip title={CACHED_TOOLTIP}>
          <Chip
            size="small"
            variant="outlined"
            color="success"
            icon={<CachedVideoIcon size={compact ? 12 : 14} />}
            style={chipStyle}
          />
        </Tooltip>
      )}
    </Box>
  );
}

const EMPTY_CELL = <span style={{ color: 'var(--muted-foreground)' }}>—</span>;

// These per-column cells are only ever used inside StreamsTable /
// StreamHistoryTable's own Mode/Resolution/Container/Codec/HW/Cached
// columns, which are deliberately tight - tighter than SHARED_COMPACT_CHIP_OVERRIDES
// (used by the roomier grid-card/mobile-list rows), since each of these
// columns only ever holds one short chip. `padding` here overrides the
// Chip's own default horizontal padding (its `size="small"` Tailwind class).
export const FORMAT_COLUMN_CHIP_STYLE: React.CSSProperties = {
  ...SHARED_STATUS_CHIP_SMALL_STYLE,
  height: 20,
  padding: '0 4px',
};

// Chip's label <span> carries its own small default padding on top of the
// chip root's - zeroed out here so FORMAT_COLUMN_CHIP_STYLE's tight padding
// is the only spacing left, not padding-on-padding.
export const FORMAT_COLUMN_LABEL_CLASS = 'px-0';

/**
 * One-chip-per-table-column renderers - StreamFormatChips above wraps every
 * attribute into a single cell's chip row, which doesn't keep a given
 * attribute (e.g. resolution) lined up in its own column from row to row.
 * These instead each render exactly one cell's content, so StreamsTable /
 * StreamHistoryTable can give Resolution, Container, Codec, Hardware, and
 * Cached each their own <TableCell>.
 */
export function FormatResolutionCell({ quality }: { quality: string | null }) {
  if (!quality) return EMPTY_CELL;
  return <Chip size="small" variant="outlined" color="primary" label={quality} labelClassName={FORMAT_COLUMN_LABEL_CLASS} style={FORMAT_COLUMN_CHIP_STYLE} />;
}

export function FormatContainerCell({ container }: { container: string | null }) {
  if (!container) return EMPTY_CELL;
  return <Chip size="small" variant="outlined" color="secondary" label={container.toUpperCase()} labelClassName={FORMAT_COLUMN_LABEL_CLASS} style={FORMAT_COLUMN_CHIP_STYLE} />;
}

export function FormatCodecCell({ transcode, hardwareMode }: { transcode: string | null; hardwareMode: string | null }) {
  if (!transcode) return EMPTY_CELL;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={formatChipColor(transcode, hardwareMode)}
      label={transcode === 'copy' ? 'Copy' : transcode.toUpperCase()}
      labelClassName={FORMAT_COLUMN_LABEL_CLASS}
      style={FORMAT_COLUMN_CHIP_STYLE}
    />
  );
}

export function FormatHardwareCell({ hardwareMode }: { hardwareMode: string | null }) {
  if (!hardwareMode || hardwareMode === 'none') return EMPTY_CELL;
  return <Chip size="small" variant="outlined" color="success" label={hardwareMode.toUpperCase()} labelClassName={FORMAT_COLUMN_LABEL_CLASS} style={FORMAT_COLUMN_CHIP_STYLE} />;
}

export function FormatCachedCell({ mode }: { mode: string }) {
  if (!ACTUAL_FILE_MODES.has(mode)) return EMPTY_CELL;
  return (
    <Tooltip title={CACHED_TOOLTIP}>
      <Chip size="small" variant="outlined" color="success" icon={<CachedVideoIcon size={10} />} style={{ ...FORMAT_COLUMN_CHIP_STYLE, padding: '0 3px' }} />
    </Tooltip>
  );
}

export default StreamFormatChips;
