describe('nzbThumbnailProbe', () => {
  let probe;
  let axios;
  let ytDlpRunner;
  let youtubeMetadataCache;
  let NzbResolutionCache;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.mock('axios', () => ({ get: jest.fn() }));
    jest.mock('../../logger', () => ({
      info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn(),
    }));
    jest.mock('../ytDlpRunner', () => ({ fetchMetadata: jest.fn() }));
    jest.mock('../youtubeMetadataCache', () => ({ getCachedMaxHeight: jest.fn().mockResolvedValue(null) }));
    jest.mock('../../models', () => ({
      NzbResolutionCache: { findByPk: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue(undefined) },
    }));
    axios = require('axios');
    ytDlpRunner = require('../ytDlpRunner');
    youtubeMetadataCache = require('../youtubeMetadataCache');
    ({ NzbResolutionCache } = require('../../models'));
    // nzbFeedModule is real (pure tier-snapping logic, only depends on the
    // already-mocked logger) - simpler and more realistic than re-mocking
    // its snapping rules here.
    probe = require('../nzbThumbnailProbe');
  });

  const smallResponse = (bytes) => ({
    status: 200,
    headers: { 'content-length': String(bytes) },
    data: Buffer.alloc(bytes),
  });

  describe('probeDefinition', () => {
    test('returns "hd" when the maxresdefault thumbnail is a real, large image', async () => {
      axios.get.mockResolvedValueOnce(smallResponse(45000));
      await expect(probe.probeDefinition('abc123')).resolves.toBe('hd');
      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/vi/abc123/maxresdefault.jpg'),
        expect.objectContaining({ responseType: 'arraybuffer' })
      );
    });

    test('returns "sd" when the response is the small gray placeholder image', async () => {
      axios.get.mockResolvedValueOnce(smallResponse(1200));
      await expect(probe.probeDefinition('abc123')).resolves.toBe('sd');
    });

    test('falls back to the response body length when content-length header is missing', async () => {
      axios.get.mockResolvedValueOnce({ status: 200, headers: {}, data: Buffer.alloc(1200) });
      await expect(probe.probeDefinition('abc123')).resolves.toBe('sd');
    });

    test('returns null (unknown) on a non-200 status, never treating it as sd', async () => {
      axios.get.mockResolvedValueOnce({ status: 503, headers: {}, data: Buffer.alloc(0) });
      await expect(probe.probeDefinition('abc123')).resolves.toBeNull();
    });

    test('returns null (unknown) when the request throws', async () => {
      axios.get.mockRejectedValueOnce(new Error('timeout'));
      await expect(probe.probeDefinition('abc123')).resolves.toBeNull();
    });
  });

  describe('probeViaExtraction', () => {
    test('returns hd + exact tier for a video whose best format is HD', async () => {
      ytDlpRunner.fetchMetadata.mockResolvedValueOnce({
        formats: [
          { vcodec: 'avc1', height: 480 },
          { vcodec: 'avc1', height: 1080 },
          { vcodec: 'none', height: 4320 }, // audio-only - must be ignored
        ],
      });
      await expect(probe.probeViaExtraction('abc123')).resolves.toEqual({ definition: 'hd', heightTier: 1080 });
    });

    test('returns sd + snapped tier for a genuinely low-resolution video', async () => {
      ytDlpRunner.fetchMetadata.mockResolvedValueOnce({
        formats: [{ vcodec: 'avc1', height: 288 }],
      });
      const result = await probe.probeViaExtraction('abc123');
      expect(result.definition).toBe('sd');
      expect(result.heightTier).toBeLessThan(720);
    });

    test('returns null when there are no usable video formats', async () => {
      ytDlpRunner.fetchMetadata.mockResolvedValueOnce({ formats: [{ vcodec: 'none', height: 1080 }] });
      await expect(probe.probeViaExtraction('abc123')).resolves.toBeNull();
    });

    test('returns null when the extraction itself throws', async () => {
      ytDlpRunner.fetchMetadata.mockRejectedValueOnce(new Error('yt-dlp failed'));
      await expect(probe.probeViaExtraction('abc123')).resolves.toBeNull();
    });
  });

  describe('fillUnknownDefinitions', () => {
    test('leaves results with an already-known definition untouched and probes nothing for them', async () => {
      const results = [{ youtubeId: 'a', definition: 'hd' }, { youtubeId: 'b', definition: 'sd' }];
      await probe.fillUnknownDefinitions(results);
      expect(axios.get).not.toHaveBeenCalled();
      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
    });

    test('skips results with no youtubeId', async () => {
      const results = [{ title: 'no id here', definition: null }];
      await probe.fillUnknownDefinitions(results);
      expect(axios.get).not.toHaveBeenCalled();
    });

    test('uses a real yt-dlp extraction already on file in the shared library metadata cache, without probing at all', async () => {
      youtubeMetadataCache.getCachedMaxHeight.mockResolvedValueOnce(1080);
      const results = [{ youtubeId: 'downloadedBefore', definition: null }];
      await probe.fillUnknownDefinitions(results);

      expect(results[0].definition).toBe('hd');
      expect(results[0].actualHeightTier).toBe(1080);
      expect(results[0].resolutionSource).toBe('metadataCache');
      expect(axios.get).not.toHaveBeenCalled();
      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
      expect(NzbResolutionCache.upsert).not.toHaveBeenCalled();
    });

    test('a low max height from the shared library metadata cache is reported as sd', async () => {
      youtubeMetadataCache.getCachedMaxHeight.mockResolvedValueOnce(480);
      const results = [{ youtubeId: 'downloadedBefore', definition: null }];
      await probe.fillUnknownDefinitions(results);
      expect(results[0].definition).toBe('sd');
      expect(results[0].resolutionSource).toBe('metadataCache');
    });

    test('checks the shared library metadata cache even when both useThumb and useExtract are off', async () => {
      youtubeMetadataCache.getCachedMaxHeight.mockResolvedValueOnce(1080);
      const results = [{ youtubeId: 'downloadedBefore', definition: null }];
      await probe.fillUnknownDefinitions(results, { useThumb: false, useExtract: false });
      expect(results[0].definition).toBe('hd');
      expect(results[0].resolutionSource).toBe('metadataCache');
    });

    test('does nothing when both useThumb and useExtract are off and nothing is in the library metadata cache', async () => {
      const results = [{ youtubeId: 'unknown1', definition: null }];
      await probe.fillUnknownDefinitions(results, { useThumb: false, useExtract: false });
      expect(axios.get).not.toHaveBeenCalled();
      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
      expect(results[0].definition).toBeNull();
    });

    test('a confident "sd" thumbnail result is trusted without running the real extraction', async () => {
      axios.get.mockResolvedValueOnce(smallResponse(1000));
      const results = [{ youtubeId: 'unknown1', definition: null }];
      await probe.fillUnknownDefinitions(results);
      expect(results[0].definition).toBe('sd');
      expect(results[0].resolutionSource).toBe('thumb');
      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
    });

    test('a thumbnail "hd" result is confirmed/corrected via real extraction by default', async () => {
      axios.get.mockResolvedValueOnce(smallResponse(45000)); // thumb says hd
      ytDlpRunner.fetchMetadata.mockResolvedValueOnce({ formats: [{ vcodec: 'avc1', height: 288 }] }); // actually not hd
      const results = [{ youtubeId: 'unknown1', definition: null }];
      await probe.fillUnknownDefinitions(results);
      expect(results[0].definition).toBe('sd');
      expect(results[0].resolutionSource).toBe('extract');
    });

    test('useThumb: false skips the thumbnail probe and goes straight to extraction', async () => {
      ytDlpRunner.fetchMetadata.mockResolvedValueOnce({ formats: [{ vcodec: 'avc1', height: 1080 }] });
      const results = [{ youtubeId: 'unknown1', definition: null }];
      await probe.fillUnknownDefinitions(results, { useThumb: false, useExtract: true });
      expect(axios.get).not.toHaveBeenCalled();
      expect(results[0].definition).toBe('hd');
      expect(results[0].resolutionSource).toBe('extract');
    });

    test('useExtract: false keeps an unconfirmed thumbnail "hd" answer as-is', async () => {
      axios.get.mockResolvedValueOnce(smallResponse(45000));
      const results = [{ youtubeId: 'unknown1', definition: null }];
      await probe.fillUnknownDefinitions(results, { useThumb: true, useExtract: false });
      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
      expect(results[0].definition).toBe('hd');
      expect(results[0].resolutionSource).toBe('thumb');
    });

    test('falls back to a failed/off thumbnail result (null) when extraction also fails', async () => {
      axios.get.mockRejectedValueOnce(new Error('timeout'));
      ytDlpRunner.fetchMetadata.mockRejectedValueOnce(new Error('yt-dlp failed'));
      const results = [{ youtubeId: 'unknown1', definition: null }];
      await probe.fillUnknownDefinitions(results);
      expect(results[0].definition).toBeNull();
    });

    test('a confirmed extraction result is persisted to the nzb resolution cache table, not the shared library metadata cache', async () => {
      axios.get.mockResolvedValueOnce(smallResponse(45000));
      ytDlpRunner.fetchMetadata.mockResolvedValueOnce({ formats: [{ vcodec: 'avc1', height: 1080 }] });
      const results = [{ youtubeId: 'sameVideo', definition: null }];
      await probe.fillUnknownDefinitions(results);

      expect(NzbResolutionCache.upsert).toHaveBeenCalledWith(expect.objectContaining({
        youtube_id: 'sameVideo', definition: 'hd', height_tier: 1080, source: 'extract',
      }));
    });

    test('a second search for the same video reads the persisted cache row and skips both probes', async () => {
      NzbResolutionCache.findByPk.mockResolvedValueOnce({ definition: 'hd', height_tier: 1080, source: 'extract' });
      const results = [{ youtubeId: 'sameVideo', definition: null }];
      await probe.fillUnknownDefinitions(results);

      expect(axios.get).not.toHaveBeenCalled();
      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
      expect(results[0].definition).toBe('hd');
      expect(results[0].actualHeightTier).toBe(1080);
      expect(results[0].resolutionSource).toBe('extract');
    });

    test('returns how many items needed a resolution lookup, for the NZB diagnostics page\'s query count', async () => {
      const results = [
        { youtubeId: 'a', definition: 'hd' }, // already settled, not counted
        { youtubeId: 'b', definition: null },
        { youtubeId: 'c', definition: null },
      ];
      await expect(probe.fillUnknownDefinitions(results, { useThumb: false, useExtract: false })).resolves.toBe(2);
    });

    test('does not cache an unconfirmed "hd" (thumbnail-only) result - a later search retries it', async () => {
      axios.get.mockResolvedValue(smallResponse(45000));
      const firstPass = [{ youtubeId: 'sameVideo', definition: null }];
      await probe.fillUnknownDefinitions(firstPass, { useExtract: false });
      expect(NzbResolutionCache.upsert).not.toHaveBeenCalled();

      const secondPass = [{ youtubeId: 'sameVideo', definition: null }];
      await probe.fillUnknownDefinitions(secondPass, { useExtract: false });

      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });
});
