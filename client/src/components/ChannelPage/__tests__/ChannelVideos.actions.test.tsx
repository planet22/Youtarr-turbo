import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import useMediaQuery from '../../../hooks/useMediaQuery';
import ChannelVideos from '../ChannelVideos';
import { ChannelVideo } from '../../../types/ChannelVideo';
import { renderWithProviders, createMockWebSocketContext } from '../../../test-utils';

jest.mock('../../../hooks/useMediaQuery');

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ channel_id: 'UC123456' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-swipeable', () => ({ useSwipeable: () => ({}) }));

// Row views and dialogs are stubbed with buttons that call the handlers
// ChannelVideos hands them, so the page's own action logic is what is tested.
jest.mock('../VideoCard', () => ({
  __esModule: true,
  default: function MockVideoCard(props: any) {
    const React = require('react');
    const { video } = props;
    const id = video.youtube_id;
    return React.createElement(
      'div',
      { 'data-testid': `card-${id}` },
      React.createElement('button', { onClick: () => props.onCheckChange(id, true) }, `select ${id}`),
      React.createElement('button', { onClick: () => props.onDeletionChange(id, true) }, `mark delete ${id}`),
      React.createElement('button', { onClick: () => props.onToggleIgnore(id) }, `toggle ignore ${id}`),
      React.createElement('button', { onClick: () => props.onToggleProtection(id) }, `toggle protection ${id}`)
    );
  },
}));
jest.mock('../VideoListItem', () => ({ __esModule: true, default: () => null }));
jest.mock('../VideoTableView', () => ({
  __esModule: true,
  default: function MockTable(props: any) {
    const React = require('react');
    return React.createElement(
      'div',
      { 'data-testid': 'table' },
      React.createElement('button', { onClick: props.onSelectAll }, 'table select all'),
      ...props.videos.map((v: any) => React.createElement('button', { key: v.youtube_id, onClick: () => props.onStrmChipClick(v) }, `strm chip ${v.youtube_id}`))
    );
  },
}));

jest.mock('../../shared/VideoList', () => {
  const React = require('react');
  const actual = jest.requireActual('../../shared/VideoList');
  return {
    ...actual,
    VideoListContainer: function MockContainer(props: any) {
      const selection = props.selection;
      return React.createElement(
        'div',
        null,
        props.headerSlot,
        props.tabsSlot,
        props.toolbarRightActions,
        (props.itemCount ?? 0) > 0 ? props.renderContent(props.state?.viewMode ?? 'grid') : null,
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
              ),
              React.createElement('li', { role: 'menuitem', onClick: () => selection.clear?.() }, 'Clear Selection')
            )
          : null
      );
    },
  };
});

