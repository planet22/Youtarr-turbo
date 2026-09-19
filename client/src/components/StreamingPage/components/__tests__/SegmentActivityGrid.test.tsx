import React from 'react';
import { render, screen } from '@testing-library/react';
import { SegmentActivityDialog, segmentVariantForMode } from '../SegmentActivityGrid';
import type { StreamSegmentStatus } from '../../../../hooks/useActiveStreams';

const segments = (overrides: Partial<StreamSegmentStatus> = {}): StreamSegmentStatus => ({
  totalSegments: 4,
  segmentDurationSeconds: 5,
  encoded: [true, true, false, false],
  bufferedThroughIndex: 0,
  bufferComplete: false,
  currentSegmentIndex: 1,
  backfillSegmentIndex: null,
  ...overrides,
});

const renderDialog = (variant?: 'encode' | 'requested', status: StreamSegmentStatus = segments()) =>
  render(<SegmentActivityDialog open onClose={jest.fn()} title="A video" segments={status} variant={variant} />);

describe('segmentVariantForMode', () => {
  it('uses the requested display for youtube-hls', () => {
    expect(segmentVariantForMode('youtube-hls')).toBe('requested');
  });

  it.each(['hls', 'hls-buffer', 'hls-byterange', 'download-cache', 'direct'])('keeps the encode display for %s', (mode) => {
    expect(segmentVariantForMode(mode)).toBe('encode');
  });
});

describe('SegmentActivityDialog for encoded segments (hls, hls-buffer)', () => {
  it('says how many segments are encoded', () => {
    renderDialog();
    expect(screen.getByText(/2\/4 segments encoded \(50%\)/)).toBeInTheDocument();
  });

  it('names the segment being delivered with its time', () => {
    renderDialog();
    expect(screen.getByText(/Delivering segment 1 \(0:05\)/)).toBeInTheDocument();
  });

  it('shows all ready once every segment is encoded', () => {
    renderDialog('encode', segments({ encoded: [true, true, true, true], currentSegmentIndex: null }));
    expect(screen.getByText('All ready')).toBeInTheDocument();
  });

  it('describes an encoded cell', () => {
    renderDialog();
    expect(screen.getByTitle('Segment 0 · 0:00 · encoded, ready instantly')).toBeInTheDocument();
  });

  it('describes a segment that is not available yet', () => {
    renderDialog();
    expect(screen.getByTitle('Segment 3 · 0:15 · not yet available')).toBeInTheDocument();
  });

  it('describes the segment being delivered', () => {
    renderDialog();
    expect(screen.getByTitle('Segment 1 · 0:05 · encoded, ready instantly · currently delivering')).toBeInTheDocument();
  });

  it('keeps the buffered and backfill entries in the legend', () => {
    renderDialog();
    expect(screen.getByText('Buffered (fast seek)')).toBeInTheDocument();
    expect(screen.getByText('Currently being backfilled')).toBeInTheDocument();
  });

  it('uses the encode wording when no variant is given', () => {
    renderDialog(undefined);
    expect(screen.getByText('Encoded')).toBeInTheDocument();
  });
});

describe('SegmentActivityDialog for requested segments (youtube-hls)', () => {
  it('says how many segments the player has requested', () => {
    renderDialog('requested');
    expect(screen.getByText(/2\/4 segments requested by the player \(50%\)/)).toBeInTheDocument();
  });

  it('names the most recent request with its time', () => {
    renderDialog('requested');
    expect(screen.getByText(/Last requested segment 1 \(0:05\)/)).toBeInTheDocument();
  });

  it('says the whole video was requested once every segment has been', () => {
    renderDialog('requested', segments({ encoded: [true, true, true, true], currentSegmentIndex: null }));
    expect(screen.getByText('Whole video requested')).toBeInTheDocument();
  });

  it('describes a requested cell', () => {
    renderDialog('requested');
    expect(screen.getByTitle('Segment 0 · 0:00 · requested by the player')).toBeInTheDocument();
  });

  it('describes a segment not requested yet', () => {
    renderDialog('requested');
    expect(screen.getByTitle('Segment 3 · 0:15 · not requested yet')).toBeInTheDocument();
  });

  it('describes the most recent request', () => {
    renderDialog('requested');
    expect(screen.getByTitle('Segment 1 · 0:05 · requested by the player · most recent request')).toBeInTheDocument();
  });

  it('leaves the encode-only entries out of the legend', () => {
    renderDialog('requested');
    expect(screen.queryByText('Buffered (fast seek)')).not.toBeInTheDocument();
    expect(screen.queryByText('Currently being backfilled')).not.toBeInTheDocument();
    expect(screen.queryByText('Encoded')).not.toBeInTheDocument();
  });

  it('shows the requested legend', () => {
    renderDialog('requested');
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(screen.getByText('Most recent request')).toBeInTheDocument();
  });
});
