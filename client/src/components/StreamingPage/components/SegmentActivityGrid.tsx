import React, { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Tooltip, Box, Switch, FormControlLabel } from '../../ui';
import { StreamSegmentStatus } from '../../../hooks/useActiveStreams';

// Solid fills for the two "something is actively happening to this segment
// right now" states - deliberately not an outline (an outline over the
// segment's own encoded/buffered/not-yet color was hard to spot at a glance;
// a distinct solid fill reads immediately even at small sizes).
const DELIVERING_COLOR = 'darkgreen';
const BACKFILLING_COLOR = 'cyan';

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

/**
 * segmentColor, with the two "actively happening right now" states painted
 * as a solid override on top - delivering wins if a cell is somehow both
 * (rare, unrelated processes) since it's the more important signal for a
 * viewer.
 */
function cellColor(index: number, segments: StreamSegmentStatus): string {
  if (index === segments.currentSegmentIndex) return DELIVERING_COLOR;
  if (index === segments.backfillSegmentIndex) return BACKFILLING_COLOR;
  return segmentColor(index, segments);
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

// Real, fixed pixel dots (not stretched to fill an arbitrary footprint) -
// stretching a dot grid to fill a fixed box lands on sub-pixel,
// anti-aliased-into-a-blur cell sizes once `total` gets large. A gap around
// each dot (STRIP_GAP, applied as both the grid gap and the container's own
// padding) is what actually makes them read as individual pixels rather
// than a solid smear.
const STRIP_CELL_SIZE = 2;
const STRIP_GAP = 1;
// Target shape ("a line", not a square) used only to pick how cols/rows are
// split - the previous fixed STRIP_WIDTH/STRIP_HEIGHT footprint.
const STRIP_TARGET_ASPECT = 90 / 16;

/**
 * Picks a row/column split for `total` real 2x2px dots that stays close to
 * STRIP_TARGET_ASPECT's "a line, not a square" shape by packing along both
 * axes instead of squeezing everything into one row (which would run the
 * strip's width out arbitrarily far for a long video).
 */
function computeStripGrid(total: number): { cols: number; rows: number } {
  if (total <= 0) return { cols: 1, rows: 1 };
  const cols = Math.max(1, Math.min(total, Math.round(Math.sqrt(total * STRIP_TARGET_ASPECT))));
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
  const backfillSuffix = segments.backfillSegmentIndex !== null ? ` · backfilling segment ${segments.backfillSegmentIndex}` : '';

  return (
    <Tooltip title={`${encodedCount}/${segments.totalSegments} segments encoded (${pct}%)${currentSuffix}${backfillSuffix}${onClick ? ' · click for detail' : ''}`}>
      <Box
        onClick={onClick}
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, ${STRIP_CELL_SIZE}px)`,
          gridTemplateRows: `repeat(${rows}, ${STRIP_CELL_SIZE}px)`,
          gap: STRIP_GAP,
          cursor: onClick ? 'pointer' : 'default',
          border: `1px solid ${allReady ? 'var(--success)' : 'var(--border)'}`,
          borderRadius: 3,
          padding: STRIP_GAP,
          boxSizing: 'border-box',
          flexShrink: 0,
        }}
      >
        {segments.encoded.map((_isEncoded, i) => (
          <div key={i} style={{ backgroundColor: cellColor(i, segments) }} />
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
  const [expandedView, setExpandedView] = useState(false);
  if (!segments) return null;
  const encodedCount = countEncoded(segments);
  const pct = segments.totalSegments > 0 ? Math.round((encodedCount / segments.totalSegments) * 100) : 0;
  const allReady = encodedCount === segments.totalSegments;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Segment activity — {title}</DialogTitle>
      <DialogContent>
        <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <Typography variant="body2" style={{ marginBottom: 12 }}>
            {encodedCount}/{segments.totalSegments} segments encoded ({pct}%)
            {segments.currentSegmentIndex !== null && (
              <span style={{ color: 'var(--primary)', marginLeft: 8, fontWeight: 600 }}>
                Delivering segment {segments.currentSegmentIndex} ({formatSegmentTime(segments.currentSegmentIndex, segments)})
              </span>
            )}
            {segments.backfillSegmentIndex !== null && (
              <span style={{ color: 'var(--info)', marginLeft: 8, fontWeight: 600 }}>
                Backfilling segment {segments.backfillSegmentIndex} ({formatSegmentTime(segments.backfillSegmentIndex, segments)})
              </span>
            )}
            {allReady && (
              <span style={{ color: 'var(--success)', marginLeft: 8, fontWeight: 600 }}>All ready</span>
            )}
          </Typography>
          <FormControlLabel
            control={<Switch size="small" checked={expandedView} onChange={(e) => setExpandedView(e.target.checked)} />}
            label="Expanded view (segment numbers)"
          />
        </Box>

        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${expandedView ? 28 : 10}px, 1fr))`,
            gap: 2,
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          {segments.encoded.map((isEncoded, i) => {
            const isCurrent = i === segments.currentSegmentIndex;
            const isBackfilling = i === segments.backfillSegmentIndex;
            return (
              <div
                key={i}
                title={`Segment ${i} · ${formatSegmentTime(i, segments)}${
                  isEncoded ? ' · encoded, ready instantly' : i < segments.bufferedThroughIndex ? ' · buffered, fast seek' : ' · not yet available'
                }${isCurrent ? ' · currently delivering' : ''}${isBackfilling ? ' · currently being backfilled' : ''}`}
                style={{
                  width: '100%',
                  aspectRatio: '1 / 1',
                  borderRadius: 2,
                  backgroundColor: cellColor(i, segments),
                  display: expandedView ? 'flex' : undefined,
                  alignItems: expandedView ? 'center' : undefined,
                  justifyContent: expandedView ? 'center' : undefined,
                  fontSize: 9,
                  lineHeight: 1,
                  color: '#fff',
                  textShadow: expandedView ? '0 0 2px #000' : undefined,
                  userSelect: expandedView ? 'none' : undefined,
                }}
              >
                {expandedView ? i : null}
              </div>
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
            <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: DELIVERING_COLOR }} />
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>Currently delivering</Typography>
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: BACKFILLING_COLOR }} />
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>Currently being backfilled</Typography>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary">Close</Button>
      </DialogActions>
    </Dialog>
  );
};
