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

interface SegmentActivityStripProps {
  segments: StreamSegmentStatus;
  onClick?: () => void;
}

/**
 * Compact inline indicator for a table row - one flex item per segment,
 * squeezed into a fixed pixel width (naturally blends into a heatmap-style
 * strip at typical segment counts rather than showing individually
 * distinguishable dots - the detailed per-segment grid lives in
 * SegmentActivityDialog instead, opened by clicking this strip).
 */
export const SegmentActivityStrip: React.FC<SegmentActivityStripProps> = ({ segments, onClick }) => {
  const encodedCount = countEncoded(segments);
  const pct = segments.totalSegments > 0 ? Math.round((encodedCount / segments.totalSegments) * 100) : 0;
  const allReady = encodedCount === segments.totalSegments;

  return (
    <Tooltip title={`${encodedCount}/${segments.totalSegments} segments encoded (${pct}%)${onClick ? ' · click for detail' : ''}`}>
      <Box
        onClick={onClick}
        style={{
          display: 'flex',
          width: 90,
          height: 16,
          cursor: onClick ? 'pointer' : 'default',
          border: `1px solid ${allReady ? 'var(--success)' : 'var(--border)'}`,
          borderRadius: 3,
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {segments.encoded.map((isEncoded, i) => (
          <div
            key={i}
            style={{
              flex: '1 1 0',
              minWidth: 0,
              backgroundColor: segmentColor(i, segments),
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
          {segments.encoded.map((isEncoded, i) => (
            <div
              key={i}
              title={`Segment ${i} · ${formatSegmentTime(i, segments)}${
                isEncoded ? ' · encoded, ready instantly' : i < segments.bufferedThroughIndex ? ' · buffered, fast seek' : ' · not yet available'
              }`}
              style={{
                width: '100%',
                aspectRatio: '1 / 1',
                borderRadius: 2,
                backgroundColor: segmentColor(i, segments),
              }}
            />
          ))}
        </Box>

        <Box style={{ display: 'flex', gap: 16, marginTop: 12 }}>
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
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary">Close</Button>
      </DialogActions>
    </Dialog>
  );
};
