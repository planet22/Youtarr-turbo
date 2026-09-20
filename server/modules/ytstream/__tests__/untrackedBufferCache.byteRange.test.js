/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));
jest.mock('../byteRangeCacheIndex', () => ({
  listByteRangeCacheEntries: jest.fn(),
  deleteByteRangeCacheForVideo: jest.fn(),
  sweepExpiredByteRangeCache: jest.fn(),
}));

const fs = require('fs');
const path = require('path');

jest.mock('../paths', () => ({
  HLS_UNTRACKED_BUFFER_CACHE_DIR: require('path').join(require('os').tmpdir(), 'hls-untracked-test-fixed'),
}));

const byteRangeIndex = require('../byteRangeCacheIndex');
const paths = require('../paths');
const {
  listUntrackedBufferCacheEntries,
  getUntrackedBufferCacheStat,
  deleteUntrackedBufferCacheFile,
} = require('../untrackedBufferCache');

const byteRangeEntry = (youtubeId, mtime, size = 500, partial = false) => ({ youtubeId, size, mtime, filePath: `/br/${youtubeId}.mp4`, partial });

describe('untrackedBufferCache with hls-byterange stealth cache entries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(paths.HLS_UNTRACKED_BUFFER_CACHE_DIR, { recursive: true, force: true });
    fs.mkdirSync(paths.HLS_UNTRACKED_BUFFER_CACHE_DIR, { recursive: true });
    byteRangeIndex.listByteRangeCacheEntries.mockResolvedValue([]);
    byteRangeIndex.deleteByteRangeCacheForVideo.mockResolvedValue({ deletedFiles: 0, freedBytes: 0 });
    byteRangeIndex.sweepExpiredByteRangeCache.mockResolvedValue({ deleted: 0, freedBytes: 0 });
  });

  afterAll(() => {
    fs.rmSync(paths.HLS_UNTRACKED_BUFFER_CACHE_DIR, { recursive: true, force: true });
  });

  describe('listUntrackedBufferCacheEntries', () => {
    it('includes a byte-range stealth cache entry', async () => {
      byteRangeIndex.listByteRangeCacheEntries.mockResolvedValue([byteRangeEntry('vid00000001', '2026-09-18T10:00:00.000Z')]);
      const entries = await listUntrackedBufferCacheEntries();
      expect(entries).toEqual([expect.objectContaining({ youtubeId: 'vid00000001', size: 500 })]);
    });

    it('lists a video cached by both modes once, keeping the newest entry', async () => {
      fs.writeFileSync(path.join(paths.HLS_UNTRACKED_BUFFER_CACHE_DIR, 'vid00000001.ts'), Buffer.alloc(100));
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      byteRangeIndex.listByteRangeCacheEntries.mockResolvedValue([byteRangeEntry('vid00000001', future, 900)]);
      const entries = await listUntrackedBufferCacheEntries();
      expect(entries).toEqual([expect.objectContaining({ youtubeId: 'vid00000001', size: 900 })]);
    });

    it('carries the partial flag of a byte-range entry through', async () => {
      byteRangeIndex.listByteRangeCacheEntries.mockResolvedValue([byteRangeEntry('vid00000001', '2026-09-18T10:00:00.000Z', 500, true)]);
      expect((await listUntrackedBufferCacheEntries())[0].partial).toBe(true);
    });

    it('prefers a complete entry over a newer partial one for the same video', async () => {
      byteRangeIndex.listByteRangeCacheEntries.mockResolvedValue([
        byteRangeEntry('vid00000001', '2026-09-18T10:00:00.000Z', 900, false),
        byteRangeEntry('vid00000001', '2026-09-18T12:00:00.000Z', 300, true),
      ]);
      expect((await listUntrackedBufferCacheEntries())[0]).toEqual(expect.objectContaining({ size: 900, partial: false }));
    });

    it('still lists hls-buffer entries when there are no byte-range entries', async () => {
      fs.writeFileSync(path.join(paths.HLS_UNTRACKED_BUFFER_CACHE_DIR, 'vid00000002.mp4'), Buffer.alloc(100));
      const entries = await listUntrackedBufferCacheEntries();
      expect(entries.map((e) => e.youtubeId)).toEqual(['vid00000002']);
    });
  });

  describe('getUntrackedBufferCacheStat', () => {
    it('falls back to a byte-range entry when hls-buffer has no file for the video', async () => {
      byteRangeIndex.listByteRangeCacheEntries.mockResolvedValue([byteRangeEntry('vid00000001', '2026-09-18T10:00:00.000Z', 700)]);
      expect(await getUntrackedBufferCacheStat('vid00000001')).toEqual({ exists: true, size: 700, mtime: '2026-09-18T10:00:00.000Z', partial: false });
    });

    it('reports nothing when neither cache has the video', async () => {
      expect(await getUntrackedBufferCacheStat('vid00000001')).toEqual({ exists: false, size: null, mtime: null });
    });
  });

  describe('deleteUntrackedBufferCacheFile', () => {
    it('reports a delete when only byte-range entries existed', async () => {
      byteRangeIndex.deleteByteRangeCacheForVideo.mockResolvedValue({ deletedFiles: 1, freedBytes: 500 });
      expect(await deleteUntrackedBufferCacheFile('vid00000001')).toBe(true);
    });

    it('deletes the hls-buffer file as well', async () => {
      const filePath = path.join(paths.HLS_UNTRACKED_BUFFER_CACHE_DIR, 'vid00000001.ts');
      fs.writeFileSync(filePath, Buffer.alloc(10));
      await deleteUntrackedBufferCacheFile('vid00000001');
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('reports nothing deleted when neither cache had the video', async () => {
      expect(await deleteUntrackedBufferCacheFile('vid00000001')).toBe(false);
    });
  });
});