jest.mock('../ChannelVideosDialogs', () => ({
  __esModule: true,
  default: function MockDialogs(props: any) {
    const React = require('react');
    return React.createElement(
      'div',
      null,
      React.createElement('span', { 'data-testid': 'dialog-state' }, JSON.stringify({
        download: props.downloadDialogOpen, refresh: props.refreshConfirmOpen, del: props.deleteDialogOpen,
        videoCount: props.videoCount, missing: props.missingVideoCount, selectedForDeletion: props.selectedForDeletion,
      })),
      props.successMessage ? React.createElement('div', { role: 'status' }, props.successMessage) : null,
      props.errorMessage ? React.createElement('div', { role: 'alert' }, props.errorMessage) : null,
      React.createElement('button', { onClick: () => props.onDownloadConfirm(null) }, 'confirm download default'),
      React.createElement('button', { onClick: () => props.onDownloadConfirm({ resolution: '720', allowRedownload: true, subfolder: '__kids', audioFormat: 'mp3_only', rating: 'PG', skipVideoFolder: true }) }, 'confirm download custom'),
      React.createElement('button', { onClick: props.onDownloadDialogClose }, 'close download dialog'),
      React.createElement('button', { onClick: props.onRefreshConfirm }, 'confirm refresh'),
      React.createElement('button', { onClick: props.onRefreshCancel }, 'cancel refresh'),
      React.createElement('button', { onClick: props.onDeleteConfirm }, 'confirm delete'),
      React.createElement('button', { onClick: props.onDeleteCancel }, 'cancel delete'),
      React.createElement('button', { onClick: props.onSuccessMessageClose }, 'close success'),
      React.createElement('button', { onClick: props.onErrorMessageClose }, 'close error')
    );
  },
}));
jest.mock('../DownloadAllVideosDialog', () => ({
  __esModule: true,
  default: function MockDownloadAll(props: any) {
    const React = require('react');
    return props.open ? React.createElement('button', { onClick: props.onStarted }, 'download-all started') : null;
  },
}));
jest.mock('../../shared/StrmDownloadDialog', () => ({
  __esModule: true,
  default: function MockStrmDownload(props: any) {
    const React = require('react');
    return props.open
      ? React.createElement('div', null, `strm download: ${props.videoCount} eligible, ${props.skippedCount} skipped`, React.createElement('button', { onClick: props.onConfirm }, 'confirm strm download'), React.createElement('button', { onClick: props.onClose }, 'close strm download'))
      : null;
  },
}));
jest.mock('../../shared/StrmRevertDialog', () => ({
  __esModule: true,
  default: function MockStrmRevert(props: any) {
    const React = require('react');
    return props.open
      ? React.createElement('div', null, `strm revert: ${props.videoCount} eligible, ${props.skippedCount} skipped`, React.createElement('button', { onClick: props.onConfirm }, 'confirm strm revert'), React.createElement('button', { onClick: props.onClose }, 'close strm revert'))
      : null;
  },
}));

const mockRefetch = jest.fn();
const mockRefresh = jest.fn();
const mockTriggerDownloads = jest.fn();
const mockDeleteByYoutubeIds = jest.fn();
const mockForceDownload = jest.fn();
const mockRevertToStrm = jest.fn();
const mockToggleProtection = jest.fn();
const mockClearProtection = jest.fn();
let mockProtection: { error: string | null; successMessage: string | null } = { error: null, successMessage: null };

jest.mock('../hooks/useChannelVideos', () => ({ useChannelVideos: jest.fn() }));
jest.mock('../hooks/useRefreshChannelVideos', () => ({ useRefreshChannelVideos: jest.fn() }));
jest.mock('../../../hooks/useConfig', () => ({ useConfig: jest.fn() }));
jest.mock('../../../hooks/useTriggerDownloads', () => ({ useTriggerDownloads: jest.fn() }));
jest.mock('../../shared/useVideoDeletion', () => ({ useVideoDeletion: jest.fn() }));
jest.mock('../../shared/useStrmSwitch', () => ({ useStrmSwitch: jest.fn() }));
jest.mock('../../shared/useVideoProtection', () => ({ useVideoProtection: jest.fn() }));

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

const { useChannelVideos } = require('../hooks/useChannelVideos');
const { useRefreshChannelVideos } = require('../hooks/useRefreshChannelVideos');
const { useVideoDeletion } = require('../../shared/useVideoDeletion');
const { useStrmSwitch } = require('../../shared/useStrmSwitch');
const { useVideoProtection } = require('../../shared/useVideoProtection');
const { useConfig } = require('../../../hooks/useConfig');
const { useTriggerDownloads } = require('../../../hooks/useTriggerDownloads');

const videos: ChannelVideo[] = [
  { title: 'Never', youtube_id: 'never1', publishedAt: '2023-01-01T00:00:00Z', thumbnail: '', added: false, duration: 300, media_type: 'video', live_status: null },
  { title: 'Downloaded', youtube_id: 'down1', id: 2, publishedAt: '2023-01-02T00:00:00Z', thumbnail: '', added: true, removed: false, duration: 300, media_type: 'video', live_status: null },
  { title: 'Strm', youtube_id: 'strm1', id: 3, publishedAt: '2023-01-03T00:00:00Z', thumbnail: '', added: true, removed: false, duration: 300, media_type: 'video', live_status: null, is_strm: true } as ChannelVideo,
  { title: 'Ignored', youtube_id: 'ign1', publishedAt: '2023-01-04T00:00:00Z', thumbnail: '', added: false, ignored: true, duration: 300, media_type: 'video', live_status: null } as ChannelVideo,
];

