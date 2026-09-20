import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import VideosPage from '../VideosPage';
import { renderWithProviders } from '../../test-utils';
import { VideoData } from '../../types/VideoData';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn(() => false),
}));
jest.mock('react-swipeable', () => ({ useSwipeable: jest.fn(() => ({})) }));
jest.mock('../../hooks/useMediaQuery');
jest.mock('../../hooks/useConfig', () => ({ useConfig: jest.fn(() => ({ config: { channelVideosHotLoad: false, preferredResolution: '1080' } })) }));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({ ...jest.requireActual('react-router-dom'), useNavigate: () => mockNavigate }));

const mockTriggerDownloads = jest.fn();
jest.mock('../../hooks/useTriggerDownloads', () => ({ useTriggerDownloads: () => ({ triggerDownloads: mockTriggerDownloads, loading: false, error: null }) }));

const mockRefetch = jest.fn();
const mockSetVideos = jest.fn();
let mockVideos: VideoData[] = [];
jest.mock('../VideosPage/hooks/useVideosData', () => ({
  useVideosData: () => ({
    videos: mockVideos, setVideos: mockSetVideos, totalVideos: mockVideos.length, totalPages: 1,
    uniqueChannels: [], enabledChannels: [], loading: false, loadError: null, refetch: mockRefetch,
  }),
}));

const mockCache = {
  clearMetadataCache: jest.fn(),
  clearVideoCache: jest.fn(),
  bulkClearMetadataCache: jest.fn(),
  bulkClearVideoCache: jest.fn(),
};
jest.mock('../VideosPage/hooks/useCacheActions', () => ({ useCacheActions: () => mockCache }));

const mockDeleteVideos = jest.fn();
const mockPurgeVideos = jest.fn();
const mockForceDownload = jest.fn();
const mockRevertToStrm = jest.fn();
const mockToggleProtection = jest.fn();
jest.mock('../shared/useVideoDeletion', () => ({ useVideoDeletion: () => ({ deleteVideos: mockDeleteVideos, loading: false }) }));
jest.mock('../shared/useVideoPurge', () => ({ useVideoPurge: () => ({ purgeVideos: mockPurgeVideos, loading: false }) }));
jest.mock('../shared/useStrmSwitch', () => ({ useStrmSwitch: () => ({ forceDownload: mockForceDownload, revertToStrm: mockRevertToStrm, loading: false, error: null }) }));
jest.mock('../shared/useVideoProtection', () => ({
  useVideoProtection: () => ({ toggleProtection: mockToggleProtection, successMessage: null, error: null, clearMessages: jest.fn() }),
}));

// Row views are stubbed with buttons that call the handlers VideosPage gives
// them; dialogs are stubbed with confirm buttons that call its confirm handlers.
jest.mock('../VideosPage/components/VideoCard', () => ({
  __esModule: true,
  default: function MockVideoCard(props: any) {
    const React = require('react');
    const id = props.video.youtubeId;
    return React.createElement(
      'div',
      null,
      React.createElement('button', { onClick: () => props.onToggleSelect(id) }, `select ${id}`),
      React.createElement('button', { onClick: () => props.onDeleteSingle(props.video.id) }, `delete single ${id}`),
      React.createElement('button', { onClick: () => props.onToggleProtection(props.video.id) }, `protect ${id}`),
      React.createElement('button', { onClick: () => props.onOpenCacheDetail(id, 'metadata') }, `metadata detail ${id}`),
      React.createElement('button', { onClick: () => props.onOpenCacheDetail(id, 'video') }, `video detail ${id}`),
      React.createElement('button', { onClick: () => props.onClearCachedRow(props.video) }, `clear row ${id}`)
    );
  },
}));
jest.mock('../VideosPage/components/VideosTable', () => ({
  __esModule: true,
  default: function MockTable(props: any) {
    const React = require('react');
    return React.createElement(
      'div',
      null,
      React.createElement('button', { onClick: () => props.onSelectAll(true) }, 'select all'),
      React.createElement('button', { onClick: () => props.onSelectAll(false) }, 'deselect all'),
      ...props.videos.map((v: any) => React.createElement('button', { key: v.youtubeId, onClick: () => props.onStrmChipClick(v) }, `strm chip ${v.youtubeId}`))
    );
  },
}));
jest.mock('../VideosPage/components/VideosListMobile', () => ({ __esModule: true, default: () => null }));
jest.mock('../VideosPage/components/CacheDetailDialog', () => ({
  __esModule: true,
  default: function MockCacheDetail(props: any) {
    const React = require('react');
    return React.createElement('div', null, `cache detail ${props.kind} ${props.video.youtubeId}`, React.createElement('button', { onClick: props.onClear }, 'clear cache detail'), React.createElement('button', { onClick: props.onClose }, 'close cache detail'));
  },
}));

