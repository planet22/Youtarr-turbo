import { renderHook, act } from '@testing-library/react';
import { usePlaylistMutations } from '../usePlaylistMutations';

jest.mock('axios', () => ({
  post: jest.fn(),
  delete: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  isAxiosError: jest.fn(),
}));

const axios = require('axios');

const HEADERS = { headers: { 'x-access-token': 'tok' } };
const serverError = (error: unknown) => ({ response: { data: { error } } });

describe('usePlaylistMutations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.isAxiosError.mockReturnValue(true);
  });

  describe('fetchPlaylistInfo', () => {
    it('posts the url and returns the preview', async () => {
      axios.post.mockResolvedValue({ data: { title: 'Mix', video_count: 3 } });
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      let preview;
      await act(async () => { preview = await result.current.fetchPlaylistInfo('https://youtube.com/playlist?list=PL1'); });

      expect(preview).toEqual({ title: 'Mix', video_count: 3 });
      expect(axios.post).toHaveBeenCalledWith('/api/playlists/addplaylistinfo', { url: 'https://youtube.com/playlist?list=PL1' }, { headers: { 'x-access-token': 'tok' } });
    });

    it('returns null without a token', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: null }));

      let preview;
      await act(async () => { preview = await result.current.fetchPlaylistInfo('x'); });

      expect(preview).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('uses the server error message on failure', async () => {
      axios.post.mockRejectedValue(serverError('Playlist is private'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      let preview;
      await act(async () => { preview = await result.current.fetchPlaylistInfo('x'); });

      expect(preview).toBeNull();
      expect(result.current.error).toBe('Playlist is private');
    });

    it('falls back to a generic message when the failure has no server text', async () => {
      axios.isAxiosError.mockReturnValue(false);
      axios.post.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.fetchPlaylistInfo('x'); });

      expect(result.current.error).toBe('Failed to fetch playlist info');
    });

    it('ignores a server error that is not a string', async () => {
      axios.post.mockRejectedValue(serverError({ code: 1 }));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.fetchPlaylistInfo('x'); });

      expect(result.current.error).toBe('Failed to fetch playlist info');
    });

    it('is not pending afterwards and clears a previous error on the next call', async () => {
      axios.post.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce({ data: {} });
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));
      await act(async () => { await result.current.fetchPlaylistInfo('x'); });

      await act(async () => { await result.current.fetchPlaylistInfo('x'); });

      expect(result.current.error).toBeNull();
      expect(result.current.pending).toBe(false);
    });

    it('is pending while the request is in flight', async () => {
      axios.post.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      act(() => { void result.current.fetchPlaylistInfo('x'); });

      expect(result.current.pending).toBe(true);
    });
  });

  describe('subscribe', () => {
    it('returns null without a token', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: null }));

      let res;
      await act(async () => { res = await result.current.subscribe('x'); });

      expect(res).toBeNull();
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('sends empty settings by default', async () => {
      axios.post.mockResolvedValue({ data: { playlist: { playlist_id: 'PL1' } } });
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.subscribe('x'); });

      expect(axios.post).toHaveBeenCalledWith('/api/playlists', { url: 'x', settings: {} }, { headers: { 'x-access-token': 'tok' } });
    });

    it('falls back to a generic message when the failure has no server text', async () => {
      axios.isAxiosError.mockReturnValue(false);
      axios.post.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.subscribe('x'); });

      expect(result.current.error).toBe('Failed to subscribe to playlist');
    });
  });

  describe('patchPlaylist', () => {
    it('patches the playlist and returns the updated one', async () => {
      axios.patch.mockResolvedValue({ data: { playlist: { playlist_id: 'PL1', enabled: false } } });
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      let updated;
      await act(async () => { updated = await result.current.patchPlaylist('PL1', { enabled: false }); });

      expect(updated).toEqual({ playlist_id: 'PL1', enabled: false });
      expect(axios.patch).toHaveBeenCalledWith('/api/playlists/PL1', { enabled: false }, { headers: { 'x-access-token': 'tok' } });
    });

    it('returns null without a token', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: null }));

      let updated;
      await act(async () => { updated = await result.current.patchPlaylist('PL1', { enabled: true }); });

      expect(updated).toBeNull();
      expect(axios.patch).not.toHaveBeenCalled();
    });

    it('sets the server error on failure', async () => {
      axios.patch.mockRejectedValue(serverError('Not allowed'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      let updated;
      await act(async () => { updated = await result.current.patchPlaylist('PL1', { enabled: true }); });

      expect(updated).toBeNull();
      expect(result.current.error).toBe('Not allowed');
    });

    it('falls back to a generic message', async () => {
      axios.isAxiosError.mockReturnValue(false);
      axios.patch.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.patchPlaylist('PL1', { enabled: true }); });

      expect(result.current.error).toBe('Failed to update playlist');
    });
  });

  describe('convenience toggles', () => {
    beforeEach(() => {
      axios.patch.mockResolvedValue({ data: { playlist: { playlist_id: 'PL1' } } });
    });

    it.each([
      ['plex', 'sync_to_plex'],
      ['jellyfin', 'sync_to_jellyfin'],
      ['emby', 'sync_to_emby'],
    ] as const)('toggles syncing to %s via %s', async (server, key) => {
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.toggleSyncTarget('PL1', server, true); });

      expect(axios.patch).toHaveBeenCalledWith('/api/playlists/PL1', { [key]: true }, HEADERS);
    });

    it('turns syncing off', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.toggleSyncTarget('PL1', 'plex', false); });

      expect(axios.patch.mock.calls[0][1]).toEqual({ sync_to_plex: false });
    });

    it('toggles public visibility', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.togglePublic('PL1', true); });

      expect(axios.patch).toHaveBeenCalledWith('/api/playlists/PL1', { public_on_servers: true }, HEADERS);
    });

    it('toggles auto download', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.toggleAutoDownload('PL1', true); });

      expect(axios.patch).toHaveBeenCalledWith('/api/playlists/PL1', { auto_download: true }, HEADERS);
    });

    it('returns the updated playlist', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      let updated;
      await act(async () => { updated = await result.current.togglePublic('PL1', false); });

      expect(updated).toEqual({ playlist_id: 'PL1' });
    });
  });

  describe.each([
    ['ignoreVideo', 'ignore', 'Failed to ignore video'],
    ['unignoreVideo', 'unignore', 'Failed to unignore video'],
  ] as const)('%s', (method, path, fallback) => {
    it('posts to the video endpoint and reports success', async () => {
      axios.post.mockResolvedValue({});
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      let ok;
      await act(async () => { ok = await result.current[method]('PL1', 'vid12345678'); });

      expect(ok).toBe(true);
      expect(axios.post).toHaveBeenCalledWith(`/api/playlists/PL1/videos/vid12345678/${path}`, {}, HEADERS);
    });

    it('returns false without a token', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: null }));

      let ok;
      await act(async () => { ok = await result.current[method]('PL1', 'vid'); });

      expect(ok).toBe(false);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('uses the server error on failure', async () => {
      axios.post.mockRejectedValue(serverError('Video not in playlist'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      let ok;
      await act(async () => { ok = await result.current[method]('PL1', 'vid'); });

      expect(ok).toBe(false);
      expect(result.current.error).toBe('Video not in playlist');
    });

    it('falls back to a generic message', async () => {
      axios.isAxiosError.mockReturnValue(false);
      axios.post.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current[method]('PL1', 'vid'); });

      expect(result.current.error).toBe(fallback);
    });
  });

  describe('unsubscribe and updateSettings fallbacks', () => {
    it('uses a generic message when unsubscribing fails without server text', async () => {
      axios.isAxiosError.mockReturnValue(false);
      axios.delete.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.unsubscribe('PL1'); });

      expect(result.current.error).toBe('Failed to unsubscribe');
    });

    it('uses a generic message when saving settings fails without server text', async () => {
      axios.isAxiosError.mockReturnValue(false);
      axios.put.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => usePlaylistMutations({ token: 'tok' }));

      await act(async () => { await result.current.updateSettings('PL1', {}); });

      expect(result.current.error).toBe('Failed to update settings');
    });

    it('returns false from updateSettings without a token', async () => {
      const { result } = renderHook(() => usePlaylistMutations({ token: null }));

      let ok;
      await act(async () => { ok = await result.current.updateSettings('PL1', {}); });

      expect(ok).toBe(false);
      expect(axios.put).not.toHaveBeenCalled();
    });
  });
});
