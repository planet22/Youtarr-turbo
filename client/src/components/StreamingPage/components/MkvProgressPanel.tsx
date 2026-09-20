import React, { useMemo } from 'react';
import { Typography, Box, LinearProgress } from '../../ui';
import { formatByteSize } from '../../../utils/formatters';
import { formatBytesPerSecond } from '../utils';
import type { ByteRangeProgress } from '../hooks/useByteRangeProgress';
import { buildSegmentCells, getMkvPercent } from './mkvProgress';
import type { SegmentKind } from './mkvProgress';

interface MkvProgressPanelProps {
  progress: ByteRangeProgress;
  bytesPerSecond: number | null;
}

const CELL_STYLES: Record<SegmentKind, React.CSSProperties> = {
  cached: { background: 'var(--warning)' },
  done: { background: 'var(--primary)' },
  active: { background: 'var(--primary)', opacity: 0.5 },
  pending: { background: 'var(--muted)' },
};

const LEGEND: { kind: SegmentKind; label: string }[] = [
  { kind: 'cached', label: 'Cached part (resumed from)' },
  { kind: 'done', label: 'Written' },
  { kind: 'active', label: 'Writing' },
  { kind: 'pending', label: 'Waiting' },
];

/** Progress popup body for an mkv session: 0-100%, plus a map of the file's real Matroska clusters. */
export const MkvProgressPanel: React.FC<MkvProgressPanelProps> = ({ progress, bytesPerSecond }) => {
  const percent = getMkvPercent(progress);
  const cells = useMemo(() => buildSegmentCells(progress), [progress]);
  const mkv = progress.mkv;
  const written = formatByteSize(progress.currentSizeBytes ?? 0);
  const declared = mkv?.declaredTotalBytes ? formatByteSize(mkv.declaredTotalBytes) : null;
  const segmentCount = mkv ? mkv.clusterStartsMs.length : 0;

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Typography variant="h5">{percent === null ? '…' : `${Math.floor(percent)}%`}</Typography>
      <LinearProgress
        variant={percent === null ? 'indeterminate' : 'determinate'}
        value={percent ?? 0}
        color={progress.failed ? 'error' : progress.complete ? 'success' : 'primary'}
      />
      <Typography variant="body2">
        {written}{declared ? ` of ${declared}` : ' written'}
        {bytesPerSecond !== null && ` · ${formatBytesPerSecond(bytesPerSecond)}`}
        {mkv && mkv.durationSeconds && (progress.complete || mkv.encodedSeconds !== null)
          ? ` · ${Math.floor(progress.complete ? mkv.durationSeconds : (mkv.encodedSeconds ?? 0))}s of ${Math.floor(mkv.durationSeconds)}s`
          : ''}
      </Typography>
      {mkv && mkv.resumeSeamMs !== null && (
        <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
          {mkv.resumeState === 'mismatch'
            ? 'Resume did not line up with the cached part - abandoned'
            : `Resumed: the cached part (yellow, first ${Math.floor(mkv.resumeSeamMs / 1000)}s) is joined to the new download at that point`}
        </Typography>
      )}
      <Box
        aria-label="Matroska segments"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(8px, 1fr))', gap: 2 }}
      >
        {cells.map((cell, index) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            title={cell.label}
            data-kind={cell.kind}
            style={{ height: 8, borderRadius: 2, ...CELL_STYLES[cell.kind] }}
          />
        ))}
      </Box>
      <Box style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        {LEGEND.filter((entry) => entry.kind !== 'cached' || (mkv && mkv.resumeSeamMs !== null)).map((entry) => (
          <span key={entry.kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span data-kind={entry.kind} style={{ width: 8, height: 8, borderRadius: 2, display: 'inline-block', ...CELL_STYLES[entry.kind] }} />
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>{entry.label}</Typography>
          </span>
        ))}
      </Box>
      <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
        {`${segmentCount} segment${segmentCount === 1 ? '' : 's'} written`}
      </Typography>
    </Box>
  );
};