function mockDialogStub(label: string, confirmProp: string, extra?: (props: any) => any) {
  return {
  __esModule: true,
  default: function MockDialog(props: any) {
    const React = require('react');
    if (!props.open) return null;
    return React.createElement(
      'div',
      null,
      `${label}: ${props.videoCount ?? ''}/${props.skippedCount ?? ''}`,
      React.createElement('button', { onClick: () => props[confirmProp](...(extra ? extra(props) : [])) }, `confirm ${label}`),
      React.createElement('button', { onClick: props.onClose }, `close ${label}`)
    );
  },
  };
}
jest.mock('../shared/DeleteVideosDialog', () => mockDialogStub('delete', 'onConfirm'));
jest.mock('../shared/PurgeVideosDialog', () => mockDialogStub('purge', 'onConfirm'));
jest.mock('../shared/ObliterateVideosDialog', () => mockDialogStub('obliterate', 'onConfirm'));
jest.mock('../shared/StrmDownloadDialog', () => mockDialogStub('strm download', 'onConfirm'));
jest.mock('../shared/StrmRevertDialog', () => mockDialogStub('strm revert', 'onConfirm'));
jest.mock('../shared/ClearCachedMetadataDialog', () => mockDialogStub('clear metadata', 'onConfirm'));
jest.mock('../shared/ClearCachedVideoDialog', () => mockDialogStub('clear video', 'onConfirm'));
jest.mock('../shared/ChangeRatingDialog', () => ({
  __esModule: true,
  default: function MockRating(props: any) {
    const React = require('react');
    if (!props.open) return null;
    return React.createElement('div', null, `rating for ${props.selectedCount}`, React.createElement('button', { onClick: () => props.onApply('PG-13') }, 'apply PG-13'), React.createElement('button', { onClick: () => props.onApply(null) }, 'clear rating'));
  },
}));
jest.mock('../shared/ClearCachedRowDialog', () => ({
  __esModule: true,
  default: function MockClearRow(props: any) {
    const React = require('react');
    return React.createElement('div', null, `clear row dialog: ${props.title} metadata=${props.hasCachedMetadata} video=${props.hasCachedVideo}`, React.createElement('button', { onClick: props.onConfirm }, 'confirm clear row'), React.createElement('button', { onClick: props.onClose }, 'close clear row'));
  },
}));
jest.mock('../DownloadManager/ManualDownload/DownloadSettingsDialog', () => ({
  __esModule: true,
  default: function MockDownloadSettings(props: any) {
    const React = require('react');
    if (!props.open) return null;
    return React.createElement(
      'div',
      null,
      `download: ${props.videoCount} eligible, ${props.missingVideoCount} missing, ${props.replaceVideoCount} replace, ${props.unavailableVideoCount} unavailable`,
      React.createElement('button', { onClick: () => props.onConfirm(null) }, 'confirm download default'),
      React.createElement('button', { onClick: () => props.onConfirm({ resolution: '720', allowRedownload: true, subfolder: '__kids', audioFormat: 'mp3_only', rating: 'PG', skipVideoFolder: false }) }, 'confirm download custom')
    );
  },
}));
jest.mock('../shared/VideoModal', () => ({ __esModule: true, default: () => null }));
jest.mock('../shared/AddChannelDialog', () => ({ __esModule: true, default: () => null }));

