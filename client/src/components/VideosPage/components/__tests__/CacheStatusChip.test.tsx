import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CacheStatusChip from '../CacheStatusChip';
import { VideoData } from '../../../../types/VideoData';

const baseVideo: VideoData = {
  id: 1,
  youtubeId: 'abc',
  youTubeChannelName: 'Channel',
  youTubeVideoName: 'Video',
  timeCreated: '2024-01-15T10:30:00',
  originalDate: '20240110',
  duration: 600,
  description: null,
  filePath: null,
  fileSize: null,
  removed: false,
  protected: false,
};

const renderChip = (video: Partial<VideoData>, kind: 'cached' | 'stealth', onClick = jest.fn()) => {
  render(
    <CacheStatusChip
      video={{ ...baseVideo, ...video }}
      kind={kind}
      isTracked
      iconSize={14}
      style={{}}
      onClick={onClick}
    />
  );
  return onClick;
};

describe('CacheStatusChip', () => {
  describe('stealth kind', () => {
    it('renders nothing when the row has no stealth cache', () => {
      renderChip({ hasStealthCache: false }, 'stealth');
      expect(screen.queryByText(/Cached|Partial/)).not.toBeInTheDocument();
    });

    it('shows the cached size for a complete stealth cache', () => {
      renderChip({ hasStealthCache: true, stealthCacheFileSize: 1048576 }, 'stealth');
      expect(screen.getByText('1MB')).toBeInTheDocument();
    });

    it('falls back to "Cached" when the size is unknown', () => {
      renderChip({ hasStealthCache: true }, 'stealth');
      expect(screen.getByText('Cached')).toBeInTheDocument();
    });

    it('marks a partial stealth cache as Partial together with its size', () => {
      renderChip({ hasStealthCache: true, stealthCachePartial: true, stealthCacheFileSize: 1048576 }, 'stealth');
      expect(screen.getByText('Partial · 1MB')).toBeInTheDocument();
    });

    it('does not label a partial stealth cache as a plain cached size', () => {
      renderChip({ hasStealthCache: true, stealthCachePartial: true, stealthCacheFileSize: 1048576 }, 'stealth');
      expect(screen.queryByText('1MB')).not.toBeInTheDocument();
    });

    it('calls onClick when clicked', () => {
      const onClick = renderChip({ hasStealthCache: true, stealthCacheFileSize: 1048576 }, 'stealth');
      fireEvent.click(screen.getByText('1MB'));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('cached kind', () => {
    it('renders nothing when the row has no cached video', () => {
      renderChip({ hasCachedVideo: false }, 'cached');
      expect(screen.queryByText(/Cached|Partial/)).not.toBeInTheDocument();
    });

    it('shows "Cached" for a complete cached video with no expiry', () => {
      renderChip({ hasCachedVideo: true, cachedVideoExpiresAt: null }, 'cached');
      expect(screen.getByText('Cached')).toBeInTheDocument();
    });

    it('marks a partial cached video as Partial', () => {
      renderChip({ hasCachedVideo: true, cachedVideoPartial: true }, 'cached');
      expect(screen.getByText('Partial')).toBeInTheDocument();
    });
  });
});
