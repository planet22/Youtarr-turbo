import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Tooltip, Box } from '../../ui';
import { StreamSegmentStatus } from '../../../hooks/useActiveStreams';

/**
 * Colors one segment's cell. `encoded` (a real file on disk right now, see
 * computeSegmentStatus server-side) always wins; `bufferedThroughIndex`
 * covers the "would be a fast local seek, but hasn't actually been
 * transcoded into this session's own segment yet" middle state - the same
 * distinction ensureHlsSegmentAvailable's restart-vs-wait decision makes.
 */
function segmentColor(index: number, segments: StreamSegmentStatus): string {
  if (segments.encoded[index]) return 'var(--success)';
  if (index < segments.bufferedThroughIndex) return 'var(--warning)';
  return 'var(--border)';
}

// Always reads segments.segmentDurationSeconds (never a hardcoded 4) so this
// stays correct if the server-side segment length ever changes.
function formatSegmentTime(index: number, segments: StreamSegmentStatus): string {
  const totalSeconds = Math.round(index * segments.segmentDurationSeconds);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function countEncoded(segments: StreamSegmentStatus): number {
  let count = 0;
  for (const isEncoded of segments.encoded) {
    if (isEncoded) count += 1;
  }
  return count;
}

const STRIP_WIDTH = 90;
const STRIP_HEIGHT = 16;

/**
 * Picks a row/column split for `total` cells that (a) fills the strip's
 * fixed footprint edge-to-edge via `1fr` tracks (so it never overflows or
 * needs clipping) and (b) stays as close as possible to real 2x2px dots -
 * the same visual unit SegmentActivityDialog's full grid uses - by packing
 * along both axes instead of squeezing everything into one row. A one-row
 * flex strip (the previous approach) puts all of the density on a single
 * axis, so it hits sub-pixel, anti-aliased-into-a-blur cell widths at a
 * small fraction of the segment count this reaches before doing the same.
 */
function computeStripGrid(total: number): { cols: number; rows: number } {
  if (total <= 0) return { cols: 1, rows: 1 };
  const aspect = STRIP_WIDTH / STRIP_HEIGHT;
  const cols = Math.max(1, Math.min(total, Math.round(Math.sqrt(total * aspect))));
  const rows = Math.max(1, Math.ceil(total / cols));
  return { cols, rows };
}

interface SegmentActivityStripProps {
  segments: StreamSegmentStatus;
  onClick?: () => void;
}

/**
 * Compact inline indicator for a table row - a small two-axis dot grid
 * (see computeStripGrid) squeezed into a fixed pixel footprint, mirroring
 * SegmentActivityDialog's full grid at a much smaller scale rather than a
 * single-row bar. The detailed, individually-labeled grid still lives in
 * SegmentActivityDialog, opened by clicking this strip.
 */
export const SegmentActivityStrip: React.FC<SegmentActivityStripProps> = ({ segments, onClick }) => {
  const encodedCount = countEncoded(segments);
  const pct = segments.totalSegments > 0 ? Math.round((encodedCount / segments.totalSegments) * 100) : 0;
  const allReady = encodedCount === segments.totalSegments;
  const { cols, rows } = computeStripGrid(segments.totalSegments);
  const currentSuffix = segments.currentSegmentIndex !== null ? ` · delivering segment ${segments.currentSegmentIndex}` : '';

  return (
    <Tooltip title={`${encodedCount}/${segments.totalSegments} segments encoded (${pct}%)${currentSuffix}${onClick ? ' · click for detail' : ''}`}>
      <Box
        onClick={onClick}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
          gap: 1,
          width: STRIP_WIDTH,
          height: STRIP_HEIGHT,
          cursor: onClick ? 'pointer' : 'default',
          border: `1px solid ${allReady ? 'var(--success)' : 'var(--border)'}`,
          borderRadius: 3,
          padding: 1,
          boxSizing: 'border-box',
          flexShrink: 0,
        }}
      >
        {segments.encoded.map((isEncoded, i) => (
          <div
            key={i}
            style={{
              backgroundColor: segmentColor(i, segments),
              outline: i === segments.currentSegmentIndex ? '1px solid var(--info)' : undefined,
            }}
          />
        ))}
      </Box>
    </Tooltip>
  );
};

interface SegmentActivityDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  segments: StreamSegmentStatus | null;
}

/**
 * Full GitHub-activity-style grid, one visible square per segment, opened
 * by clicking a row's SegmentActivityStrip. Cell tooltips use the native
 * `title` attribute rather than the ui Tooltip component - this can be a
 * few hundred cells re-rendering every 1.5s (streamProgress's tick), and a
 * few hundred live Tooltip instances would be needless overhead for
 * something this simple.
 */
export const SegmentActivityDialog: React.FC<SegmentActivityDialogProps> = ({ open, onClose, title, segments }) => {
  if (!segments) return null;
  const encodedCount = countEncoded(segments);
  const pct = segments.totalSegments > 0 ? Math.round((encodedCount / segments.totalSegments) * 100) : 0;
  const allReady = encodedCount === segments.totalSegments;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Segment activity — {title}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" style={{ marginBottom: 12 }}>
          {encodedCount}/{segments.totalSegments} segments encoded ({pct}%)
          {segments.currentSegmentIndex !== null && (
            <span style={{ color: 'var(--info)', marginLeft: 8, fontWeight: 600 }}>
              Delivering segment {segments.currentSegmentIndex} ({formatSegmentTime(segments.currentSegmentIndex, segments)})
            </span>
          )}
          {allReady && (
            <span style={{ color: 'var(--success)', marginLeft: 8, fontWeight: 600 }}>All ready</span>
          )}
        </Typography>

        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(10px, 1fr))',
            gap: 2,
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {segments.encoded.map((isEncoded, i) => {
            const isCurrent = i === segments.currentSegmentIndex;
            return (
              <div
                key={i}
                title={`Segment ${i} · ${formatSegmentTime(i, segments)}${
                  isEncoded ? ' · encoded, ready instantly' : i < segments.bufferedThroughIndex ? ' · buffered, fast seek' : ' · not yet available'
                }${isCurrent ? ' · currently delivering' : ''}`}
                style={{
                  width: '100%',
                  aspectRatio: '1 / 1',
                  borderRadius: 2,
                  backgroundColor: segmentColor(i, segments),
                  outline: isCurrent ? '2px solid var(--info)' : undefined,
                  outlineOffset: isCurrent ? -1 : undefined,
                }}
              />
            );
          })}
        </Box>

        <Box style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: 'var(--success)' }} />
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>Encoded</Typography>
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: 'var(--warning)' }} />
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>Buffered (fast seek)</Typography>
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: 'var(--border)' }} />
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>Not yet</Typography>
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, outline: '2px solid var(--info)', outlineOffset: -1 }} />
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>Currently delivering</Typography>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary">Close</Button>
      </DialogActions>
    </Dialog>
  );
};