jest.mock('../shared/VideoList', () => {
  const React = require('react');
  const actual = jest.requireActual('../shared/VideoList');
  return {
    ...actual,
    VideoListContainer: function MockContainer(props: any) {
      const selection = props.selection;
      return React.createElement(
        'div',
        null,
        props.headerSlot,
        props.renderContent(props.state?.viewMode ?? 'grid'),
        React.createElement('span', { 'data-testid': 'selected-count' }, String(selection?.count ?? 0)),
        selection?.hasSelection
          ? React.createElement(
              'ul',
              { role: 'menu' },
              ...selection.actions.map((action: any) =>
                React.createElement(
                  'li',
                  { key: action.id, role: 'menuitem', 'aria-disabled': action.disabled?.(selection.selectedIds) ? 'true' : 'false', onClick: () => action.onClick?.(selection.selectedIds) },
                  action.label
                )
              )
            )
          : null
      );
    },
  };
});

const axios = require('axios');

const video = (overrides: Partial<VideoData>): VideoData => ({
  id: 1,
  youtubeId: 'v1',
  youTubeChannelName: 'Chan',
  youTubeVideoName: 'Video 1',
  timeCreated: '2024-01-01',
  originalDate: '20240101',
  duration: 100,
  description: '',
  removed: false,
  isTracked: true,
  ...overrides,
} as VideoData);

const menuItem = (name: string) => screen.getByRole('menuitem', { name });
const status = () => screen.findByRole('alert');

