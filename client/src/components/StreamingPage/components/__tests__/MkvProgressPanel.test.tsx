import React from 'react';
import { render, screen } from '@testing-library/react';
import { MkvProgressPanel } from '../MkvProgressPanel';
import { buildSegmentCells, getMkvPercent } from '../mkvProgress';
import type { ByteRangeProgress } from '../../hooks/useByteRangeProgress';

const MB = 1024 * 1024;

function makeProgress(overrides: Partial<ByteRangeProgress> = {}, mkv: Partial<NonNullable<ByteRangeProgress['mkv']>> = {}): ByteRangeProgress {
  return {
    container: 'mkv',
    sessionKey: 'abc',
    youtubeId: 'vid',
    deliverAsFile: true,
    currentSizeBytes: 50 * MB,
    elapsedMs: 1000,
    ytVideoExitCode: null,
    ytAudioExitCode: null,
    ffExitCode: null,
    failed: false,
    failReason: null,
    complete: false,
    mkv: {
      durationSeconds: 40,
      declaredTotalBytes: 100 * MB,
      encodedSeconds: 15,
      clusterStartsMs: [0, 5000, 10000, 15000],
      clusterBytes: [MB, MB, MB, MB],
      cachedBytes: 0,
      resumeSeamMs: null,
      resumeState: null,
      ...mkv,
    },
    ...overrides,
  };
}

describe('getMkvPercent', () => {
  it('is 100 once the session is complete', () => {
    expect(getMkvPercent(makeProgress({ complete: true }))).toBe(100);
  });

  it('uses written bytes over the declared total when a total is declared', () => {
    expect(getMkvPercent(makeProgress())).toBe(50);
  });

  it('falls back to encoded time over duration when no total is declared', () => {
    expect(getMkvPercent(makeProgress({}, { declaredTotalBytes: null }))).toBe(37.5);
  });

  it('never reaches 100 while still running', () => {
    expect(getMkvPercent(makeProgress({ currentSizeBytes: 200 * MB }))).toBe(99);
  });

  it('is null when nothing says how far along it is', () => {
    expect(getMkvPercent(makeProgress({ currentSizeBytes: null }, { declaredTotalBytes: null, durationSeconds: null }))).toBeNull();
  });
});

describe('buildSegmentCells', () => {
  it('makes a done cell per written cluster except the one still being written', () => {
    const kinds = buildSegmentCells(makeProgress()).map((cell) => cell.kind);
    expect(kinds.slice(0, 4)).toEqual(['done', 'done', 'done', 'active']);
  });

  it('adds pending cells for the estimated remaining clusters', () => {
    expect(buildSegmentCells(makeProgress()).filter((cell) => cell.kind === 'pending')).toHaveLength(4);
  });

  it('marks every written cluster done once complete', () => {
    const cells = buildSegmentCells(makeProgress({ complete: true }));
    expect(cells.filter((cell) => cell.kind === 'active')).toHaveLength(0);
  });

  it('starts with cached cells for a resumed encode', () => {
    const cells = buildSegmentCells(makeProgress({}, { resumeSeamMs: 10000, clusterStartsMs: [10000], clusterBytes: [MB], encodedSeconds: 10 }));
    expect(cells.slice(0, 2).map((cell) => cell.kind)).toEqual(['cached', 'cached']);
  });

  it('shares cells between clusters for very long videos', () => {
    const cells = buildSegmentCells(makeProgress({}, { durationSeconds: 5 * 60 * 60 }));
    expect(cells.length).toBeLessThanOrEqual(1200);
  });

  it('keeps the same number of cells as clusters arrive', () => {
    const early = buildSegmentCells(makeProgress({}, { clusterStartsMs: [0], clusterBytes: [MB] }));
    const later = buildSegmentCells(makeProgress({}, { clusterStartsMs: [0, 4800, 10100, 15300, 20000], clusterBytes: [MB, MB, MB, MB, MB] }));
    expect(later).toHaveLength(early.length);
  });

  it('marks every slice done once complete, even when the last cluster starts before the video ends', () => {
    const starts = Array.from({ length: 1295 }, (_, i) => Math.round(i * 2109));
    const cells = buildSegmentCells(makeProgress({ complete: true }, { durationSeconds: 2732, clusterStartsMs: starts, clusterBytes: starts.map(() => MB) }));
    expect(cells.filter((cell) => cell.kind !== 'done')).toHaveLength(0);
  });

  it('returns no cells for a session without mkv detail', () => {
    expect(buildSegmentCells({ ...makeProgress(), mkv: undefined })).toEqual([]);
  });
});

describe('MkvProgressPanel', () => {
  it('shows the percentage', () => {
    render(<MkvProgressPanel progress={makeProgress()} bytesPerSecond={null} />);
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows the full length as encoded once complete, not the start of the last cluster', () => {
    render(<MkvProgressPanel progress={makeProgress({ complete: true }, { durationSeconds: 2732, encodedSeconds: 2729 })} bytesPerSecond={null} />);
    expect(screen.getByText(/2732s of 2732s/)).toBeInTheDocument();
  });

  it('shows how many segments have been written', () => {
    render(<MkvProgressPanel progress={makeProgress()} bytesPerSecond={null} />);
    expect(screen.getByText('4 segments written')).toBeInTheDocument();
  });

  it('renders the segment map', () => {
    render(<MkvProgressPanel progress={makeProgress()} bytesPerSecond={null} />);
    expect(screen.getByLabelText('Matroska segments')).toBeInTheDocument();
  });

  it('labels a written cluster with its start time and size', () => {
    render(<MkvProgressPanel progress={makeProgress()} bytesPerSecond={null} />);
    expect(screen.getByTitle('0:05 – 0:10 · 1.0 MB')).toBeInTheDocument();
  });

  it('lists the cached part in the legend only for a resumed encode', () => {
    render(<MkvProgressPanel progress={makeProgress()} bytesPerSecond={null} />);
    expect(screen.queryByText('Cached part (resumed from)')).not.toBeInTheDocument();
  });

  it('shows the cached part in the legend for a resumed encode', () => {
    render(<MkvProgressPanel progress={makeProgress({}, { resumeSeamMs: 45000, resumeState: 'ok' })} bytesPerSecond={null} />);
    expect(screen.getByText('Cached part (resumed from)')).toBeInTheDocument();
  });

  it('says so when a resume did not line up', () => {
    render(<MkvProgressPanel progress={makeProgress({}, { resumeSeamMs: 10000, resumeState: 'mismatch' })} bytesPerSecond={null} />);
    expect(screen.getByText(/did not line up/)).toBeInTheDocument();
  });

  it('mentions the cached part for a resumed encode', () => {
    render(<MkvProgressPanel progress={makeProgress({}, { resumeSeamMs: 45000, resumeState: 'ok' })} bytesPerSecond={null} />);
    expect(screen.getByText(/the cached part \(yellow, first 45s\) is joined/)).toBeInTheDocument();
  });
});
