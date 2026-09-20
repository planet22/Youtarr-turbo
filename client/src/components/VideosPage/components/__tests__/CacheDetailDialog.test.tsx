import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CacheDetailDialog, { CacheDetailDialogProps } from '../CacheDetailDialog';
import { VideoData } from '../../../../types/VideoData';
import { MetadataCacheDetail, UntrackedCacheDetail } from '../../hooks/useCacheActions';

const mockFetchMetadataDetail = jest.fn();
const mockFetchVideoCacheDetail = jest.fn();
const mockRefreshMetadataCache = jest.fn();

jest.mock('../../hooks/useCacheActions', () => ({
  useCacheActions: () => ({
    fetchMetadataDetail: mockFetchMetadataDetail,
    fetchVideoCacheDetail: mockFetchVideoCacheDetail,
    refreshMetadataCache: mockRefreshMetadataCache,
  }),
}));

const baseVideo: VideoData = {
  id: 1,
  youtubeId: 'abc123DEF45',
  youTubeChannelName: 'Library Channel',
  youTubeVideoName: 'Library Title',
  timeCreated: '2024-01-15T10:30:00',
  originalDate: '20240110',
  duration: 600,
  description: null,
  filePath: '/media/Channel/Video.mp4',
  fileSize: '52428800',
  removed: false,
  protected: false,
};

const metadataDetail = (overrides: Partial<MetadataCacheDetail> = {}): MetadataCacheDetail => ({
  youtubeId: 'abc123DEF45',
  durationSeconds: 600,
  fetchedAt: '2026-01-01T00:00:00Z',
  fetchedAgo: '2 days ago',
  lastAccessedAt: '2026-01-02T00:00:00Z',
  lastAccessedAgo: '1 day ago',
  expiresAt: null,
  title: 'Cached Title',
  uploader: 'Cached Uploader',
  resolution: '1920x1080',
  fps: 30,
  uploadDate: '20240110',
  hasRawInfoJson: true,
  ...overrides,
});

type DialogOverrides = Omit<Partial<CacheDetailDialogProps>, 'video'> & { video?: Partial<VideoData> };

function renderDialog(props: DialogOverrides = {}) {
  const { video, ...rest } = props;
  const onClose = jest.fn();
  const onClear = jest.fn();
  const onRefreshed = jest.fn();
  const utils = render(
    <CacheDetailDialog
      open
      onClose={onClose}
      video={{ ...baseVideo, ...video } as VideoData}
      kind="metadata"
      token="tok"
      onClear={onClear}
      clearing={false}
      onRefreshed={onRefreshed}
      {...rest}
    />
  );
  return { ...utils, onClose, onClear, onRefreshed };
}

