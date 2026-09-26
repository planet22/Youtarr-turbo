/* eslint-env jest */

jest.mock('../../logger');

const mockModel = {
  findByPk: jest.fn(),
  findAll: jest.fn(),
  upsert: jest.fn(),
  destroy: jest.fn(),
  count: jest.fn(),
};
jest.mock('../../models/youtubemetadatacache', () => mockModel);

let logger;

const DAY_MS = 24 * 60 * 60 * 1000;

describe('youtubeMetadataCache', () => {
  let cache;

  // Module-level Maps hold fps/height/duration, so reload for a clean slate
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockModel.upsert.mockResolvedValue(undefined);
    logger = require('../../logger');
    cache = require('../youtubeMetadataCache');
  });

  const row = (overrides = {}) => ({
    raw_info_json: JSON.stringify({ fps: 30, title: 'T', formats: [] }),
    duration_seconds: 120,
    fetched_at: new Date('2026-01-01T00:00:00Z'),
    last_accessed_at: new Date('2026-01-10T00:00:00Z'),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  it('exposes a one year retention', () => {
    expect(cache.YOUTUBE_METADATA_CACHE_RETENTION_DAYS).toBe(365);
  });

  describe('getCachedFps', () => {
    it('reads fps from the stored info blob', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({ fps: 29.97 }) }));

      await expect(cache.getCachedFps('vid')).resolves.toBe(29.97);
    });

    it('serves repeat lookups from memory', async () => {
      mockModel.findByPk.mockResolvedValue(row());
      await cache.getCachedFps('vid');

      await cache.getCachedFps('vid');

      expect(mockModel.findByPk).toHaveBeenCalledTimes(1);
    });

    it('returns null when there is no row', async () => {
      mockModel.findByPk.mockResolvedValue(null);

      await expect(cache.getCachedFps('vid')).resolves.toBeNull();
    });

    it('returns null when the row has no info blob', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: null }));

      await expect(cache.getCachedFps('vid')).resolves.toBeNull();
    });

    it.each([0, -5, 'abc', null])('returns null for an unusable fps of %p', async (fps) => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({ fps }) }));

      await expect(cache.getCachedFps('vid')).resolves.toBeNull();
    });

    it('does not memoize a missing fps', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({}) }));
      await cache.getCachedFps('vid');

      await cache.getCachedFps('vid');

      expect(mockModel.findByPk).toHaveBeenCalledTimes(2);
    });

    it('returns null and warns when the lookup throws', async () => {
      mockModel.findByPk.mockRejectedValue(new Error('db down'));

      await expect(cache.getCachedFps('vid')).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns null and warns when the blob is not valid JSON', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: '{oops' }));

      await expect(cache.getCachedFps('vid')).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getCachedMaxHeight', () => {
    const withFormats = (formats) => row({ raw_info_json: JSON.stringify({ formats }) });

    it('returns the tallest height among video formats', async () => {
      mockModel.findByPk.mockResolvedValue(withFormats([
        { vcodec: 'avc1', height: 720 },
        { vcodec: 'vp9', height: 1080 },
      ]));

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBe(1080);
    });

    it('ignores audio-only formats', async () => {
      mockModel.findByPk.mockResolvedValue(withFormats([
        { vcodec: 'none', height: 4320 },
        { vcodec: 'avc1', height: 480 },
      ]));

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBe(480);
    });

    it('ignores formats without a usable height', async () => {
      mockModel.findByPk.mockResolvedValue(withFormats([
        { vcodec: 'avc1', height: null },
        { vcodec: 'avc1', height: 'x' },
        null,
        { vcodec: 'avc1', height: 360 },
      ]));

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBe(360);
    });

    it('returns null when there are no video formats', async () => {
      mockModel.findByPk.mockResolvedValue(withFormats([]));

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBeNull();
    });

    it('returns null when the info has no formats key', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({}) }));

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBeNull();
    });

    it('returns null when there is no row', async () => {
      mockModel.findByPk.mockResolvedValue(null);

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBeNull();
    });

    it('serves repeat lookups from memory', async () => {
      mockModel.findByPk.mockResolvedValue(withFormats([{ vcodec: 'avc1', height: 720 }]));
      await cache.getCachedMaxHeight('vid');

      await cache.getCachedMaxHeight('vid');

      expect(mockModel.findByPk).toHaveBeenCalledTimes(1);
    });

    it('returns null and warns when the lookup throws', async () => {
      mockModel.findByPk.mockRejectedValue(new Error('db down'));

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getCachedDurationSeconds', () => {
    it('returns the stored duration', async () => {
      mockModel.findByPk.mockResolvedValue(row({ duration_seconds: 245 }));

      await expect(cache.getCachedDurationSeconds('vid')).resolves.toBe(245);
    });

    it('bumps last_accessed_at on a database hit', async () => {
      const found = row();
      mockModel.findByPk.mockResolvedValue(found);

      await cache.getCachedDurationSeconds('vid');

      expect(found.update).toHaveBeenCalledWith({ last_accessed_at: expect.any(Date) });
    });

    it('serves repeat lookups from memory without touching the database', async () => {
      mockModel.findByPk.mockResolvedValue(row());
      await cache.getCachedDurationSeconds('vid');

      await cache.getCachedDurationSeconds('vid');

      expect(mockModel.findByPk).toHaveBeenCalledTimes(1);
    });

    it('still returns the duration when the access-time bump fails', async () => {
      const found = row();
      found.update.mockRejectedValue(new Error('locked'));
      mockModel.findByPk.mockResolvedValue(found);

      await expect(cache.getCachedDurationSeconds('vid')).resolves.toBe(120);
      await new Promise((resolve) => setImmediate(resolve));
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns null when there is no row', async () => {
      mockModel.findByPk.mockResolvedValue(null);

      await expect(cache.getCachedDurationSeconds('vid')).resolves.toBeNull();
    });

    it.each([0, -1, 'abc'])('returns null for an unusable duration of %p', async (duration) => {
      mockModel.findByPk.mockResolvedValue(row({ duration_seconds: duration }));

      await expect(cache.getCachedDurationSeconds('vid')).resolves.toBeNull();
    });

    it('returns null and warns when the lookup throws', async () => {
      mockModel.findByPk.mockRejectedValue(new Error('db down'));

      await expect(cache.getCachedDurationSeconds('vid')).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('cacheRawInfoJson', () => {
    it('does nothing without an info object', () => {
      cache.cacheRawInfoJson('vid', 100, null);

      expect(mockModel.upsert).not.toHaveBeenCalled();
    });

    it('persists the duration, blob and timestamps', () => {
      const info = { fps: 25, formats: [] };

      cache.cacheRawInfoJson('vid', 99.6, info);

      expect(mockModel.upsert).toHaveBeenCalledWith({
        youtube_id: 'vid',
        duration_seconds: 100,
        raw_info_json: JSON.stringify(info),
        fetched_at: expect.any(Date),
        last_accessed_at: expect.any(Date),
      });
    });

    it.each([0, -5, 'abc', undefined])('skips persisting for an unusable duration of %p', (duration) => {
      cache.cacheRawInfoJson('vid', duration, { fps: 30 });

      expect(mockModel.upsert).not.toHaveBeenCalled();
    });

    it('warms the fps memory so a later read skips the database', async () => {
      cache.cacheRawInfoJson('vid', 100, { fps: 60 });

      await expect(cache.getCachedFps('vid')).resolves.toBe(60);
      expect(mockModel.findByPk).not.toHaveBeenCalled();
    });

    it('warms the max-height memory', async () => {
      cache.cacheRawInfoJson('vid', 100, { formats: [{ vcodec: 'avc1', height: 1440 }] });

      await expect(cache.getCachedMaxHeight('vid')).resolves.toBe(1440);
      expect(mockModel.findByPk).not.toHaveBeenCalled();
    });

    it('warms the duration memory', async () => {
      cache.cacheRawInfoJson('vid', 321, { fps: 30 });

      await expect(cache.getCachedDurationSeconds('vid')).resolves.toBe(321);
      expect(mockModel.findByPk).not.toHaveBeenCalled();
    });

    it('warms fps even when the duration is unusable', async () => {
      cache.cacheRawInfoJson('vid', 0, { fps: 24 });

      await expect(cache.getCachedFps('vid')).resolves.toBe(24);
    });

    it('does not throw and warns when persisting fails', async () => {
      mockModel.upsert.mockRejectedValue(new Error('db down'));

      cache.cacheRawInfoJson('vid', 100, { fps: 30 });
      await new Promise((resolve) => setImmediate(resolve));

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getCachedRawInfoJson', () => {
    it('returns the parsed blob with an ISO fetch time', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({ title: 'Hi' }) }));

      await expect(cache.getCachedRawInfoJson('vid')).resolves.toEqual({
        data: { title: 'Hi' },
        fetchedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('passes a non-Date fetch time through unchanged', async () => {
      mockModel.findByPk.mockResolvedValue(row({ fetched_at: '2026-02-02' }));

      expect((await cache.getCachedRawInfoJson('vid')).fetchedAt).toBe('2026-02-02');
    });

    it('returns null when there is no row or blob', async () => {
      mockModel.findByPk.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ raw_info_json: null }));

      expect(await cache.getCachedRawInfoJson('a')).toBeNull();
      expect(await cache.getCachedRawInfoJson('b')).toBeNull();
    });

    it('returns null and warns on a corrupt blob', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: '{bad' }));

      await expect(cache.getCachedRawInfoJson('vid')).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getOrFetchRawInfoJson', () => {
    it('returns the cached blob without fetching', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({ title: 'cached' }) }));
      const fetchFn = jest.fn();

      await expect(cache.getOrFetchRawInfoJson('vid', fetchFn)).resolves.toEqual({ title: 'cached' });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('fetches and persists on a cache miss', async () => {
      mockModel.findByPk.mockResolvedValue(null);
      const info = { title: 'fresh', duration: 200, fps: 30 };

      await expect(cache.getOrFetchRawInfoJson('vid', jest.fn().mockResolvedValue(info))).resolves.toBe(info);
      expect(mockModel.upsert).toHaveBeenCalledWith(expect.objectContaining({ youtube_id: 'vid', duration_seconds: 200 }));
    });

    it('shares one fetch between concurrent callers', async () => {
      mockModel.findByPk.mockResolvedValue(null);
      const fetchFn = jest.fn().mockResolvedValue({ duration: 10 });

      await Promise.all([cache.getOrFetchRawInfoJson('vid', fetchFn), cache.getOrFetchRawInfoJson('vid', fetchFn)]);

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('propagates a fetch failure and allows a later retry', async () => {
      mockModel.findByPk.mockResolvedValue(null);
      const fetchFn = jest.fn().mockRejectedValueOnce(new Error('yt-dlp failed')).mockResolvedValueOnce({ duration: 5 });

      await expect(cache.getOrFetchRawInfoJson('vid', fetchFn)).rejects.toThrow('yt-dlp failed');
      await expect(cache.getOrFetchRawInfoJson('vid', fetchFn)).resolves.toEqual({ duration: 5 });
    });
  });

  describe('deleteEntry', () => {
    it('destroys the database row and returns the count', async () => {
      mockModel.destroy.mockResolvedValue(1);

      await expect(cache.deleteEntry('vid')).resolves.toBe(1);
      expect(mockModel.destroy).toHaveBeenCalledWith({ where: { youtube_id: 'vid' } });
    });

    it('forgets the in-memory values so they are re-read', async () => {
      mockModel.destroy.mockResolvedValue(1);
      cache.cacheRawInfoJson('vid', 100, { fps: 30, formats: [{ vcodec: 'a', height: 720 }] });
      mockModel.findByPk.mockResolvedValue(null);

      await cache.deleteEntry('vid');

      expect(await cache.getCachedFps('vid')).toBeNull();
      expect(await cache.getCachedMaxHeight('vid')).toBeNull();
      expect(await cache.getCachedDurationSeconds('vid')).toBeNull();
    });
  });

  describe('countCached and clearAll', () => {
    it('counts rows', async () => {
      mockModel.count.mockResolvedValue(7);

      await expect(cache.countCached()).resolves.toBe(7);
    });

    it('truncates the table', async () => {
      mockModel.destroy.mockResolvedValue(undefined);

      await cache.clearAll();

      expect(mockModel.destroy).toHaveBeenCalledWith({ truncate: true });
    });

    it('clears the in-memory values', async () => {
      cache.cacheRawInfoJson('vid', 100, { fps: 30 });
      mockModel.destroy.mockResolvedValue(undefined);
      mockModel.findByPk.mockResolvedValue(null);

      await cache.clearAll();

      expect(await cache.getCachedFps('vid')).toBeNull();
    });
  });

  describe('getCachedTitles', () => {
    it.each([undefined, null, []])('returns an empty map for %p without querying', async (ids) => {
      await expect(cache.getCachedTitles(ids)).resolves.toEqual({});
      expect(mockModel.findAll).not.toHaveBeenCalled();
    });

    it('maps ids to their cached titles', async () => {
      mockModel.findAll.mockResolvedValue([
        { youtube_id: 'a', raw_info_json: JSON.stringify({ title: 'Title A' }) },
        { youtube_id: 'b', raw_info_json: JSON.stringify({ title: 'Title B' }) },
      ]);

      await expect(cache.getCachedTitles(['a', 'b'])).resolves.toEqual({ a: 'Title A', b: 'Title B' });
    });

    it('skips rows with no blob or no title', async () => {
      mockModel.findAll.mockResolvedValue([
        { youtube_id: 'a', raw_info_json: null },
        { youtube_id: 'b', raw_info_json: JSON.stringify({}) },
      ]);

      await expect(cache.getCachedTitles(['a', 'b'])).resolves.toEqual({});
    });

    it('skips a corrupt row but keeps the others', async () => {
      mockModel.findAll.mockResolvedValue([
        { youtube_id: 'a', raw_info_json: '{bad' },
        { youtube_id: 'b', raw_info_json: JSON.stringify({ title: 'OK' }) },
      ]);

      await expect(cache.getCachedTitles(['a', 'b'])).resolves.toEqual({ b: 'OK' });
    });

    it('returns an empty map and warns when the query fails', async () => {
      mockModel.findAll.mockRejectedValue(new Error('db down'));

      await expect(cache.getCachedTitles(['a'])).resolves.toEqual({});
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('getCacheDetail', () => {
    it('returns null when nothing is cached', async () => {
      mockModel.findByPk.mockResolvedValue(null);

      await expect(cache.getCacheDetail('vid')).resolves.toBeNull();
    });

    it('summarises the parsed blob', async () => {
      mockModel.findByPk.mockResolvedValue(row({
        raw_info_json: JSON.stringify({ title: 'T', uploader: 'U', width: 1920, height: 1080, fps: 30, upload_date: '20260101' }),
      }));

      const detail = await cache.getCacheDetail('vid');

      expect(detail).toMatchObject({
        durationSeconds: 120,
        title: 'T',
        uploader: 'U',
        resolution: '1920x1080',
        fps: 30,
        uploadDate: '20260101',
        hasRawInfoJson: true,
      });
    });

    it('falls back to the channel name when there is no uploader', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({ channel: 'Chan' }) }));

      expect((await cache.getCacheDetail('vid')).uploader).toBe('Chan');
    });

    it('computes the expiry from the last access plus the retention window', async () => {
      const lastAccessed = new Date('2026-01-10T00:00:00Z');
      mockModel.findByPk.mockResolvedValue(row({ last_accessed_at: lastAccessed }));

      const detail = await cache.getCacheDetail('vid');

      expect(detail.expiresAt).toBe(new Date(lastAccessed.getTime() + 365 * DAY_MS).toISOString());
    });

    it('has no expiry when the row was never accessed', async () => {
      mockModel.findByPk.mockResolvedValue(row({ last_accessed_at: null }));

      expect((await cache.getCacheDetail('vid')).expiresAt).toBeNull();
    });

    it('reports a duration-only row as having no info blob', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: null }));

      const detail = await cache.getCacheDetail('vid');

      expect(detail).toMatchObject({ hasRawInfoJson: false, title: null, uploader: null, resolution: null, fps: null, rawInfoJson: null });
    });

    it('tolerates a corrupt blob but still flags that one exists', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: '{bad' }));

      const detail = await cache.getCacheDetail('vid');

      expect(detail).toMatchObject({ hasRawInfoJson: true, rawInfoJson: null, title: null });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('reports no resolution when only one dimension is known', async () => {
      mockModel.findByPk.mockResolvedValue(row({ raw_info_json: JSON.stringify({ width: 1920 }) }));

      expect((await cache.getCacheDetail('vid')).resolution).toBeNull();
    });
  });
});
