/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untracked-cache-'));

jest.mock('../../../logger');
jest.mock('../../configModule', () => ({ getConfig: jest.fn() }));
jest.mock('../paths', () => ({ HLS_UNTRACKED_BUFFER_CACHE_DIR: mockCacheDir }));
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../byteRangeCacheIndex', () => ({
  listByteRangeCacheEntries: jest.fn(),
  deleteByteRangeCacheForVideo: jest.fn(),
  sweepExpiredByteRangeCache: jest.fn(),
}));

const logger = require('../../../logger');
const configModule = require('../../configModule');
const byteRange = require('../byteRangeCacheIndex');
const cache = require('../untrackedBufferCache');

const HOUR_MS = 60 * 60 * 1000;
const YT_ID = 'dQw4w9WgXcQ';

describe('untrackedBufferCache', () => {
  const write = (name, contents = 'x', ageHours = 0) => {
    const filePath = path.join(mockCacheDir, name);
    fs.writeFileSync(filePath, contents);
    if (ageHours) {
      const when = new Date(Date.now() - ageHours * HOUR_MS);
      fs.utimesSync(filePath, when, when);
    }
    return filePath;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    fs.rmSync(mockCacheDir, { recursive: true, force: true });
    fs.mkdirSync(mockCacheDir, { recursive: true });
    configModule.getConfig.mockReturnValue({});
    byteRange.listByteRangeCacheEntries.mockResolvedValue([]);
    byteRange.deleteByteRangeCacheForVideo.mockResolvedValue({ deletedFiles: 0 });
    byteRange.sweepExpiredByteRangeCache.mockResolvedValue({ deleted: 0, freedBytes: 0 });
  });

  afterAll(() => {
    fs.rmSync(mockCacheDir, { recursive: true, force: true });
  });

  describe('paths', () => {
    it('keys the .ts cache by video id', () => {
      expect(cache.getUntrackedBufferCachePath(YT_ID)).toBe(path.join(mockCacheDir, `${YT_ID}.ts`));
    });

    it('keys the .mp4 cache by video id', () => {
      expect(cache.getUntrackedBufferCacheMp4Path(YT_ID)).toBe(path.join(mockCacheDir, `${YT_ID}.mp4`));
    });
  });

  describe('findWarmUntrackedBufferCache', () => {
    it('returns null when nothing is cached', () => {
      expect(cache.findWarmUntrackedBufferCache(YT_ID)).toBeNull();
    });

    it('finds a cached .ts', () => {
      const ts = write(`${YT_ID}.ts`);

      expect(cache.findWarmUntrackedBufferCache(YT_ID)).toBe(ts);
    });

    it('finds a cached .mp4', () => {
      const mp4 = write(`${YT_ID}.mp4`);

      expect(cache.findWarmUntrackedBufferCache(YT_ID)).toBe(mp4);
    });

    it('prefers the .mp4 a finalize leaves behind', () => {
      write(`${YT_ID}.ts`);
      const mp4 = write(`${YT_ID}.mp4`);

      expect(cache.findWarmUntrackedBufferCache(YT_ID)).toBe(mp4);
    });
  });

  describe('sweepExpiredUntrackedBufferCache', () => {
    it.each([undefined, 0, -5, 'abc'])('does nothing when expiry is %p', async (hours) => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: hours } });
      const old = write('old.ts', 'x', 500);

      await expect(cache.sweepExpiredUntrackedBufferCache()).resolves.toEqual({ deleted: 0, freedBytes: 0, thresholdHours: 0 });

      expect(fs.existsSync(old)).toBe(true);
      expect(byteRange.sweepExpiredByteRangeCache).not.toHaveBeenCalled();
    });

    it('deletes files older than the threshold and reports what it freed', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: 24 } });
      const old = write('old.ts', '12345', 48);
      const fresh = write('fresh.ts', 'x', 1);

      const result = await cache.sweepExpiredUntrackedBufferCache();

      expect(result).toEqual({ deleted: 1, freedBytes: 5, thresholdHours: 24 });
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    });

    it('accepts the threshold as a numeric string', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: '24' } });
      write('old.ts', 'x', 48);

      expect((await cache.sweepExpiredUntrackedBufferCache()).deleted).toBe(1);
    });

    it('ignores sub-directories', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: 24 } });
      const dir = path.join(mockCacheDir, 'nested');
      fs.mkdirSync(dir);
      const when = new Date(Date.now() - 100 * HOUR_MS);
      fs.utimesSync(dir, when, when);

      await cache.sweepExpiredUntrackedBufferCache();

      expect(fs.existsSync(dir)).toBe(true);
    });

    it('adds the byte-range stealth cache sweep to the totals', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: 24 } });
      byteRange.sweepExpiredByteRangeCache.mockResolvedValue({ deleted: 3, freedBytes: 300 });
      write('old.ts', '12345', 48);

      const result = await cache.sweepExpiredUntrackedBufferCache();

      expect(result).toEqual({ deleted: 4, freedBytes: 305, thresholdHours: 24 });
    });

    it('gives the byte-range sweep the same cutoff', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: 24 } });
      jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000);

      await cache.sweepExpiredUntrackedBufferCache();

      expect(byteRange.sweepExpiredByteRangeCache).toHaveBeenCalledWith(1_000_000_000 - 24 * HOUR_MS);
    });

    it('keeps going and warns when one file cannot be removed', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: 24 } });
      write('a.ts', 'x', 48);
      write('b.ts', 'x', 48);
      jest.spyOn(fs.promises, 'unlink').mockRejectedValueOnce(new Error('busy'));

      const result = await cache.sweepExpiredUntrackedBufferCache();

      expect(result.deleted).toBe(1);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('still sweeps the byte-range cache when the directory does not exist', async () => {
      configModule.getConfig.mockReturnValue({ strm: { cacheOnPlayExpiryHours: 24 } });
      fs.rmSync(mockCacheDir, { recursive: true, force: true });
      byteRange.sweepExpiredByteRangeCache.mockResolvedValue({ deleted: 2, freedBytes: 20 });

      await expect(cache.sweepExpiredUntrackedBufferCache()).resolves.toMatchObject({ deleted: 2, freedBytes: 20 });
      fs.mkdirSync(mockCacheDir, { recursive: true });
    });
  });

  describe('getUntrackedBufferCacheStat', () => {
    it('reports size and modified time of a cached file', async () => {
      write(`${YT_ID}.ts`, '1234567');

      const stat = await cache.getUntrackedBufferCacheStat(YT_ID);

      expect(stat).toEqual({ exists: true, size: 7, mtime: expect.any(String) });
    });

    it('reports nothing cached', async () => {
      await expect(cache.getUntrackedBufferCacheStat(YT_ID)).resolves.toEqual({ exists: false, size: null, mtime: null });
    });

    it('falls back to a byte-range entry when there is no buffer file', async () => {
      byteRange.listByteRangeCacheEntries.mockResolvedValue([{ youtubeId: YT_ID, size: 99, mtime: '2026-01-01T00:00:00.000Z', partial: true }]);

      await expect(cache.getUntrackedBufferCacheStat(YT_ID)).resolves.toEqual({ exists: true, size: 99, mtime: '2026-01-01T00:00:00.000Z', partial: true });
    });

    it('marks a complete byte-range entry as not partial', async () => {
      byteRange.listByteRangeCacheEntries.mockResolvedValue([{ youtubeId: YT_ID, size: 99, mtime: '2026-01-01T00:00:00.000Z' }]);

      expect((await cache.getUntrackedBufferCacheStat(YT_ID)).partial).toBe(false);
    });

    it('prefers a complete byte-range entry over a partial one', async () => {
      byteRange.listByteRangeCacheEntries.mockResolvedValue([
        { youtubeId: YT_ID, size: 1, mtime: '2026-03-01T00:00:00.000Z', partial: true },
        { youtubeId: YT_ID, size: 2, mtime: '2026-01-01T00:00:00.000Z' },
      ]);

      expect((await cache.getUntrackedBufferCacheStat(YT_ID)).size).toBe(2);
    });

    it('ignores byte-range entries for other videos', async () => {
      byteRange.listByteRangeCacheEntries.mockResolvedValue([{ youtubeId: 'someoneElse1', size: 5, mtime: '2026-01-01T00:00:00.000Z' }]);

      await expect(cache.getUntrackedBufferCacheStat(YT_ID)).resolves.toMatchObject({ exists: false });
    });

    it('reports nothing when the file vanishes between lookup and stat', async () => {
      write(`${YT_ID}.ts`);
      jest.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

      await expect(cache.getUntrackedBufferCacheStat(YT_ID)).resolves.toEqual({ exists: false, size: null, mtime: null });
    });

    it('rethrows any other stat failure', async () => {
      write(`${YT_ID}.ts`);
      jest.spyOn(fs.promises, 'stat').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(cache.getUntrackedBufferCacheStat(YT_ID)).rejects.toThrow('denied');
    });
  });

  describe('deleteUntrackedBufferCacheFile', () => {
    it('deletes the cached file and reports it', async () => {
      const ts = write(`${YT_ID}.ts`);

      await expect(cache.deleteUntrackedBufferCacheFile(YT_ID)).resolves.toBe(true);

      expect(fs.existsSync(ts)).toBe(false);
    });

    it('also clears any byte-range cache for the video', async () => {
      write(`${YT_ID}.ts`);

      await cache.deleteUntrackedBufferCacheFile(YT_ID);

      expect(byteRange.deleteByteRangeCacheForVideo).toHaveBeenCalledWith(YT_ID);
    });

    it('reports false when nothing existed', async () => {
      await expect(cache.deleteUntrackedBufferCacheFile(YT_ID)).resolves.toBe(false);
    });

    it('reports true when only byte-range files were removed', async () => {
      byteRange.deleteByteRangeCacheForVideo.mockResolvedValue({ deletedFiles: 2 });

      await expect(cache.deleteUntrackedBufferCacheFile(YT_ID)).resolves.toBe(true);
    });

    it('accounts for a file that disappears mid-delete', async () => {
      write(`${YT_ID}.ts`);
      jest.spyOn(fs.promises, 'unlink').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

      await expect(cache.deleteUntrackedBufferCacheFile(YT_ID)).resolves.toBe(false);
    });

    it('rethrows any other delete failure', async () => {
      write(`${YT_ID}.ts`);
      jest.spyOn(fs.promises, 'unlink').mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

      await expect(cache.deleteUntrackedBufferCacheFile(YT_ID)).rejects.toThrow('denied');
    });
  });

  describe('listUntrackedBufferCacheEntries', () => {
    it('lists .ts and .mp4 files keyed by video id', async () => {
      write('aaaaaaaaaaa.ts', '123');
      write('bbbbbbbbbbb.mp4', '12345');

      const entries = await cache.listUntrackedBufferCacheEntries();

      expect(entries.map((e) => [e.youtubeId, e.size]).sort()).toEqual([['aaaaaaaaaaa', 3], ['bbbbbbbbbbb', 5]]);
    });

    it('ignores other file types and directories', async () => {
      write('notes.txt');
      write('cover.jpg');
      fs.mkdirSync(path.join(mockCacheDir, 'dir.ts'));

      await expect(cache.listUntrackedBufferCacheEntries()).resolves.toEqual([]);
    });

    it('returns nothing when the directory does not exist', async () => {
      fs.rmSync(mockCacheDir, { recursive: true, force: true });

      await expect(cache.listUntrackedBufferCacheEntries()).resolves.toEqual([]);
      fs.mkdirSync(mockCacheDir, { recursive: true });
    });

    it('warns and skips an entry it cannot stat', async () => {
      write('aaaaaaaaaaa.ts');
      jest.spyOn(fs.promises, 'stat').mockRejectedValue(new Error('io error'));

      await expect(cache.listUntrackedBufferCacheEntries()).resolves.toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('merges in byte-range entries for other videos', async () => {
      write('aaaaaaaaaaa.ts');
      byteRange.listByteRangeCacheEntries.mockResolvedValue([{ youtubeId: 'ccccccccccc', size: 9, mtime: '2026-01-01T00:00:00.000Z' }]);

      const ids = (await cache.listUntrackedBufferCacheEntries()).map((e) => e.youtubeId).sort();

      expect(ids).toEqual(['aaaaaaaaaaa', 'ccccccccccc']);
    });

    it('keeps one row per video, preferring a complete entry over a partial one', async () => {
      write('aaaaaaaaaaa.ts', '123');
      byteRange.listByteRangeCacheEntries.mockResolvedValue([{ youtubeId: 'aaaaaaaaaaa', size: 999, mtime: '2099-01-01T00:00:00.000Z', partial: true }]);

      const entries = await cache.listUntrackedBufferCacheEntries();

      expect(entries).toHaveLength(1);
      expect(entries[0].size).toBe(3);
    });

    it('keeps the newest of two complete entries', async () => {
      write('aaaaaaaaaaa.ts', '123', 100);
      byteRange.listByteRangeCacheEntries.mockResolvedValue([{ youtubeId: 'aaaaaaaaaaa', size: 999, mtime: new Date().toISOString() }]);

      const entries = await cache.listUntrackedBufferCacheEntries();

      expect(entries[0].size).toBe(999);
    });
  });
});