describe('CacheDetailDialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchMetadataDetail.mockResolvedValue(metadataDetail());
    mockFetchVideoCacheDetail.mockResolvedValue({ exists: true, size: 104857600, mtime: '2026-01-03T00:00:00Z' } as UntrackedCacheDetail);
    mockRefreshMetadataCache.mockResolvedValue(true);
  });

  describe('when closed', () => {
    it('renders nothing', () => {
      renderDialog({ open: false });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not fetch any detail', () => {
      renderDialog({ open: false });

      expect(mockFetchMetadataDetail).not.toHaveBeenCalled();
      expect(mockFetchVideoCacheDetail).not.toHaveBeenCalled();
    });
  });

  describe('metadata kind', () => {
    it('is titled Cached Metadata', async () => {
      renderDialog();

      expect(await screen.findByText('Cached Metadata')).toBeInTheDocument();
    });

    it('loads the detail for the video', async () => {
      renderDialog();

      await waitFor(() => expect(mockFetchMetadataDetail).toHaveBeenCalledWith('abc123DEF45'));
    });

    it('shows a loading message until the detail arrives', async () => {
      mockFetchMetadataDetail.mockReturnValue(new Promise(() => {}));
      renderDialog();

      expect(await screen.findByText('Loading…')).toBeInTheDocument();
    });

    it('shows the cached title and uploader', async () => {
      renderDialog();

      expect(await screen.findByText('Cached Title')).toBeInTheDocument();
      expect(screen.getByText('Cached Uploader')).toBeInTheDocument();
    });

    it('falls back to the library title and channel when the cache has none', async () => {
      mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ title: null, uploader: null }));
      renderDialog();

      expect(await screen.findByText('Library Title')).toBeInTheDocument();
      expect(screen.getByText('Library Channel')).toBeInTheDocument();
    });

    it('shows resolution, fps and the pre-formatted ages', async () => {
      renderDialog();

      expect(await screen.findByText('1920x1080')).toBeInTheDocument();
      expect(screen.getByText('30')).toBeInTheDocument();
      expect(screen.getByText('2 days ago')).toBeInTheDocument();
      expect(screen.getByText('1 day ago')).toBeInTheDocument();
    });

    it('omits rows that have no value', async () => {
      mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ resolution: null, fps: null }));
      renderDialog();

      await screen.findByText('Cached Title');

      expect(screen.queryByText('Resolution')).not.toBeInTheDocument();
      expect(screen.queryByText('FPS')).not.toBeInTheDocument();
    });

    it('says the cache never expires when there is no expiry', async () => {
      renderDialog();

      await screen.findByText('Cached Title');

      expect(screen.getByText('Never')).toBeInTheDocument();
    });

    it('counts down to a known expiry', async () => {
      mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString() }));
      renderDialog();

      expect(await screen.findByText('Expires in 5d')).toBeInTheDocument();
      expect(screen.queryByText('Never')).not.toBeInTheDocument();
    });

    it('closes from the Close button', async () => {
      const { onClose } = renderDialog();
      await screen.findByText('Cached Title');

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));

      expect(onClose).toHaveBeenCalled();
    });

    it('clears the cache from the Clear button', async () => {
      const { onClear } = renderDialog();
      await screen.findByText('Cached Title');

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

      expect(onClear).toHaveBeenCalled();
    });

    it('disables Clear while a clear is in progress', async () => {
      renderDialog({ clearing: true });
      await screen.findByText('Cached Title');

      expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    });

    describe('refresh', () => {
      it('refreshes the cache, reloads the detail and tells the parent', async () => {
        const { onRefreshed } = renderDialog();
        await screen.findByText('Cached Title');
        mockFetchMetadataDetail.mockClear();

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        await waitFor(() => expect(onRefreshed).toHaveBeenCalled());
        expect(mockRefreshMetadataCache).toHaveBeenCalledWith('abc123DEF45');
        expect(mockFetchMetadataDetail).toHaveBeenCalledWith('abc123DEF45', false);
      });

      it('shows the refreshed values', async () => {
        renderDialog();
        await screen.findByText('Cached Title');
        mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ title: 'Refreshed Title' }));

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByText('Refreshed Title')).toBeInTheDocument();
      });

      it('is disabled and labelled while refreshing', async () => {
        renderDialog();
        await screen.findByText('Cached Title');
        mockRefreshMetadataCache.mockReturnValue(new Promise(() => {}));

        fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

        expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled();
      });
    });

    describe('raw JSON', () => {
      it('fetches the raw blob the first time the section is opened', async () => {
        mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ rawInfoJson: { id: 'abc', formats: [] } }));
        renderDialog();
        await screen.findByText('Cached Title');
        mockFetchMetadataDetail.mockClear();

        fireEvent.click(screen.getByText('Show Raw JSON'));

        await waitFor(() => expect(mockFetchMetadataDetail).toHaveBeenCalledWith('abc123DEF45', true));
      });

      it('shows the blob pretty printed', async () => {
        mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ rawInfoJson: { id: 'abc' } }));
        renderDialog();
        await screen.findByText('Cached Title');

        fireEvent.click(screen.getByText('Show Raw JSON'));

        expect(await screen.findByText(/"id": "abc"/)).toBeInTheDocument();
      });

      it('says there is no data when the server returns no blob', async () => {
        mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ rawInfoJson: undefined }));
        renderDialog();
        await screen.findByText('Cached Title');

        fireEvent.click(screen.getByText('Show Raw JSON'));

        expect(await screen.findByText('No data')).toBeInTheDocument();
      });

      it('explains a duration-only row instead of fetching the blob', async () => {
        mockFetchMetadataDetail.mockResolvedValue(metadataDetail({ hasRawInfoJson: false }));
        renderDialog();
        await screen.findByText('Cached Title');
        mockFetchMetadataDetail.mockClear();

        fireEvent.click(screen.getByText('Show Raw JSON'));

        expect(await screen.findByText(/Duration only/)).toBeInTheDocument();
        expect(mockFetchMetadataDetail).not.toHaveBeenCalled();
      });
    });
  });

  describe('video kind, materialized download', () => {
    const renderVideo = (props: DialogOverrides = {}) =>
      renderDialog({ kind: 'video', video: { cachedVideoAt: '2026-01-05T00:00:00Z', ...props.video }, ...props, });

    it('is titled Cached Video', async () => {
      renderVideo();

      expect(await screen.findByText('Cached Video')).toBeInTheDocument();
    });

    it('shows the file from the library row without fetching anything', async () => {
      renderVideo();

      expect(await screen.findByText('/media/Channel/Video.mp4')).toBeInTheDocument();
      expect(mockFetchVideoCacheDetail).not.toHaveBeenCalled();
      expect(mockFetchMetadataDetail).not.toHaveBeenCalled();
    });

    it('shows the file size', async () => {
      renderVideo();

      expect(await screen.findByText('50MB')).toBeInTheDocument();
    });

    it('offers Delete rather than Clear or Refresh', async () => {
      renderVideo();
      await screen.findByText('Cached Video');

      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    });

    it('does not delete on the first click', async () => {
      const { onClear } = renderVideo();
      await screen.findByText('Cached Video');

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      expect(onClear).not.toHaveBeenCalled();
    });

    it('warns that the video reverts to STRM and asks for confirmation', async () => {
      renderVideo();
      await screen.findByText('Cached Video');

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText(/revert this video back to its STRM placeholder/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Confirm Delete' })).toBeInTheDocument();
    });

    it('deletes on the confirming click', async () => {
      const { onClear } = renderVideo();
      await screen.findByText('Cached Video');
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      fireEvent.click(await screen.findByRole('button', { name: 'Confirm Delete' }));

      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('labels and disables the confirm button while the delete is running', async () => {
      const { rerender, onClose, onClear } = renderVideo();
      await screen.findByText('Cached Video');
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      await screen.findByRole('button', { name: 'Confirm Delete' });

      rerender(
        <CacheDetailDialog
          open
          onClose={onClose}
          video={{ ...baseVideo, cachedVideoAt: '2026-01-05T00:00:00Z' }}
          kind="video"
          token="tok"
          onClear={onClear}
          clearing
        />
      );

      expect(await screen.findByRole('button', { name: 'Deleting…' })).toBeDisabled();
    });
  });

  describe('video kind, buffered copy', () => {
    it('loads the cached file details for an untracked video', async () => {
      renderDialog({ kind: 'video', video: { isTracked: false } });

      await waitFor(() => expect(mockFetchVideoCacheDetail).toHaveBeenCalledWith('abc123DEF45'));
    });

    it('loads the cached file details for a stealth-cached STRM video', async () => {
      renderDialog({ kind: 'video', video: { hasStealthCache: true } });

      await waitFor(() => expect(mockFetchVideoCacheDetail).toHaveBeenCalledWith('abc123DEF45'));
    });

    it('shows the buffered file size', async () => {
      renderDialog({ kind: 'video', video: { isTracked: false } });

      expect(await screen.findByText('100MB')).toBeInTheDocument();
    });

    it('does not show library file details for a buffered copy', async () => {
      renderDialog({ kind: 'video', video: { isTracked: false } });
      await screen.findByText('100MB');

      expect(screen.queryByText('File Path')).not.toBeInTheDocument();
    });

    it('warns that the buffered copy is deleted outright', async () => {
      renderDialog({ kind: 'video', video: { isTracked: false } });
      await screen.findByText('100MB');

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText(/delete this video's buffered copy outright/)).toBeInTheDocument();
    });

    it('falls back to the stealth cache time when the file has no mtime', async () => {
      mockFetchVideoCacheDetail.mockResolvedValue({ exists: true, size: 1048576, mtime: null });
      renderDialog({ kind: 'video', video: { hasStealthCache: true, stealthCacheAt: '2026-02-02T00:00:00Z' } });

      await screen.findByText('1MB');

      expect(screen.getByText('Cached')).toBeInTheDocument();
    });

    it('reloads when the dialog is reopened for another video', async () => {
      const { rerender, onClose, onClear } = renderDialog({ kind: 'video', video: { isTracked: false } });
      await waitFor(() => expect(mockFetchVideoCacheDetail).toHaveBeenCalledTimes(1));

      rerender(
        <CacheDetailDialog
          open
          onClose={onClose}
          video={{ ...baseVideo, isTracked: false, youtubeId: 'other123456' }}
          kind="video"
          token="tok"
          onClear={onClear}
          clearing={false}
        />
      );

      await waitFor(() => expect(mockFetchVideoCacheDetail).toHaveBeenCalledWith('other123456'));
    });
  });
});
