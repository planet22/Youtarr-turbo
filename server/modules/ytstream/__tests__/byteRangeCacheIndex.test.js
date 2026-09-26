/* eslint-env jest */
jest.mock('../../../logger');

const fs = require('fs');
const path = require('path');

jest.mock('../paths', () => ({ YTSTREAM_CACHE_DIR: require('path').join(require('os').tmpdir(), 'byterange-index-test-fixed') }));

const paths = require('../paths');
const jobEventLog = require('../../jobEventLog');
const {
  PERSISTENT_CACHE_DIR,
  listByteRangeCacheEntries,
  deleteByteRangeCacheForVideo,
  getByteRangeCacheTotals,
  sweepExpiredByteRangeCache,
  clearByteRangeCache,
  removeOrphanPartials,
} = require('../byteRangeCacheIndex');

function writeEntry(hash, { youtubeId, complete = true, bytes = 100, withMeta = true } = {}) {
  fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, `${hash}.mp4`), Buffer.alloc(bytes));
  if (withMeta) {
    fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, `${hash}.json`), JSON.stringify({ youtubeId, complete }));
  }
}

describe('byteRangeCacheIndex', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(paths.YTSTREAM_CACHE_DIR, { recursive: true, force: true });
    fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(paths.YTSTREAM_CACHE_DIR, { recursive: true, force: true });
  });

  describe('mkv entries', () => {
    it('lists a .mkv entry with its youtubeId and size', async () => {
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'mkvhash.mkv'), Buffer.alloc(321));
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'mkvhash.json'), JSON.stringify({ youtubeId: 'vidmkv00001', complete: true }));
      const entries = await listByteRangeCacheEntries();
      expect(entries).toEqual([expect.objectContaining({ youtubeId: 'vidmkv00001', size: 321, partial: false })]);
    });

    it('counts a .mkv entry as one cached video in the totals', async () => {
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'mkvhash.mkv'), Buffer.alloc(100));
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'mkvhash.json'), JSON.stringify({ youtubeId: 'vidmkv00001' }));
      expect((await getByteRangeCacheTotals()).fileCount).toBe(1);
    });

    it('deletes a .mkv entry together with its sidecar', async () => {
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'mkvhash.mkv'), Buffer.alloc(100));
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'mkvhash.json'), JSON.stringify({ youtubeId: 'vidmkv00001' }));
      const result = await deleteByteRangeCacheForVideo('vidmkv00001');
      expect(result.deletedFiles).toBe(1);
    });
  });

  describe('listByteRangeCacheEntries', () => {
    it('reports a complete entry with its youtubeId and file size', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001', bytes: 250 });
      const entries = await listByteRangeCacheEntries();
      expect(entries).toEqual([expect.objectContaining({ youtubeId: 'vid00000001', size: 250, filePath: path.join(PERSISTENT_CACHE_DIR, 'aaa.mp4') })]);
    });

    it('flags a partial entry as partial', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001', complete: false });
      expect(await listByteRangeCacheEntries()).toEqual([expect.objectContaining({ youtubeId: 'vid00000001', partial: true })]);
    });

    it('flags a complete entry as not partial', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001', complete: true });
      expect((await listByteRangeCacheEntries())[0].partial).toBe(false);
    });

    it('skips an entry whose sidecar has no youtubeId (cannot be attributed to a video)', async () => {
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'aaa.mp4'), Buffer.alloc(10));
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'aaa.json'), JSON.stringify({ complete: true }));
      expect(await listByteRangeCacheEntries()).toEqual([]);
    });

    it('skips a sidecar whose data file is missing', async () => {
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'aaa.json'), JSON.stringify({ youtubeId: 'vid00000001', complete: true }));
      expect(await listByteRangeCacheEntries()).toEqual([]);
    });

    it('returns an empty list when the cache directory does not exist', async () => {
      fs.rmSync(PERSISTENT_CACHE_DIR, { recursive: true, force: true });
      expect(await listByteRangeCacheEntries()).toEqual([]);
    });
  });

  describe('deleteByteRangeCacheForVideo', () => {
    it('deletes the data file and sidecar of every entry for that video', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001' });
      writeEntry('bbb', { youtubeId: 'vid00000001', complete: false });
      const result = await deleteByteRangeCacheForVideo('vid00000001');
      expect(result.deletedFiles).toBe(2);
      expect(fs.readdirSync(PERSISTENT_CACHE_DIR)).toEqual([]);
    });

    it('leaves other videos\' entries alone', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001' });
      writeEntry('bbb', { youtubeId: 'vid00000002' });
      await deleteByteRangeCacheForVideo('vid00000001');
      expect(fs.readdirSync(PERSISTENT_CACHE_DIR).sort()).toEqual(['bbb.json', 'bbb.mp4']);
    });

    it('reports the bytes freed', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001', bytes: 500 });
      const result = await deleteByteRangeCacheForVideo('vid00000001');
      expect(result.freedBytes).toBeGreaterThanOrEqual(500);
    });

    it('records one cache deletion for the video', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001', bytes: 500 });
      await deleteByteRangeCacheForVideo('vid00000001');
      expect(jobEventLog.record).toHaveBeenCalledWith('cache.deleted', {
        youtubeId: 'vid00000001',
        detail: expect.objectContaining({ reason: 'playback cache deleted for the video' }),
      });
    });

    it('records nothing when the video has no cache entries', async () => {
      await deleteByteRangeCacheForVideo('vid00000001');
      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('is a no-op when the cache directory does not exist', async () => {
      fs.rmSync(PERSISTENT_CACHE_DIR, { recursive: true, force: true });
      expect(await deleteByteRangeCacheForVideo('vid00000001')).toEqual({ deletedFiles: 0, freedBytes: 0 });
    });
  });

  describe('getByteRangeCacheTotals', () => {
    it('counts cached videos, not their sidecar files', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001' });
      writeEntry('bbb', { youtubeId: 'vid00000002' });
      expect((await getByteRangeCacheTotals()).fileCount).toBe(2);
    });

    it('counts a partial cache entry toward the total like a complete one', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001', complete: false });
      expect((await getByteRangeCacheTotals()).fileCount).toBe(1);
    });

    it('does not count an in-progress encode file as a cached video', async () => {
      fs.writeFileSync(path.join(PERSISTENT_CACHE_DIR, 'aaa.partial-1234abcd.mp4'), Buffer.alloc(50));
      expect((await getByteRangeCacheTotals()).fileCount).toBe(0);
    });

    it('sums every byte in the directory', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001', bytes: 1000 });
      expect((await getByteRangeCacheTotals()).totalBytes).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('sweepExpiredByteRangeCache', () => {
    it('deletes only files older than the cutoff', async () => {
      writeEntry('old', { youtubeId: 'vid00000001' });
      writeEntry('new', { youtubeId: 'vid00000002' });
      const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path.join(PERSISTENT_CACHE_DIR, 'old.mp4'), past, past);
      fs.utimesSync(path.join(PERSISTENT_CACHE_DIR, 'old.json'), past, past);
      const result = await sweepExpiredByteRangeCache(Date.now() - 24 * 60 * 60 * 1000);
      expect(result.deleted).toBe(1);
      expect(fs.readdirSync(PERSISTENT_CACHE_DIR).sort()).toEqual(['new.json', 'new.mp4']);
    });
  });

  describe('sweep and clear events', () => {
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const age = (hash) => {
      fs.utimesSync(path.join(PERSISTENT_CACHE_DIR, `${hash}.mp4`), past, past);
      fs.utimesSync(path.join(PERSISTENT_CACHE_DIR, `${hash}.json`), past, past);
    };

    it('records each expired entry against its video, even though its sidecar is deleted first', async () => {
      writeEntry('old', { youtubeId: 'vid00000001', bytes: 300 });
      age('old');
      await sweepExpiredByteRangeCache(Date.now() - 24 * 60 * 60 * 1000);
      expect(jobEventLog.record).toHaveBeenCalledWith('cache.deleted', {
        youtubeId: 'vid00000001',
        detail: { filePath: path.join(PERSISTENT_CACHE_DIR, 'old.mp4'), freedBytes: 300, reason: 'expired playback cache' },
      });
    });

    it('records one event per entry, not one per file', async () => {
      writeEntry('old', { youtubeId: 'vid00000001' });
      age('old');
      await sweepExpiredByteRangeCache(Date.now() - 24 * 60 * 60 * 1000);
      expect(jobEventLog.record).toHaveBeenCalledTimes(1);
    });

    it('does not record entries it left alone', async () => {
      writeEntry('new', { youtubeId: 'vid00000002' });
      await sweepExpiredByteRangeCache(Date.now() - 24 * 60 * 60 * 1000);
      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('says the cache was cleared when everything is cleared', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001' });
      await clearByteRangeCache();
      expect(jobEventLog.record).toHaveBeenCalledWith('cache.deleted', {
        youtubeId: 'vid00000001',
        detail: expect.objectContaining({ reason: 'playback cache cleared' }),
      });
    });

    it('still records an entry whose sidecar is missing, without a video', async () => {
      writeEntry('orphan', { withMeta: false });
      fs.utimesSync(path.join(PERSISTENT_CACHE_DIR, 'orphan.mp4'), past, past);
      await sweepExpiredByteRangeCache(Date.now() - 24 * 60 * 60 * 1000);
      expect(jobEventLog.record).toHaveBeenCalledWith('cache.deleted', expect.objectContaining({ youtubeId: undefined }));
    });
  });

  describe('in-progress encode files', () => {
    const livePartial = () => path.join(PERSISTENT_CACHE_DIR, 'aaa.partial-1234abcd.mp4');

    it('are spared by a bulk clear while recently written (a live session owns them)', async () => {
      fs.writeFileSync(livePartial(), Buffer.alloc(50));
      await clearByteRangeCache();
      expect(fs.existsSync(livePartial())).toBe(true);
    });

    it('are removed by a bulk clear once stale', async () => {
      fs.writeFileSync(livePartial(), Buffer.alloc(50));
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(livePartial(), old, old);
      await clearByteRangeCache();
      expect(fs.existsSync(livePartial())).toBe(false);
    });

    it('are spared by a per-video delete while recently written', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001' });
      fs.writeFileSync(livePartial(), Buffer.alloc(50));
      await deleteByteRangeCacheForVideo('vid00000001');
      expect(fs.existsSync(livePartial())).toBe(true);
    });

    it('left by a previous process are removed, except the path being kept', async () => {
      const keep = path.join(PERSISTENT_CACHE_DIR, 'bbb.partial-9999abcd.mp4');
      fs.writeFileSync(livePartial(), Buffer.alloc(50));
      fs.writeFileSync(keep, Buffer.alloc(50));
      await removeOrphanPartials([keep]);
      expect(fs.readdirSync(PERSISTENT_CACHE_DIR)).toEqual(['bbb.partial-9999abcd.mp4']);
    });

    it('do not disturb finished entries during orphan cleanup', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001' });
      await removeOrphanPartials([]);
      expect(fs.readdirSync(PERSISTENT_CACHE_DIR).sort()).toEqual(['aaa.json', 'aaa.mp4']);
    });
  });

  describe('clearByteRangeCache', () => {
    it('removes every entry', async () => {
      writeEntry('aaa', { youtubeId: 'vid00000001' });
      writeEntry('bbb', { youtubeId: 'vid00000002', complete: false });
      const result = await clearByteRangeCache();
      expect(result.deletedFiles).toBe(2);
      expect(fs.readdirSync(PERSISTENT_CACHE_DIR)).toEqual([]);
    });
  });
});
