import { renderHook, act } from '@testing-library/react';

jest.mock('axios', () => ({ get: jest.fn(), delete: jest.fn(), post: jest.fn() }));
const axios = require('axios');

import { useCacheActions } from '../useCacheActions';

const AUTH = { headers: { 'x-access-token': 'tok' } };
const serverError = (error: string) => ({ response: { data: { error } } });

describe('useCacheActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('clearMetadataCache', () => {
    it('deletes the cached metadata and reports success', async () => {
      axios.delete.mockResolvedValue({});
      const { result } = renderHook(() => useCacheActions('tok'));

      let ok;
      await act(async () => { ok = await result.current.clearMetadataCache('abc'); });

      expect(ok).toBe(true);
      expect(axios.delete).toHaveBeenCalledWith('/api/ytstream/abc/metadata-cache', AUTH);
    });

    it('url-encodes the video id', async () => {
      axios.delete.mockResolvedValue({});
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.clearMetadataCache('a b'); });

      expect(axios.delete.mock.calls[0][0]).toBe('/api/ytstream/a%20b/metadata-cache');
    });

    it('returns false without calling the server when there is no token', async () => {
      const { result } = renderHook(() => useCacheActions(null));

      let ok;
      await act(async () => { ok = await result.current.clearMetadataCache('abc'); });

      expect(ok).toBe(false);
      expect(axios.delete).not.toHaveBeenCalled();
    });

    it('surfaces the server error message on failure', async () => {
      axios.delete.mockRejectedValue(serverError('Cache locked'));
      const { result } = renderHook(() => useCacheActions('tok'));

      let ok;
      await act(async () => { ok = await result.current.clearMetadataCache('abc'); });

      expect(ok).toBe(false);
      expect(result.current.error).toBe('Cache locked');
    });

    it('falls back to a generic message when the failure has no server text', async () => {
      axios.delete.mockRejectedValue(new Error('network'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.clearMetadataCache('abc'); });

      expect(result.current.error).toBe('Failed to clear cached metadata');
    });

    it('clears a previous error when the next call starts', async () => {
      axios.delete.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({});
      const { result } = renderHook(() => useCacheActions('tok'));
      await act(async () => { await result.current.clearMetadataCache('abc'); });

      await act(async () => { await result.current.clearMetadataCache('abc'); });

      expect(result.current.error).toBeNull();
    });

    it('is not loading once the call has finished', async () => {
      axios.delete.mockResolvedValue({});
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.clearMetadataCache('abc'); });

      expect(result.current.loading).toBe(false);
    });
  });

  describe('bulkClearMetadataCache', () => {
    it('sends every id and returns the server result', async () => {
      axios.delete.mockResolvedValue({ data: { success: true, failed: [] } });
      const { result } = renderHook(() => useCacheActions('tok'));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearMetadataCache(['a', 'b']); });

      expect(outcome).toEqual({ success: true, failed: [] });
      expect(axios.delete).toHaveBeenCalledWith('/api/ytstream/metadata-cache/bulk', { ...AUTH, data: { youtubeIds: ['a', 'b'] } });
    });

    it('returns the ids the server could not clear', async () => {
      axios.delete.mockResolvedValue({ data: { success: false, failed: ['b'] } });
      const { result } = renderHook(() => useCacheActions('tok'));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearMetadataCache(['a', 'b']); });

      expect(outcome).toEqual({ success: false, failed: ['b'] });
    });

    it('treats a missing failed list as empty', async () => {
      axios.delete.mockResolvedValue({ data: { success: true } });
      const { result } = renderHook(() => useCacheActions('tok'));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearMetadataCache(['a']); });

      expect(outcome).toEqual({ success: true, failed: [] });
    });

    it.each([
      ['no token', null, ['a']],
      ['an empty selection', 'tok', []],
    ])('fails without calling the server for %s', async (_label, token, ids) => {
      const { result } = renderHook(() => useCacheActions(token));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearMetadataCache(ids); });

      expect(outcome).toEqual({ success: false, failed: ids });
      expect(axios.delete).not.toHaveBeenCalled();
    });

    it('reports every id as failed and sets the error when the request throws', async () => {
      axios.delete.mockRejectedValue(serverError('Too many'));
      const { result } = renderHook(() => useCacheActions('tok'));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearMetadataCache(['a', 'b']); });

      expect(outcome).toEqual({ success: false, failed: ['a', 'b'] });
      expect(result.current.error).toBe('Too many');
    });

    it('uses the generic message when the request throws without server text', async () => {
      axios.delete.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.bulkClearMetadataCache(['a']); });

      expect(result.current.error).toBe('Failed to clear cached metadata');
    });
  });

  describe('fetchMetadataDetail', () => {
    it('returns the detail', async () => {
      axios.get.mockResolvedValue({ data: { youtubeId: 'abc', hasRawInfoJson: true } });
      const { result } = renderHook(() => useCacheActions('tok'));

      let detail;
      await act(async () => { detail = await result.current.fetchMetadataDetail('abc'); });

      expect(detail).toEqual({ youtubeId: 'abc', hasRawInfoJson: true });
      expect(axios.get).toHaveBeenCalledWith('/api/ytstream/abc/metadata-cache/detail', AUTH);
    });

    it('asks for the raw blob only when requested', async () => {
      axios.get.mockResolvedValue({ data: {} });
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.fetchMetadataDetail('abc', true); });

      expect(axios.get.mock.calls[0][0]).toBe('/api/ytstream/abc/metadata-cache/detail?raw=true');
    });

    it('returns null without a token', async () => {
      const { result } = renderHook(() => useCacheActions(null));

      let detail;
      await act(async () => { detail = await result.current.fetchMetadataDetail('abc'); });

      expect(detail).toBeNull();
      expect(axios.get).not.toHaveBeenCalled();
    });

    it('returns null and sets the error on failure', async () => {
      axios.get.mockRejectedValue(serverError('Not cached'));
      const { result } = renderHook(() => useCacheActions('tok'));

      let detail;
      await act(async () => { detail = await result.current.fetchMetadataDetail('abc'); });

      expect(detail).toBeNull();
      expect(result.current.error).toBe('Not cached');
    });

    it('uses the generic message when the failure has no server text', async () => {
      axios.get.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.fetchMetadataDetail('abc'); });

      expect(result.current.error).toBe('Failed to load cached metadata');
    });
  });

  describe('refreshMetadataCache', () => {
    it('posts a refresh and reports success', async () => {
      axios.post.mockResolvedValue({});
      const { result } = renderHook(() => useCacheActions('tok'));

      let ok;
      await act(async () => { ok = await result.current.refreshMetadataCache('abc'); });

      expect(ok).toBe(true);
      expect(axios.post).toHaveBeenCalledWith('/api/videos/abc/metadata/refresh', null, AUTH);
    });

    it('returns false without a token', async () => {
      const { result } = renderHook(() => useCacheActions(null));

      let ok;
      await act(async () => { ok = await result.current.refreshMetadataCache('abc'); });

      expect(ok).toBe(false);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('surfaces the server error on failure', async () => {
      axios.post.mockRejectedValue(serverError('yt-dlp failed'));
      const { result } = renderHook(() => useCacheActions('tok'));

      let ok;
      await act(async () => { ok = await result.current.refreshMetadataCache('abc'); });

      expect(ok).toBe(false);
      expect(result.current.error).toBe('yt-dlp failed');
    });

    it('uses the generic message when the failure has no server text', async () => {
      axios.post.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.refreshMetadataCache('abc'); });

      expect(result.current.error).toBe('Failed to refresh cached metadata');
    });
  });

  describe('clearVideoCache', () => {
    it('deletes the cached video and reports success', async () => {
      axios.delete.mockResolvedValue({});
      const { result } = renderHook(() => useCacheActions('tok'));

      let ok;
      await act(async () => { ok = await result.current.clearVideoCache('abc'); });

      expect(ok).toBe(true);
      expect(axios.delete).toHaveBeenCalledWith('/api/ytstream/abc/untracked-cache', AUTH);
    });

    it('returns false without a token', async () => {
      const { result } = renderHook(() => useCacheActions(null));

      let ok;
      await act(async () => { ok = await result.current.clearVideoCache('abc'); });

      expect(ok).toBe(false);
    });

    it('surfaces the server error on failure', async () => {
      axios.delete.mockRejectedValue(serverError('In use'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.clearVideoCache('abc'); });

      expect(result.current.error).toBe('In use');
    });

    it('uses the generic message when the failure has no server text', async () => {
      axios.delete.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.clearVideoCache('abc'); });

      expect(result.current.error).toBe('Failed to clear cached video');
    });
  });

  describe('bulkClearVideoCache', () => {
    it('sends every id and returns the server result', async () => {
      axios.delete.mockResolvedValue({ data: { success: false, failed: ['b'] } });
      const { result } = renderHook(() => useCacheActions('tok'));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearVideoCache(['a', 'b']); });

      expect(outcome).toEqual({ success: false, failed: ['b'] });
      expect(axios.delete).toHaveBeenCalledWith('/api/ytstream/untracked-cache/bulk', { ...AUTH, data: { youtubeIds: ['a', 'b'] } });
    });

    it('treats a missing failed list as empty', async () => {
      axios.delete.mockResolvedValue({ data: { success: true } });
      const { result } = renderHook(() => useCacheActions('tok'));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearVideoCache(['a']); });

      expect(outcome).toEqual({ success: true, failed: [] });
    });

    it.each([
      ['no token', null, ['a']],
      ['an empty selection', 'tok', []],
    ])('fails without calling the server for %s', async (_label, token, ids) => {
      const { result } = renderHook(() => useCacheActions(token));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearVideoCache(ids); });

      expect(outcome).toEqual({ success: false, failed: ids });
      expect(axios.delete).not.toHaveBeenCalled();
    });

    it('reports every id as failed when the request throws', async () => {
      axios.delete.mockRejectedValue(serverError('Nope'));
      const { result } = renderHook(() => useCacheActions('tok'));

      let outcome;
      await act(async () => { outcome = await result.current.bulkClearVideoCache(['a', 'b']); });

      expect(outcome).toEqual({ success: false, failed: ['a', 'b'] });
      expect(result.current.error).toBe('Nope');
    });

    it('uses the generic message when the request throws without server text', async () => {
      axios.delete.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.bulkClearVideoCache(['a']); });

      expect(result.current.error).toBe('Failed to clear cached video');
    });
  });

  describe('fetchVideoCacheDetail', () => {
    it('returns the cached file info', async () => {
      axios.get.mockResolvedValue({ data: { exists: true, size: 10, mtime: '2026-01-01' } });
      const { result } = renderHook(() => useCacheActions('tok'));

      let detail;
      await act(async () => { detail = await result.current.fetchVideoCacheDetail('abc'); });

      expect(detail).toEqual({ exists: true, size: 10, mtime: '2026-01-01' });
      expect(axios.get).toHaveBeenCalledWith('/api/ytstream/abc/untracked-cache', AUTH);
    });

    it('returns null without a token', async () => {
      const { result } = renderHook(() => useCacheActions(null));

      let detail;
      await act(async () => { detail = await result.current.fetchVideoCacheDetail('abc'); });

      expect(detail).toBeNull();
    });

    it('returns null and sets the error on failure', async () => {
      axios.get.mockRejectedValue(serverError('Missing'));
      const { result } = renderHook(() => useCacheActions('tok'));

      let detail;
      await act(async () => { detail = await result.current.fetchVideoCacheDetail('abc'); });

      expect(detail).toBeNull();
      expect(result.current.error).toBe('Missing');
    });

    it('uses the generic message when the failure has no server text', async () => {
      axios.get.mockRejectedValue(new Error('x'));
      const { result } = renderHook(() => useCacheActions('tok'));

      await act(async () => { await result.current.fetchVideoCacheDetail('abc'); });

      expect(result.current.error).toBe('Failed to load cached video info');
    });
  });
});