describe('VideosPage bulk and single-row actions', () => {
  const user = userEvent.setup({ delay: null });

  const renderPage = () => renderWithProviders(<VideosPage token="tok" />);
  const select = async (...ids: string[]) => {
    for (const id of ids) {
      await user.click(screen.getByRole('button', { name: `select ${id}` }));
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('youtarr:videosPageViewMode', 'grid');
    localStorage.setItem('youtarr:viewMode', 'grid');
    mockVideos = [
      video({ id: 1, youtubeId: 'v1', youTubeVideoName: 'Downloaded' }),
      video({ id: 2, youtubeId: 'v2', youTubeVideoName: 'Missing', removed: true }),
      video({ id: 3, youtubeId: 'v3', youTubeVideoName: 'Strm', is_strm: true } as Partial<VideoData>),
      video({ id: null as unknown as number, youtubeId: 'u1', youTubeVideoName: 'Untracked', isTracked: false, hasCachedMetadata: true, hasCachedVideo: true }),
      video({ id: 5, youtubeId: 'r1', youTubeVideoName: 'Removed on YouTube', youtube_removed: true } as Partial<VideoData>),
    ];
    mockRefetch.mockReset();
    mockDeleteVideos.mockResolvedValue({ success: true, deleted: [1], failed: [] });
    mockPurgeVideos.mockResolvedValue({ success: true, purged: [2], failed: [] });
    mockForceDownload.mockResolvedValue({ success: true, processed: [3], failed: [] });
    mockRevertToStrm.mockResolvedValue({ success: true, processed: [1], failed: [] });
    mockCache.clearMetadataCache.mockResolvedValue(undefined);
    mockCache.clearVideoCache.mockResolvedValue(undefined);
    mockCache.bulkClearMetadataCache.mockResolvedValue({ success: true, failed: [] });
    mockCache.bulkClearVideoCache.mockResolvedValue({ success: true, failed: [] });
    axios.post.mockResolvedValue({ data: {} });
    mockTriggerDownloads.mockResolvedValue(true);
  });

  describe('which actions are offered', () => {
    it('only enables Purge for a video that is missing from disk', async () => {
      renderPage();
      await select('v1');

      expect(menuItem('Purge')).toHaveAttribute('aria-disabled', 'true');
    });

    it('enables Purge once a missing video is selected', async () => {
      renderPage();
      await select('v2');

      expect(menuItem('Purge')).toHaveAttribute('aria-disabled', 'false');
    });

    it('only enables Download when a video is still available on YouTube', async () => {
      renderPage();
      await select('r1');

      expect(menuItem('Download')).toHaveAttribute('aria-disabled', 'true');
    });

    it('only enables Rating for tracked videos', async () => {
      renderPage();
      await select('u1');

      expect(menuItem('Rating')).toHaveAttribute('aria-disabled', 'true');
    });

    it('enables Clear Cached Metadata for a row with cached metadata', async () => {
      renderPage();
      await select('u1');

      expect(menuItem('Clear Cached Metadata')).toHaveAttribute('aria-disabled', 'false');
    });
  });

  describe('delete', () => {
    it('counts the videos it can delete and those it will skip', async () => {
      renderPage();
      await select('v1', 'v2');

      await user.click(menuItem('Delete'));

      expect(screen.getByText('delete: 1/1')).toBeInTheDocument();
    });

    it('deletes by database id and reports success', async () => {
      renderPage();
      await select('v1');
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(mockDeleteVideos).toHaveBeenCalledWith([1], 'tok');
      expect(await screen.findByText('Successfully removed 1 video')).toBeInTheDocument();
      expect(mockRefetch).toHaveBeenCalled();
      expect(screen.getByTestId('selected-count')).toHaveTextContent('0');
    });

    it('also clears the cache of cache-only rows selected with real videos', async () => {
      renderPage();
      await select('v1', 'u1');
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(mockCache.clearMetadataCache).toHaveBeenCalledWith('u1');
      expect(mockCache.clearVideoCache).toHaveBeenCalledWith('u1');
      expect(await screen.findByText('Successfully removed 1 video and 1 cached-only row')).toBeInTheDocument();
    });

    it('works for a cache-only row on its own without calling delete', async () => {
      renderPage();
      await select('u1');
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(mockDeleteVideos).not.toHaveBeenCalled();
      expect(await screen.findByText('Successfully removed 1 cached-only row')).toBeInTheDocument();
    });

    it('reports a partial failure', async () => {
      mockDeleteVideos.mockResolvedValue({ success: false, deleted: [1], failed: [{ videoId: 3, error: 'locked' }] });
      renderPage();
      await select('v1', 'v3');
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(await screen.findByText('Removed 1 video, but 1 video failed')).toBeInTheDocument();
    });

    it('reports the first error when nothing could be deleted', async () => {
      mockDeleteVideos.mockResolvedValue({ success: false, deleted: [], failed: [{ videoId: 1, error: 'permission denied' }] });
      renderPage();
      await select('v1');
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(await status()).toHaveTextContent('Failed to delete videos: permission denied');
    });

    it('a single-row delete selects just that video and opens the dialog', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'delete single v3' }));

      expect(screen.getByText('delete: 1/0')).toBeInTheDocument();
      expect(screen.getByTestId('selected-count')).toHaveTextContent('1');
    });

    it('closing the dialog does not delete', async () => {
      renderPage();
      await select('v1');
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'close delete' }));

      expect(mockDeleteVideos).not.toHaveBeenCalled();
    });
  });

  describe('purge', () => {
    it('purges only videos that are missing from disk', async () => {
      renderPage();
      await select('v1', 'v2');
      await user.click(menuItem('Purge'));

      await user.click(screen.getByRole('button', { name: 'confirm purge' }));

      expect(mockPurgeVideos).toHaveBeenCalledWith([2], 'tok');
      expect(await screen.findByText('Successfully purged 1 video')).toBeInTheDocument();
    });

    it('reports a partial failure', async () => {
      mockPurgeVideos.mockResolvedValue({ success: false, purged: [2], failed: [{ videoId: 9, error: 'x' }] });
      renderPage();
      await select('v2');
      await user.click(menuItem('Purge'));

      await user.click(screen.getByRole('button', { name: 'confirm purge' }));

      expect(await screen.findByText('Purged 1 video, but 1 failed')).toBeInTheDocument();
    });

    it('reports the first error when nothing could be purged', async () => {
      mockPurgeVideos.mockResolvedValue({ success: false, purged: [], failed: [{ videoId: 2, error: 'fk violation' }] });
      renderPage();
      await select('v2');
      await user.click(menuItem('Purge'));

      await user.click(screen.getByRole('button', { name: 'confirm purge' }));

      expect(await status()).toHaveTextContent('Failed to purge videos: fk violation');
    });
  });

  describe('obliterate', () => {
    it('deletes then purges a tracked video', async () => {
      renderPage();
      await select('v1');
      await user.click(menuItem('Obliterate'));

      await user.click(screen.getByRole('button', { name: 'confirm obliterate' }));

      await waitFor(() => expect(mockPurgeVideos).toHaveBeenCalled());
      expect(mockDeleteVideos).toHaveBeenCalledWith([1], 'tok');
      expect(mockPurgeVideos).toHaveBeenCalledWith([1], 'tok');
      expect(await screen.findByText('Obliterated 1 video')).toBeInTheDocument();
    });

    it('purges an already-missing video without deleting it first', async () => {
      renderPage();
      await select('v2');
      await user.click(menuItem('Obliterate'));

      await user.click(screen.getByRole('button', { name: 'confirm obliterate' }));

      await waitFor(() => expect(mockPurgeVideos).toHaveBeenCalledWith([2], 'tok'));
      expect(mockDeleteVideos).not.toHaveBeenCalled();
    });

    it('clears the caches of an untracked row', async () => {
      renderPage();
      await select('u1');
      await user.click(menuItem('Obliterate'));

      await user.click(screen.getByRole('button', { name: 'confirm obliterate' }));

      await waitFor(() => expect(mockCache.bulkClearVideoCache).toHaveBeenCalledWith(['u1']));
      expect(mockCache.bulkClearMetadataCache).toHaveBeenCalledWith(['u1']);
      expect(mockDeleteVideos).not.toHaveBeenCalled();
      expect(mockPurgeVideos).not.toHaveBeenCalled();
    });

    it('counts failed steps in the message', async () => {
      mockDeleteVideos.mockResolvedValue({ success: false, deleted: [], failed: [{ videoId: 1, error: 'x' }] });
      renderPage();
      await select('v1');
      await user.click(menuItem('Obliterate'));

      await user.click(screen.getByRole('button', { name: 'confirm obliterate' }));

      expect(await screen.findByText('Obliterated 1 video, but 1 step failed')).toBeInTheDocument();
    });

    it('uses the plural for several videos', async () => {
      mockDeleteVideos.mockResolvedValue({ success: true, deleted: [1, 3], failed: [] });
      renderPage();
      await select('v1', 'v3');
      await user.click(menuItem('Obliterate'));

      await user.click(screen.getByRole('button', { name: 'confirm obliterate' }));

      expect(await screen.findByText('Obliterated 2 videos')).toBeInTheDocument();
    });
  });

  describe('rating', () => {
    it('shows how many videos are selected', async () => {
      renderPage();
      await select('v1', 'v3');

      await user.click(menuItem('Rating'));

      expect(screen.getByText('rating for 2')).toBeInTheDocument();
    });

    it('applies the rating to the tracked videos by id', async () => {
      renderPage();
      await select('v1', 'v3');
      await user.click(menuItem('Rating'));

      await user.click(screen.getByRole('button', { name: 'apply PG-13' }));

      expect(axios.post).toHaveBeenCalledWith('/api/videos/rating', { videoIds: [1, 3], rating: 'PG-13' }, { headers: { 'x-access-token': 'tok' } });
      expect(await screen.findByText('Successfully updated content rating for 2 video(s)')).toBeInTheDocument();
    });

    it('can clear the rating', async () => {
      renderPage();
      await select('v1');
      await user.click(menuItem('Rating'));

      await user.click(screen.getByRole('button', { name: 'clear rating' }));

      expect(axios.post.mock.calls[0][1]).toEqual({ videoIds: [1], rating: null });
    });

    it('shows the server\'s error message when it fails', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      axios.isAxiosError.mockReturnValue(true);
      axios.post.mockRejectedValue({ response: { data: { error: 'Invalid rating' } } });
      renderPage();
      await select('v1');
      await user.click(menuItem('Rating'));

      await user.click(screen.getByRole('button', { name: 'apply PG-13' }));

      expect(await status()).toHaveTextContent('Invalid rating');
      consoleError.mockRestore();
    });

    it('shows a generic message when the failure is not an HTTP error', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      axios.isAxiosError.mockReturnValue(false);
      axios.post.mockRejectedValue(new Error('offline'));
      renderPage();
      await select('v1');
      await user.click(menuItem('Rating'));

      await user.click(screen.getByRole('button', { name: 'apply PG-13' }));

      expect(await status()).toHaveTextContent('Failed to update content ratings');
      consoleError.mockRestore();
    });
  });

  describe('downloading', () => {
    it('counts eligible, missing, replace and unavailable videos', async () => {
      renderPage();
      await select('v1', 'v2', 'r1');

      await user.click(menuItem('Download'));

      expect(screen.getByText(/download: 2 eligible, 1 missing, 1 replace, 1 unavailable/)).toBeInTheDocument();
    });

    it('queues the available videos and opens the activity page', async () => {
      renderPage();
      await select('v1', 'r1');
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download default' }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/downloads/activity'));
      expect(mockTriggerDownloads.mock.calls[0][0].urls).toEqual(['https://www.youtube.com/watch?v=v1']);
    });

    it('passes the chosen settings as overrides', async () => {
      renderPage();
      await select('v1');
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download custom' }));

      await waitFor(() => expect(mockTriggerDownloads).toHaveBeenCalled());
      expect(mockTriggerDownloads.mock.calls[0][0].overrideSettings).toMatchObject({ resolution: '720', allowRedownload: true, subfolder: '__kids', audioFormat: 'mp3_only' });
    });

    it('maps videos to their channel only when the channel id is valid', async () => {
      const goodChannel = `UC${'a'.repeat(22)}`;
      mockVideos = [
        video({ id: 1, youtubeId: 'v1', channel_id: goodChannel }),
        video({ id: 2, youtubeId: 'v2', channel_id: 'not-a-channel-id' }),
      ];
      renderPage();
      await select('v1', 'v2');
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download default' }));

      await waitFor(() => expect(mockTriggerDownloads).toHaveBeenCalled());
      expect(mockTriggerDownloads.mock.calls[0][0].videoChannelMap).toEqual({ v1: goodChannel });
    });

    it('reports a failed download request and keeps the selection', async () => {
      mockTriggerDownloads.mockResolvedValue(false);
      renderPage();
      await select('v1');
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download default' }));

      expect(await status()).toHaveTextContent('Failed to queue selected videos for download. Please try again.');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(screen.getByTestId('selected-count')).toHaveTextContent('1');
    });

    it('does nothing when every selected video is gone from YouTube', async () => {
      renderPage();
      await select('r1');
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download default' }));

      expect(mockTriggerDownloads).not.toHaveBeenCalled();
    });
  });

  describe('STRM switching', () => {
    it('forces a download of a STRM video', async () => {
      renderPage();
      await select('v3');
      await user.click(menuItem('Force Download'));

      await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

      expect(mockForceDownload).toHaveBeenCalledWith([3], 'tok');
      expect(await screen.findByText('Queued 1 video for download')).toBeInTheDocument();
    });

    it('reports a partial failure of a forced download', async () => {
      mockForceDownload.mockResolvedValue({ success: false, processed: [3], failed: [{ videoId: 9, error: 'x' }] });
      renderPage();
      await select('v3');
      await user.click(menuItem('Force Download'));

      await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

      expect(await screen.findByText('Queued 1 video, but 1 failed')).toBeInTheDocument();
    });

    it('reports when nothing could be queued', async () => {
      mockForceDownload.mockResolvedValue({ success: false, processed: [], failed: [{ videoId: 3, error: 'no room' }] });
      renderPage();
      await select('v3');
      await user.click(menuItem('Force Download'));

      await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

      expect(await status()).toHaveTextContent('Failed to queue download: no room');
    });

    it('switches a real download back to STRM', async () => {
      renderPage();
      await select('v1');
      await user.click(menuItem('Switch to STRM'));

      await user.click(screen.getByRole('button', { name: 'confirm strm revert' }));

      expect(mockRevertToStrm).toHaveBeenCalledWith([1], 'tok');
      expect(await screen.findByText('Switched 1 video back to STRM')).toBeInTheDocument();
    });

    it('reports a partial failure and a total failure of a switch', async () => {
      mockRevertToStrm.mockResolvedValueOnce({ success: false, processed: [1], failed: [{ videoId: 9, error: 'x' }] });
      renderPage();
      await select('v1');
      await user.click(menuItem('Switch to STRM'));
      await user.click(screen.getByRole('button', { name: 'confirm strm revert' }));

      expect(await screen.findByText('Switched 1 video back to STRM, but 1 failed')).toBeInTheDocument();
    });

    it('reports when nothing could be switched', async () => {
      mockRevertToStrm.mockResolvedValue({ success: false, processed: [], failed: [{ videoId: 1, error: 'no backup' }] });
      renderPage();
      await select('v1');
      await user.click(menuItem('Switch to STRM'));

      await user.click(screen.getByRole('button', { name: 'confirm strm revert' }));

      expect(await status()).toHaveTextContent('Failed to switch to STRM: no backup');
    });

    it('a single-row chip acts on just that video and leaves the selection alone', async () => {
      localStorage.setItem('youtarr:videosPageViewMode', 'table');
      localStorage.setItem('youtarr:viewMode', 'table');
      renderPage();

      await user.click(screen.getByRole('button', { name: 'strm chip v3' }));
      await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

      expect(mockForceDownload).toHaveBeenCalledWith([3], 'tok');
      expect(screen.getByTestId('selected-count')).toHaveTextContent('0');
    });
  });

  describe('clearing caches', () => {
    it('clears cached metadata for the selected rows', async () => {
      renderPage();
      await select('u1');
      await user.click(menuItem('Clear Cached Metadata'));

      await user.click(screen.getByRole('button', { name: 'confirm clear metadata' }));

      expect(mockCache.bulkClearMetadataCache).toHaveBeenCalledWith(['u1']);
      expect(await screen.findByText('Cleared cached metadata for 1 video')).toBeInTheDocument();
    });

    it('reports a failed metadata clear', async () => {
      mockCache.bulkClearMetadataCache.mockResolvedValue({ success: false, failed: ['u1'] });
      renderPage();
      await select('u1');
      await user.click(menuItem('Clear Cached Metadata'));

      await user.click(screen.getByRole('button', { name: 'confirm clear metadata' }));

      expect(await status()).toHaveTextContent('Failed to clear cached metadata');
    });

    it('clears the cached video of an untracked row through the buffer cache', async () => {
      renderPage();
      await select('u1');
      await user.click(menuItem('Clear Cached Video'));

      await user.click(screen.getByRole('button', { name: 'confirm clear video' }));

      expect(mockCache.bulkClearVideoCache).toHaveBeenCalledWith(['u1']);
      expect(await screen.findByText('Cleared cached video for 1 video')).toBeInTheDocument();
    });

    it('reports a partial failure of a cached video clear', async () => {
      mockVideos = [video({ id: 1, youtubeId: 'v1', hasCachedVideo: true }), video({ id: null as unknown as number, youtubeId: 'u1', isTracked: false, hasCachedVideo: true })];
      mockCache.bulkClearVideoCache.mockResolvedValue({ success: false, failed: ['u1'] });
      renderPage();
      await select('v1', 'u1');
      await user.click(menuItem('Clear Cached Video'));

      await user.click(screen.getByRole('button', { name: 'confirm clear video' }));

      expect(mockRevertToStrm).toHaveBeenCalledWith([1], 'tok');
      expect(await screen.findByText('Cleared cached video for 1 video, but 1 failed')).toBeInTheDocument();
    });

    it('reports a total failure of a cached video clear', async () => {
      mockCache.bulkClearVideoCache.mockResolvedValue({ success: false, failed: ['u1'] });
      renderPage();
      await select('u1');
      await user.click(menuItem('Clear Cached Video'));

      await user.click(screen.getByRole('button', { name: 'confirm clear video' }));

      expect(await status()).toHaveTextContent('Failed to clear cached video');
    });
  });

  describe('single-row cache details', () => {
    it('clears cached metadata from the detail dialog', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'metadata detail u1' }));

      await user.click(screen.getByRole('button', { name: 'clear cache detail' }));

      await waitFor(() => expect(mockCache.clearMetadataCache).toHaveBeenCalledWith('u1'));
      expect(mockRefetch).toHaveBeenCalled();
      expect(screen.queryByText(/cache detail metadata/)).not.toBeInTheDocument();
    });

    it('clears an untracked row\'s cached video directly', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'video detail u1' }));

      await user.click(screen.getByRole('button', { name: 'clear cache detail' }));

      await waitFor(() => expect(mockCache.clearVideoCache).toHaveBeenCalledWith('u1'));
      expect(mockRevertToStrm).not.toHaveBeenCalled();
    });

    it('reverts a tracked row\'s cached video to STRM', async () => {
      mockVideos = [video({ id: 7, youtubeId: 'v7', hasCachedVideo: true })];
      renderPage();
      await user.click(screen.getByRole('button', { name: 'video detail v7' }));

      await user.click(screen.getByRole('button', { name: 'clear cache detail' }));

      await waitFor(() => expect(mockRevertToStrm).toHaveBeenCalledWith([7], 'tok'));
      expect(mockCache.clearVideoCache).not.toHaveBeenCalled();
    });

    it('closes the detail dialog', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'metadata detail u1' }));

      await user.click(screen.getByRole('button', { name: 'close cache detail' }));

      expect(screen.queryByText(/cache detail metadata/)).not.toBeInTheDocument();
    });

    it('clears every cache an untracked row has from the row action', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'clear row u1' }));
      expect(screen.getByText('clear row dialog: Untracked metadata=true video=true')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'confirm clear row' }));

      await waitFor(() => expect(mockCache.clearVideoCache).toHaveBeenCalledWith('u1'));
      expect(mockCache.clearMetadataCache).toHaveBeenCalledWith('u1');
      expect(mockRefetch).toHaveBeenCalled();
    });

    it('closes the row dialog without clearing', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'clear row u1' }));

      await user.click(screen.getByRole('button', { name: 'close clear row' }));

      expect(mockCache.clearMetadataCache).not.toHaveBeenCalled();
    });
  });

  describe('protection', () => {
    it('toggles protection and updates the row', async () => {
      mockToggleProtection.mockResolvedValue(true);
      renderPage();

      await user.click(screen.getByRole('button', { name: 'protect v1' }));

      expect(mockToggleProtection).toHaveBeenCalledWith(1, false);
      await waitFor(() => expect(mockSetVideos).toHaveBeenCalled());
    });

    it('leaves the row alone when toggling failed', async () => {
      mockToggleProtection.mockResolvedValue(undefined);
      renderPage();

      await user.click(screen.getByRole('button', { name: 'protect v1' }));

      await waitFor(() => expect(mockToggleProtection).toHaveBeenCalled());
      expect(mockSetVideos).not.toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('selecting all', () => {
    beforeEach(() => {
      localStorage.setItem('youtarr:videosPageViewMode', 'table');
      localStorage.setItem('youtarr:viewMode', 'table');
    });

    it('selects every video on the page', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'select all' }));

      expect(screen.getByTestId('selected-count')).toHaveTextContent('5');
    });

    it('deselects everything', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select all' }));

      await user.click(screen.getByRole('button', { name: 'deselect all' }));

      expect(screen.getByTestId('selected-count')).toHaveTextContent('0');
    });
  });
});