const dialogState = () => JSON.parse(screen.getByTestId('dialog-state').textContent || '{}');
const menuItem = (name: string) => screen.getByRole('menuitem', { name });

describe('ChannelVideos selection actions', () => {
  const user = userEvent.setup({ delay: null });

  const renderPage = () => renderWithProviders(<ChannelVideos token="tok" />, { websocketValue: createMockWebSocketContext() });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    mockProtection = { error: null, successMessage: null };
    (useMediaQuery as jest.Mock).mockReturnValue(false);
    localStorage.setItem('youtarr:channelVideosViewMode', 'grid');

    useChannelVideos.mockReturnValue({ videos, totalCount: videos.length, oldestVideoDate: null, error: null, autoDownloadsEnabled: false, loading: false, refetch: mockRefetch });
    useRefreshChannelVideos.mockReturnValue({ refreshVideos: mockRefresh, loading: false, error: null, clearError: jest.fn() });
    useVideoDeletion.mockReturnValue({ deleteVideosByYoutubeIds: mockDeleteByYoutubeIds, loading: false });
    useStrmSwitch.mockReturnValue({ forceDownload: mockForceDownload, revertToStrm: mockRevertToStrm, loading: false, error: null });
    useVideoProtection.mockImplementation(() => ({ toggleProtection: mockToggleProtection, loading: false, clearMessages: mockClearProtection, ...mockProtection }));
    useConfig.mockReturnValue({ config: { preferredResolution: '1080' } });
    useTriggerDownloads.mockReturnValue({ triggerDownloads: mockTriggerDownloads });
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ availableTabs: ['videos'] }) });
    mockRefetch.mockResolvedValue(undefined);
    mockRefresh.mockResolvedValue(undefined);
  });

  describe('selecting many at once', () => {
    it('"Select pending" selects every video that is not downloaded, including ignored ones', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'Select pending' }));

      expect(dialogState().videoCount).toBe(2);
    });

    it('"Select downloaded" selects every downloaded video for deletion', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'Select downloaded' }));

      expect(dialogState().selectedForDeletion).toBe(2);
    });

    it('does not add videos that are already selected again', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'Select pending' }));
      await user.click(screen.getByRole('button', { name: 'Select pending' }));

      expect(dialogState().videoCount).toBe(2);
    });

    it('the table\'s select all follows the current selection mode', async () => {
      localStorage.setItem('youtarr:channelVideosViewMode', 'table');
      renderPage();

      await user.click(screen.getByRole('button', { name: 'table select all' }));

      expect(dialogState().videoCount).toBe(2);
    });

    it('clearing from the selection menu empties the selection', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));
      expect(dialogState().videoCount).toBe(1);

      await user.click(screen.getByRole('menuitem', { name: 'Clear Selection' }));

      expect(dialogState().videoCount).toBe(0);
    });
  });

  describe('downloading the selection', () => {
    it('opens the download dialog', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));

      await user.click(menuItem('Download'));

      expect(dialogState().download).toBe(true);
    });

    it('queues the selected videos with the default settings and opens the activity page', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download default' }));

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/downloads/activity'));
      expect(mockTriggerDownloads).toHaveBeenCalledWith({ urls: ['https://www.youtube.com/watch?v=never1'], overrideSettings: undefined, channelId: 'UC123456' });
    });

    it('passes custom settings as overrides', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download custom' }));

      await waitFor(() => expect(mockTriggerDownloads).toHaveBeenCalled());
      expect(mockTriggerDownloads.mock.calls[0][0].overrideSettings).toEqual({
        resolution: '720', allowRedownload: true, subfolder: '__kids', audioFormat: 'mp3_only', rating: 'PG', skipVideoFolder: true,
      });
    });

    it('clears the selection after queueing', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'confirm download default' }));

      await waitFor(() => expect(dialogState().videoCount).toBe(0));
    });

    it('closes the dialog without downloading', async () => {
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));
      await user.click(menuItem('Download'));

      await user.click(screen.getByRole('button', { name: 'close download dialog' }));

      expect(dialogState().download).toBe(false);
      expect(mockTriggerDownloads).not.toHaveBeenCalled();
    });
  });

  describe('ignoring videos', () => {
    it('ignores the selected videos in one request', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ message: 'Ignored 1 video' }) });
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));

      await user.click(menuItem('Ignore'));

      expect(await screen.findByRole('status')).toHaveTextContent('Ignored 1 video');
      const call = mockFetch.mock.calls.find(([url]) => String(url).includes('bulk-ignore'));
      expect(call[0]).toBe('/api/channels/UC123456/videos/bulk-ignore');
      expect(call[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-token': 'tok' }, body: JSON.stringify({ youtubeIds: ['never1'] }) });
    });

    it('falls back to a generic success message', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));

      await user.click(menuItem('Ignore'));

      expect(await screen.findByRole('status')).toHaveTextContent('Successfully ignored 1 videos');
    });

    it('clears the selection after a bulk ignore', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({}) });
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));

      await user.click(menuItem('Ignore'));

      await waitFor(() => expect(dialogState().videoCount).toBe(0));
    });

    it('reports a failed bulk ignore and keeps the selection', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockResolvedValue({ ok: false, json: jest.fn() });
      renderPage();
      await user.click(screen.getByRole('button', { name: 'select never1' }));

      await user.click(menuItem('Ignore'));

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to bulk ignore videos');
      expect(dialogState().videoCount).toBe(1);
      consoleError.mockRestore();
    });

    it('ignores a single video', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      renderPage();

      await user.click(screen.getByRole('button', { name: 'toggle ignore never1' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Video ignored. Channel downloads will exclude this video');
      expect(mockFetch).toHaveBeenCalledWith('/api/channels/UC123456/videos/never1/ignore', { method: 'POST', headers: { 'x-access-token': 'tok' } });
    });

    it('unignores a video that is currently ignored', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      renderPage();

      await user.click(screen.getByRole('button', { name: 'toggle ignore ign1' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Video unignored. Channel downloads will include this video');
      expect(mockFetch).toHaveBeenCalledWith('/api/channels/UC123456/videos/ign1/unignore', expect.any(Object));
    });

    it('reports a failed single ignore', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockResolvedValue({ ok: false });
      renderPage();

      await user.click(screen.getByRole('button', { name: 'toggle ignore never1' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to ignore video');
      consoleError.mockRestore();
    });

    it('reports a failed single unignore', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockRejectedValue(new Error('offline'));
      renderPage();

      await user.click(screen.getByRole('button', { name: 'toggle ignore ign1' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to unignore video');
      consoleError.mockRestore();
    });
  });

  describe('deleting videos', () => {
    const selectDownloaded = async () => {
      await user.click(screen.getByRole('button', { name: 'mark delete down1' }));
    };

    it('asks for confirmation first', async () => {
      renderPage();
      await selectDownloaded();

      await user.click(menuItem('Delete'));

      expect(dialogState().del).toBe(true);
      expect(mockDeleteByYoutubeIds).not.toHaveBeenCalled();
    });

    it('deletes the selected videos by YouTube id and reports success', async () => {
      mockDeleteByYoutubeIds.mockResolvedValue({ success: true, deleted: ['down1'], failed: [] });
      renderPage();
      await selectDownloaded();
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Successfully deleted 1 video');
      expect(mockDeleteByYoutubeIds).toHaveBeenCalledWith(['down1'], 'tok');
      expect(mockRefetch).toHaveBeenCalled();
    });

    it('uses the plural for several videos', async () => {
      mockDeleteByYoutubeIds.mockResolvedValue({ success: true, deleted: ['a', 'b'], failed: [] });
      renderPage();
      await user.click(screen.getByRole('button', { name: 'Select downloaded' }));
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Successfully deleted 2 videos');
    });

    it('reports a partial failure and keeps the videos that failed selected', async () => {
      mockDeleteByYoutubeIds.mockResolvedValue({ success: false, deleted: ['down1'], failed: [{ youtubeId: 'strm1', error: 'locked' }] });
      renderPage();
      await user.click(screen.getByRole('button', { name: 'Select downloaded' }));
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Deleted 1 video, but 1 failed');
      expect(dialogState().selectedForDeletion).toBe(1);
      expect(mockRefetch).toHaveBeenCalled();
    });

    it('reports the first error when nothing could be deleted', async () => {
      mockDeleteByYoutubeIds.mockResolvedValue({ success: false, deleted: [], failed: [{ youtubeId: 'down1', error: 'permission denied' }] });
      renderPage();
      await selectDownloaded();
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'confirm delete' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to delete videos: permission denied');
    });

    it('cancelling closes the dialog and keeps the selection', async () => {
      renderPage();
      await selectDownloaded();
      await user.click(menuItem('Delete'));

      await user.click(screen.getByRole('button', { name: 'cancel delete' }));

      expect(dialogState().del).toBe(false);
      expect(dialogState().selectedForDeletion).toBe(1);
    });
  });

  describe('STRM actions', () => {
    const selectFor = async (...names: string[]) => {
      for (const name of names) {
        await user.click(screen.getByRole('button', { name }));
      }
    };

    it('only offers Force Download when a STRM video is selected', async () => {
      renderPage();
      await selectFor('mark delete down1');

      expect(menuItem('Force Download')).toHaveAttribute('aria-disabled', 'true');
    });

    it('only offers Switch to STRM when a real download is selected', async () => {
      renderPage();
      await selectFor('mark delete strm1');

      expect(menuItem('Switch to STRM')).toHaveAttribute('aria-disabled', 'true');
    });

    it('counts eligible and skipped videos for a forced download', async () => {
      renderPage();
      await selectFor('mark delete strm1', 'mark delete down1');

      await user.click(menuItem('Force Download'));

      expect(screen.getByText('strm download: 1 eligible, 1 skipped')).toBeInTheDocument();
    });

    it('queues eligible videos and reports success', async () => {
      mockForceDownload.mockResolvedValue({ success: true, processed: [3], failed: [] });
      renderPage();
      await selectFor('mark delete strm1', 'mark delete down1');
      await user.click(menuItem('Force Download'));

      await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Queued 1 video for download');
      expect(mockForceDownload).toHaveBeenCalledWith([3], 'tok');
      await waitFor(() => expect(dialogState().selectedForDeletion).toBe(0));
    });

    it('reports a partial failure of a forced download', async () => {
      mockForceDownload.mockResolvedValue({ success: false, processed: [3], failed: [{ videoId: 9, error: 'x' }] });
      renderPage();
      await selectFor('mark delete strm1');
      await user.click(menuItem('Force Download'));

      await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Queued 1 video, but 1 failed');
    });

    it('reports when nothing could be queued', async () => {
      mockForceDownload.mockResolvedValue({ success: false, processed: [], failed: [{ videoId: 3, error: 'no room' }] });
      renderPage();
      await selectFor('mark delete strm1');
      await user.click(menuItem('Force Download'));

      await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to queue download: no room');
    });

    it('counts eligible and skipped videos for a switch back to STRM', async () => {
      renderPage();
      await selectFor('mark delete strm1', 'mark delete down1');

      await user.click(menuItem('Switch to STRM'));

      expect(screen.getByText('strm revert: 1 eligible, 1 skipped')).toBeInTheDocument();
    });

    it('switches eligible videos back to STRM and reports success', async () => {
      mockRevertToStrm.mockResolvedValue({ success: true, processed: [2], failed: [] });
      renderPage();
      await selectFor('mark delete down1');
      await user.click(menuItem('Switch to STRM'));

      await user.click(screen.getByRole('button', { name: 'confirm strm revert' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Switched 1 video back to STRM');
      expect(mockRevertToStrm).toHaveBeenCalledWith([2], 'tok');
    });

    it('reports a partial failure of a switch', async () => {
      mockRevertToStrm.mockResolvedValue({ success: false, processed: [2], failed: [{ videoId: 5, error: 'x' }] });
      renderPage();
      await selectFor('mark delete down1');
      await user.click(menuItem('Switch to STRM'));

      await user.click(screen.getByRole('button', { name: 'confirm strm revert' }));

      expect(await screen.findByRole('status')).toHaveTextContent('Switched 1 video back to STRM, but 1 failed');
    });

    it('reports when nothing could be switched', async () => {
      mockRevertToStrm.mockResolvedValue({ success: false, processed: [], failed: [{ videoId: 2, error: 'no backup' }] });
      renderPage();
      await selectFor('mark delete down1');
      await user.click(menuItem('Switch to STRM'));

      await user.click(screen.getByRole('button', { name: 'confirm strm revert' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to switch to STRM: no backup');
    });

    it('closing a dialog leaves the selection alone', async () => {
      renderPage();
      await selectFor('mark delete down1');
      await user.click(menuItem('Switch to STRM'));

      await user.click(screen.getByRole('button', { name: 'close strm revert' }));

      expect(screen.queryByText(/strm revert:/)).not.toBeInTheDocument();
      expect(dialogState().selectedForDeletion).toBe(1);
    });

    describe('from a single row chip', () => {
      beforeEach(() => {
        localStorage.setItem('youtarr:channelVideosViewMode', 'table');
      });

      it('opens the forced download for a STRM video', async () => {
        renderPage();

        await user.click(screen.getByRole('button', { name: 'strm chip strm1' }));

        expect(screen.getByText('strm download: 1 eligible, 0 skipped')).toBeInTheDocument();
      });

      it('opens the switch for a real download', async () => {
        renderPage();

        await user.click(screen.getByRole('button', { name: 'strm chip down1' }));

        expect(screen.getByText('strm revert: 1 eligible, 0 skipped')).toBeInTheDocument();
      });

      it('ignores a video with no database id', async () => {
        renderPage();

        await user.click(screen.getByRole('button', { name: 'strm chip never1' }));

        expect(screen.queryByText(/strm (download|revert):/)).not.toBeInTheDocument();
      });

      it('does not clear the checkbox selection after a single-row switch', async () => {
        mockForceDownload.mockResolvedValue({ success: true, processed: [3], failed: [] });
        renderPage();
        await user.click(screen.getByRole('button', { name: 'strm chip strm1' }));

        await user.click(screen.getByRole('button', { name: 'confirm strm download' }));

        expect(mockForceDownload).toHaveBeenCalledWith([3], 'tok');
        expect(await screen.findByRole('status')).toBeInTheDocument();
      });
    });
  });

  describe('protection', () => {
    it('toggles protection for a downloaded video', async () => {
      mockToggleProtection.mockResolvedValue(true);
      renderPage();

      await user.click(screen.getByRole('button', { name: 'toggle protection down1' }));

      expect(mockToggleProtection).toHaveBeenCalledWith(2, false);
    });

    it('ignores a video with no database id', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'toggle protection never1' }));

      expect(mockToggleProtection).not.toHaveBeenCalled();
    });

    it('shows the protection success message', () => {
      mockProtection = { error: null, successMessage: 'Video protected' };

      renderPage();

      expect(screen.getByRole('status')).toHaveTextContent('Video protected');
      expect(mockClearProtection).toHaveBeenCalled();
    });

    it('shows the protection error message', () => {
      mockProtection = { error: 'Could not protect', successMessage: null };

      renderPage();

      expect(screen.getByRole('alert')).toHaveTextContent('Could not protect');
    });
  });

  describe('refreshing and download all', () => {
    it('refreshes the videos and reloads the list', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'confirm refresh' }));

      await waitFor(() => expect(mockRefetch).toHaveBeenCalled());
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('cancelling a refresh closes the confirmation', async () => {
      renderPage();

      await user.click(screen.getByRole('button', { name: 'cancel refresh' }));

      expect(dialogState().refresh).toBe(false);
      expect(mockRefresh).not.toHaveBeenCalled();
    });
  });

  describe('messages', () => {
    it('closes the success message', async () => {
      mockProtection = { error: null, successMessage: 'Video protected' };
      renderPage();

      await user.click(screen.getByRole('button', { name: 'close success' }));

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('closes the error message', async () => {
      mockProtection = { error: 'Could not protect', successMessage: null };
      renderPage();

      await user.click(screen.getByRole('button', { name: 'close error' }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
