/* eslint-env jest */

describe('ytstream playbackPlan', () => {
  let playbackPlan;
  let logger;
  let ytDlpRunner;
  let metadataCache;
  let processRegistry;
  let probeShortcut;

  const YT_ID = 'dQw4w9WgXcQ';

  beforeEach(() => {
    jest.resetModules();

    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    ytDlpRunner = { fetchMetadata: jest.fn(), run: jest.fn() };
    metadataCache = {
      getOrFetchRawInfoJson: jest.fn((id, fetchFn) => fetchFn()),
      getCachedDurationSeconds: jest.fn().mockResolvedValue(null),
      getCachedMaxHeight: jest.fn().mockResolvedValue(null),
    };
    processRegistry = { isFfmpegAvailable: jest.fn().mockReturnValue(true) };
    probeShortcut = { evaluateProbeShortcut: jest.fn().mockReturnValue({ wouldFire: false, reason: 'no probe match' }) };

    jest.doMock('../../../logger', () => logger);
    jest.doMock('../../ytDlpRunner', () => ytDlpRunner);
    jest.doMock('../../youtubeMetadataCache', () => metadataCache);
    jest.doMock('../../streamEncoderTuning', () => ({ normalizeHardwareMode: (v) => v, normalizeTuning: (v) => v }));
    jest.doMock('../ytdlpArgs', () => ({ buildBaseArgs: jest.fn((config, opts) => ['--base', `client=${opts.playerClient || ''}`]) }));
    jest.doMock('../processRegistry', () => processRegistry);
    jest.doMock('../probeShortcut', () => probeShortcut);
    jest.doMock('../streamDebug', () => ({ streamDebug: jest.fn() }));

    playbackPlan = require('../playbackPlan');
  });

  describe('getVideoInfo', () => {
    it('returns what the metadata cache resolves', async () => {
      metadataCache.getOrFetchRawInfoJson.mockResolvedValue({ duration: 10 });

      await expect(playbackPlan.getVideoInfo(YT_ID, {})).resolves.toEqual({ duration: 10 });
    });

    it('fetches live metadata on a cache miss using the default player client', async () => {
      ytDlpRunner.fetchMetadata.mockResolvedValue({ id: YT_ID });

      await playbackPlan.getVideoInfo(YT_ID, {});

      expect(ytDlpRunner.fetchMetadata).toHaveBeenCalledWith(`https://youtube.com/watch?v=${YT_ID}`, 30000, { extractorArgs: 'youtube:player_client=default,-tv' });
    });

    it('prefers the configured player client over the default', async () => {
      await playbackPlan.getVideoInfo(YT_ID, { ytstream: { playerClient: 'web' } });

      expect(ytDlpRunner.fetchMetadata.mock.calls[0][2]).toEqual({ extractorArgs: 'youtube:player_client=web' });
    });

    it('prefers an explicit player client over the configured one', async () => {
      await playbackPlan.getVideoInfo(YT_ID, { ytstream: { playerClient: 'web' } }, 'android');

      expect(ytDlpRunner.fetchMetadata.mock.calls[0][2]).toEqual({ extractorArgs: 'youtube:player_client=android' });
    });

    it('does not fetch live when the cache supplies the info', async () => {
      metadataCache.getOrFetchRawInfoJson.mockResolvedValue({ duration: 5 });

      await playbackPlan.getVideoInfo(YT_ID, {});

      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
    });

    it('propagates a failed live extraction', async () => {
      ytDlpRunner.fetchMetadata.mockRejectedValue(new Error('extract failed'));

      await expect(playbackPlan.getVideoInfo(YT_ID, {})).rejects.toThrow('extract failed');
    });
  });

  describe('getVideoDurationSeconds', () => {
    let Video;

    beforeEach(() => {
      Video = { findOne: jest.fn().mockResolvedValue(null) };
      playbackPlan.init({ models: { Video } });
    });

    it('uses the duration recorded for a downloaded video', async () => {
      Video.findOne.mockResolvedValue({ duration: '125' });

      await expect(playbackPlan.getVideoDurationSeconds(YT_ID, {})).resolves.toBe(125);
    });

    it('looks the video up by YouTube id', async () => {
      Video.findOne.mockResolvedValue({ duration: 60 });

      await playbackPlan.getVideoDurationSeconds(YT_ID, {});

      expect(Video.findOne).toHaveBeenCalledWith({ where: { youtubeId: YT_ID }, attributes: ['duration'] });
    });

    it.each([['zero', 0], ['negative', -3], ['not a number', 'abc'], ['null', null]])('falls through to the metadata cache when the recorded duration is %s', async (_label, duration) => {
      Video.findOne.mockResolvedValue({ duration });
      metadataCache.getCachedDurationSeconds.mockResolvedValue(77);

      await expect(playbackPlan.getVideoDurationSeconds(YT_ID, {})).resolves.toBe(77);
    });

    it('falls through to the metadata cache when there is no video row', async () => {
      metadataCache.getCachedDurationSeconds.mockResolvedValue(88);

      await expect(playbackPlan.getVideoDurationSeconds(YT_ID, {})).resolves.toBe(88);
    });

    it('warns and falls through when the database lookup fails', async () => {
      Video.findOne.mockRejectedValue(new Error('db down'));
      metadataCache.getCachedDurationSeconds.mockResolvedValue(99);

      const seconds = await playbackPlan.getVideoDurationSeconds(YT_ID, {});

      expect(seconds).toBe(99);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), expect.stringContaining('DB duration lookup failed'));
    });

    it('skips the database when no models were injected', async () => {
      jest.resetModules();
      const fresh = require('../playbackPlan');
      metadataCache.getCachedDurationSeconds.mockResolvedValue(42);

      await expect(fresh.getVideoDurationSeconds(YT_ID, {})).resolves.toBe(42);
    });

    it('skips the database when the models have no Video', async () => {
      playbackPlan.init({ models: {} });
      metadataCache.getCachedDurationSeconds.mockResolvedValue(43);

      await expect(playbackPlan.getVideoDurationSeconds(YT_ID, {})).resolves.toBe(43);
    });

    it('falls back to live video info when nothing is cached', async () => {
      metadataCache.getOrFetchRawInfoJson.mockResolvedValue({ duration: '300' });

      await expect(playbackPlan.getVideoDurationSeconds(YT_ID, {})).resolves.toBe(300);
    });

    it.each([['missing', {}], ['zero', { duration: 0 }], ['not numeric', { duration: 'x' }]])('throws when the live duration is %s', async (_label, info) => {
      metadataCache.getOrFetchRawInfoJson.mockResolvedValue(info);

      await expect(playbackPlan.getVideoDurationSeconds(YT_ID, {})).rejects.toThrow('Could not determine video duration for calculatedLength');
    });
  });

  describe('resolveVideoCodec', () => {
    it('returns the first line of the probe output', async () => {
      ytDlpRunner.run.mockResolvedValue('avc1.640028\nsecond line\n');

      await expect(playbackPlan.resolveVideoCodec(YT_ID, '720', {})).resolves.toBe('avc1.640028');
    });

    it('handles CRLF output', async () => {
      ytDlpRunner.run.mockResolvedValue('vp9\r\nrest');

      await expect(playbackPlan.resolveVideoCodec(YT_ID, '720', {})).resolves.toBe('vp9');
    });

    it('returns an empty string for empty output', async () => {
      ytDlpRunner.run.mockResolvedValue('   ');

      await expect(playbackPlan.resolveVideoCodec(YT_ID, '720', {})).resolves.toBe('');
    });

    it('probes with the same format selector the stream will use', async () => {
      ytDlpRunner.run.mockResolvedValue('avc1');

      await playbackPlan.resolveVideoCodec(YT_ID, '1080', {}, 'web', 'fixed');

      expect(ytDlpRunner.run).toHaveBeenCalledWith(
        ['--base', 'client=web', '-f', 'bv*[height=1080][vcodec^=avc1]/bv*[height=1080]', '--print', '%(vcodec)s', '--skip-download', '--no-playlist', '--no-warnings', `https://youtube.com/watch?v=${YT_ID}`],
        { timeoutMs: 30000 }
      );
    });

    it('caches the result for the same video, quality, client and strictness', async () => {
      ytDlpRunner.run.mockResolvedValue('avc1');

      await playbackPlan.resolveVideoCodec(YT_ID, '720', {}, 'web', 'fallback');
      await playbackPlan.resolveVideoCodec(YT_ID, '720', {}, 'web', 'fallback');

      expect(ytDlpRunner.run).toHaveBeenCalledTimes(1);
    });

    it('treats a missing strictness as fallback for caching', async () => {
      ytDlpRunner.run.mockResolvedValue('avc1');

      await playbackPlan.resolveVideoCodec(YT_ID, '720', {}, 'web');
      await playbackPlan.resolveVideoCodec(YT_ID, '720', {}, 'web', 'fallback');

      expect(ytDlpRunner.run).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['quality', ['1080', 'web', 'fallback']],
      ['player client', ['720', 'android', 'fallback']],
      ['strictness', ['720', 'web', 'fixed']],
    ])('probes again when the %s differs', async (_label, [quality, client, strictness]) => {
      ytDlpRunner.run.mockResolvedValue('avc1');

      await playbackPlan.resolveVideoCodec(YT_ID, '720', {}, 'web', 'fallback');
      await playbackPlan.resolveVideoCodec(YT_ID, quality, {}, client, strictness);

      expect(ytDlpRunner.run).toHaveBeenCalledTimes(2);
    });

    it('does not cache a failed probe', async () => {
      ytDlpRunner.run.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce('avc1');

      await expect(playbackPlan.resolveVideoCodec(YT_ID, '720', {})).rejects.toThrow('timeout');

      await expect(playbackPlan.resolveVideoCodec(YT_ID, '720', {})).resolves.toBe('avc1');
    });
  });

  describe('best-available height', () => {
    it('peeks at the cached height without fetching', async () => {
      metadataCache.getCachedMaxHeight.mockResolvedValue(1080);

      await expect(playbackPlan.peekCachedMaxHeight(YT_ID)).resolves.toBe(1080);
      expect(ytDlpRunner.fetchMetadata).not.toHaveBeenCalled();
    });

    it('returns the cached max height without any live extraction', async () => {
      metadataCache.getCachedMaxHeight.mockResolvedValue(720);

      await expect(playbackPlan.resolveMaxAvailableHeight(YT_ID, {})).resolves.toBe(720);
      expect(metadataCache.getOrFetchRawInfoJson).not.toHaveBeenCalled();
    });

    it('extracts live and rereads the cache on a miss', async () => {
      metadataCache.getCachedMaxHeight.mockResolvedValueOnce(null).mockResolvedValueOnce(1440);

      await expect(playbackPlan.resolveMaxAvailableHeight(YT_ID, {}, 'web')).resolves.toBe(1440);
      expect(ytDlpRunner.fetchMetadata.mock.calls[0][2]).toEqual({ extractorArgs: 'youtube:player_client=web' });
    });

    it('returns null and warns when the live extraction fails', async () => {
      ytDlpRunner.fetchMetadata.mockRejectedValue(new Error('blocked'));

      await expect(playbackPlan.resolveMaxAvailableHeight(YT_ID, {})).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), expect.stringContaining('failed to resolve best-available height'));
    });

    it('leaves "best" uncapped without looking anything up', async () => {
      await expect(playbackPlan.resolveEffectiveQualityHeight(YT_ID, 'best', {})).resolves.toBeNull();
      expect(metadataCache.getCachedMaxHeight).not.toHaveBeenCalled();
    });

    it('caps the requested height to what the video offers', async () => {
      metadataCache.getCachedMaxHeight.mockResolvedValue(480);

      await expect(playbackPlan.resolveEffectiveQualityHeight(YT_ID, '1080', {})).resolves.toBe(480);
    });

    it('keeps the requested height when the video offers more', async () => {
      metadataCache.getCachedMaxHeight.mockResolvedValue(2160);

      await expect(playbackPlan.resolveEffectiveQualityHeight(YT_ID, '720', {})).resolves.toBe(720);
    });

    it('keeps the requested height when the best-available height is unknown', async () => {
      ytDlpRunner.fetchMetadata.mockRejectedValue(new Error('blocked'));

      await expect(playbackPlan.resolveEffectiveQualityHeight(YT_ID, '1080', {})).resolves.toBe(1080);
    });
  });

  describe('resolvePlaybackPlan', () => {
    const plan = (query = {}, config = {}, opts = {}) => playbackPlan.resolvePlaybackPlan(YT_ID, { query }, config, { probe: false, ...opts });
    const stepsNamed = (result, name) => result.steps.filter((s) => s.step === name);
    const detailOf = (result, name) => (stepsNamed(result, name)[0] || {}).detail;

    describe('defaults', () => {
      it('resolves direct mode, mp4, copy, no hardware, fast tuning', async () => {
        const result = await plan();

        expect(result).toMatchObject({ mode: 'direct', requestedMode: 'direct', container: 'mp4', transcode: 'copy', hardwareMode: 'none', tuning: 'fast' });
      });

      it('takes quality from the preferred resolution, then 720', async () => {
        expect((await plan({}, { preferredResolution: '1080' })).quality).toBe('1080');
        expect((await plan()).quality).toBe('720');
      });

      it('prefers the ytstream quality over the preferred resolution', async () => {
        expect((await plan({}, { preferredResolution: '1080', ytstream: { quality: '480' } })).quality).toBe('480');
      });

      it('has no seek position without a t param', async () => {
        expect((await plan()).seekSeconds).toBeNull();
      });

      it('reads the seek position from t', async () => {
        expect((await plan({ t: '90' })).seekSeconds).toBe(90);
      });

      it('starts with the probe shortcut step', async () => {
        const result = await plan();

        expect(result.steps[0]).toEqual({ step: 'probeShortcut', detail: 'no probe match', probed: false });
      });

      it('returns the probe shortcut evaluation', async () => {
        const result = await plan();

        expect(result.probeShortcut).toEqual({ wouldFire: false, reason: 'no probe match' });
      });
    });

    describe('query overrides and forceServerSettings', () => {
      it('honors query overrides by default', async () => {
        const result = await plan({ mode: 'hls-buffer', container: 'ts', transcode: 'h264', hardware: 'nvenc', tuning: 'slow', quality: '480' }, { ytstream: { defaultMode: 'direct' } });

        expect(result).toMatchObject({ mode: 'hls-buffer', container: 'ts', transcode: 'h264', hardwareMode: 'nvenc', tuning: 'slow', requestedQuality: '480' });
      });

      it('reports that overrides are honored', async () => {
        expect(detailOf(await plan(), 'forceServerSettings')).toBe('off - query-string overrides are honored');
      });

      it('ignores query overrides when server settings are forced', async () => {
        const result = await plan({ mode: 'hls', quality: '480' }, { ytstream: { forceServerSettings: true, defaultMode: 'direct', quality: '1080' } });

        expect(result).toMatchObject({ mode: 'direct', requestedQuality: '1080', forceServerSettings: true });
      });

      it('lists only the query params that were actually sent', async () => {
        const result = await plan({ mode: 'hls', quality: '480', unrelated: 'x' }, { ytstream: { forceServerSettings: true } });

        expect(result.ignoredQueryParams).toEqual(['mode', 'quality']);
      });

      it('explains which query params are being ignored', async () => {
        const result = await plan({ mode: 'hls' }, { ytstream: { forceServerSettings: true } });

        expect(detailOf(result, 'forceServerSettings')).toContain('ignoring query params present on this request: mode');
      });

      it('says so when no query params were sent', async () => {
        const result = await plan({}, { ytstream: { forceServerSettings: true } });

        expect(detailOf(result, 'forceServerSettings')).toContain('(none present on this request)');
      });

      it('has no ignored params when not forced', async () => {
        expect((await plan({ mode: 'hls' })).ignoredQueryParams).toEqual([]);
      });
    });

    describe('mode resolution', () => {
      it('lower-cases the requested mode', async () => {
        expect((await plan({ mode: 'HLS-Buffer' })).mode).toBe('hls-buffer');
      });

      it('falls back to the configured default for an unknown mode', async () => {
        const result = await plan({ mode: 'ffmpeg' }, { ytstream: { defaultMode: 'hls-buffer' } });

        expect(result).toMatchObject({ mode: 'hls-buffer', requestedMode: 'ffmpeg' });
        expect(stepsNamed(result, 'mode')[0].detail).toContain('using the current configured default mode "hls-buffer"');
      });

      it('falls back to direct when the configured default is also invalid', async () => {
        const result = await plan({ mode: 'ffmpeg' }, { ytstream: { defaultMode: 'direct-pipe' } });

        expect(result.mode).toBe('direct');
        expect(stepsNamed(result, 'mode')[0].detail).toContain('hardcoded mode "direct"');
      });

      it('logs the fallback', async () => {
        await plan({ mode: 'ffmpeg' });

        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ requestedMode: 'ffmpeg', resolvedMode: 'direct' }), expect.stringContaining('ytstream:'));
      });

      it('reports the resolved mode', async () => {
        expect(stepsNamed(await plan({ mode: 'direct-redirect' }), 'mode').map((s) => s.detail)).toEqual(['resolved to direct-redirect']);
      });

      it('reports ffmpeg availability', async () => {
        processRegistry.isFfmpegAvailable.mockReturnValue(false);

        expect((await plan()).ffmpegAvailable).toBe(false);
      });

      it.each(['hls', 'hls-buffer'])('fails outright for %s without ffmpeg', async (mode) => {
        processRegistry.isFfmpegAvailable.mockReturnValue(false);

        const result = await plan({ mode });

        expect(detailOf(result, 'mode')).toContain(`mode=${mode} requested but ffmpeg is unavailable`);
      });

      it.each(['hls', 'hls-buffer'])('adds no execution steps for %s without ffmpeg', async (mode) => {
        processRegistry.isFfmpegAvailable.mockReturnValue(false);

        expect(stepsNamed(await plan({ mode }), 'execution')).toEqual([]);
      });

      it('does not need ffmpeg for direct mode', async () => {
        processRegistry.isFfmpegAvailable.mockReturnValue(false);

        expect(detailOf(await plan({ mode: 'direct' }), 'mode')).toBe('resolved to direct');
      });
    });

    describe('container, transcode, hardware and tuning', () => {
      it('ignores an invalid container and transcode override', async () => {
        const result = await plan({ container: 'avi', transcode: 'av1' }, { ytstream: { container: 'ts', transcode: 'h264' } });

        expect(result).toMatchObject({ container: 'ts', transcode: 'h264' });
      });

      it('explains they are ignored in direct family modes', async () => {
        const result = await plan({ mode: 'direct-redirect' });

        expect(detailOf(result, 'container/transcode/hardwareMode/tuning')).toContain('ignored - direct-redirect mode always fetches the raw progressive YouTube stream');
      });

      it('lists all resolved values for hls with h264', async () => {
        const result = await plan({ mode: 'hls', transcode: 'h264', hardware: 'nvenc', tuning: 'slow', container: 'ts' });

        expect(detailOf(result, 'container/transcode/hardwareMode/tuning')).toBe('container="ts", transcode="h264", hardware="nvenc", tuning="slow"');
      });

      it('says hardware and tuning are ignored for hls copy', async () => {
        const result = await plan({ mode: 'hls', transcode: 'copy' });

        expect(detailOf(result, 'container/transcode/hardwareMode/tuning')).toBe('container="mp4", transcode="copy" - hardware encoder and tuning are ignored (copy never touches an encoder)');
      });
    });

    describe('quality strictness', () => {
      it.each(['fixed', 'fallback', 'best'])('accepts %s', async (value) => {
        expect((await plan({ qualityStrictness: value.toUpperCase() })).qualityStrictness).toBe(value);
      });

      it('falls back to the configured value for an invalid one', async () => {
        const result = await plan({ qualityStrictness: 'weird' }, { ytstream: { qualityStrictness: 'fixed' } });

        expect(result.qualityStrictness).toBe('fixed');
        expect(detailOf(result, 'qualityStrictness')).toContain('using the current configured default value "fixed"');
      });

      it('falls back to "fallback" when the configured value is invalid too', async () => {
        const result = await plan({ qualityStrictness: 'weird' }, { ytstream: { qualityStrictness: 'nope' } });

        expect(result.qualityStrictness).toBe('fallback');
        expect(detailOf(result, 'qualityStrictness')).toContain('hardcoded value "fallback"');
      });

      it('does not add a strictness step for a valid value', async () => {
        expect(stepsNamed(await plan({ qualityStrictness: 'fixed' }), 'qualityStrictness')).toEqual([]);
      });
    });

    describe('quality resolution', () => {
      it('uses the requested quality as-is for direct family modes', async () => {
        const result = await plan({ mode: 'direct', quality: '2160' }, {}, { probe: true });

        expect(result.quality).toBe('2160');
        expect(detailOf(result, 'quality')).toContain('used as-is - direct mode\'s format selector already self-limits');
        expect(metadataCache.getCachedMaxHeight).not.toHaveBeenCalled();
      });

      it('never probes for best strictness', async () => {
        const result = await plan({ mode: 'hls', qualityStrictness: 'best' }, {}, { probe: true });

        expect(detailOf(result, 'quality')).toContain('quality strictness is "best"');
        expect(metadataCache.getCachedMaxHeight).not.toHaveBeenCalled();
      });

      it('never probes for fixed strictness', async () => {
        const result = await plan({ mode: 'hls', qualityStrictness: 'fixed', quality: '1080' }, {}, { probe: true });

        expect(detailOf(result, 'quality')).toContain('quality strictness is "fixed" - requested "1080" used exactly as configured');
        expect(metadataCache.getCachedMaxHeight).not.toHaveBeenCalled();
      });

      it('does not probe unless asked to', async () => {
        const result = await plan({ mode: 'hls', quality: '1080' });

        expect(detailOf(result, 'quality')).toContain('not probed - pass probe=true');
        expect(stepsNamed(result, 'quality')[0].probed).toBe(false);
      });

      it('auto-caps to the video\'s real height when probing', async () => {
        metadataCache.getCachedMaxHeight.mockResolvedValue(480);

        const result = await plan({ mode: 'hls', quality: '1080' }, {}, { probe: true });

        expect(result).toMatchObject({ quality: '480', requestedQuality: '1080', qualityCapped: true });
        expect(stepsNamed(result, 'quality')[0]).toMatchObject({ probed: true });
        expect(detailOf(result, 'quality')).toContain('auto-capped to "480"');
      });

      it('keeps the quality when the video is at least that tall', async () => {
        metadataCache.getCachedMaxHeight.mockResolvedValue(2160);

        const result = await plan({ mode: 'hls', quality: '720' }, {}, { probe: true });

        expect(result).toMatchObject({ quality: '720', qualityCapped: false });
        expect(detailOf(result, 'quality')).toContain('used as-is (not capped');
      });

      it('keeps "best" untouched when probing', async () => {
        const result = await plan({ mode: 'hls', quality: 'best' }, {}, { probe: true });

        expect(result).toMatchObject({ quality: 'best', qualityCapped: false });
      });
    });

    describe('calculatedLength', () => {
      it('is forced on for hls even when not requested', async () => {
        const result = await plan({ mode: 'hls' });

        expect(result.calculatedLength).toBe(true);
        expect(detailOf(result, 'calculatedLength')).toContain('forced on - hls builds a real .m3u8 playlist');
      });

      it('does not report a forced step when it was requested on hls', async () => {
        expect(stepsNamed(await plan({ mode: 'hls', calculatedLength: '1' }), 'calculatedLength')).toEqual([]);
      });

      it('is off for direct by default', async () => {
        const result = await plan({ mode: 'direct' });

        expect(result.calculatedLength).toBe(false);
        expect(stepsNamed(result, 'calculatedLength')).toEqual([]);
      });

      it('is reported as on but ignored for direct', async () => {
        const result = await plan({ mode: 'direct', calculatedLength: 'true' });

        expect(result.calculatedLength).toBe(true);
        expect(detailOf(result, 'calculatedLength')).toContain('on, but ignored');
      });

      it('accepts the legacy fakeLength param', async () => {
        expect((await plan({ mode: 'direct', fakeLength: 'yes' })).calculatedLength).toBe(true);
      });

      it('tolerates a pipe suffix glued on by a player', async () => {
        expect((await plan({ mode: 'direct', calculatedLength: '1|User-Agent=Youtarr-Playback%2F1.0' })).calculatedLength).toBe(true);
      });

      it('falls back to the configured value', async () => {
        expect((await plan({ mode: 'direct' }, { ytstream: { calculatedLength: true } })).calculatedLength).toBe(true);
      });

      it('prefers calculatedLength over fakeLength', async () => {
        expect((await plan({ mode: 'direct', calculatedLength: '0', fakeLength: '1' })).calculatedLength).toBe(false);
      });
    });

    describe('optional feature flags', () => {
      it('reports hot swap as ignored outside plain hls', async () => {
        expect(detailOf(await plan({ mode: 'direct' }, { ytstream: { hotSwapToCache: true } }), 'hotSwapToCache')).toContain('on, but ignored');
      });

      it('adds no hot swap step for plain hls', async () => {
        const result = await plan({ mode: 'hls' }, { ytstream: { hotSwapToCache: true } });

        expect(result.hotSwapToCache).toBe(true);
        expect(stepsNamed(result, 'hotSwapToCache')).toEqual([]);
      });

      it('adds no step when the flag is off', async () => {
        const result = await plan({ mode: 'direct' });

        expect(result).toMatchObject({ hotSwapToCache: false, backfillMissingSegments: false, finalizeToMp4: false, stealthCache: false });
        expect(stepsNamed(result, 'hotSwapToCache')).toEqual([]);
      });

      it('reports backfill as ignored for direct', async () => {
        expect(detailOf(await plan({ mode: 'direct' }, { ytstream: { backfillMissingSegments: true } }), 'backfillMissingSegments')).toContain('on, but ignored');
      });

      it('reports backfill as on for hls', async () => {
        expect(detailOf(await plan({ mode: 'hls' }, { ytstream: { backfillMissingSegments: true } }), 'backfillMissingSegments')).toMatch(/^on - /);
      });

      it('reports finalizeToMp4 as ignored outside hls-buffer', async () => {
        expect(detailOf(await plan({ mode: 'hls' }, { ytstream: { finalizeToMp4: true } }), 'finalizeToMp4')).toContain('on, but ignored');
      });

      it('reports finalizeToMp4 as on for hls-buffer', async () => {
        expect(detailOf(await plan({ mode: 'hls-buffer' }, { ytstream: { finalizeToMp4: true } }), 'finalizeToMp4')).toMatch(/^on - /);
      });

      it('reports stealthCache as ignored outside hls-buffer', async () => {
        expect(detailOf(await plan({ mode: 'direct' }, { ytstream: { stealthCache: true } }), 'stealthCache')).toContain('on, but ignored');
      });

      it('reports stealthCache as on for hls-buffer', async () => {
        const detail = detailOf(await plan({ mode: 'hls-buffer' }, { ytstream: { stealthCache: true } }), 'stealthCache');

        expect(detail).toMatch(/^on - /);
        expect(detail).not.toContain('finalizeToMp4 is also on');
      });

      it('explains how stealthCache combines with finalizeToMp4', async () => {
        const detail = detailOf(await plan({ mode: 'hls-buffer' }, { ytstream: { stealthCache: true, finalizeToMp4: true } }), 'stealthCache');

        expect(detail).toContain('finalizeToMp4 is also on');
      });

      it('only treats a literal true as enabled', async () => {
        const result = await plan({ mode: 'hls-buffer' }, { ytstream: { stealthCache: 'true', finalizeToMp4: 1, hotSwapToCache: 'yes', backfillMissingSegments: 1 } });

        expect(result).toMatchObject({ stealthCache: false, finalizeToMp4: false, hotSwapToCache: false, backfillMissingSegments: false });
      });
    });

    describe('transcode=copy codec check', () => {
      it('is not probed unless asked to', async () => {
        const result = await plan({ mode: 'hls', transcode: 'copy' });

        expect(detailOf(result, 'transcode')).toContain('copy requested; not probed');
        expect(ytDlpRunner.run).not.toHaveBeenCalled();
      });

      it('upgrades to h264 when the selected codec is not H.264', async () => {
        ytDlpRunner.run.mockResolvedValue('vp9');

        const result = await plan({ mode: 'hls', transcode: 'copy' }, {}, { probe: true });

        expect(result.transcode).toBe('h264');
        expect(detailOf(result, 'transcode')).toContain('codec is "vp9" (not H.264); auto-upgraded to h264');
      });

      it('keeps copy when the codec is H.264', async () => {
        ytDlpRunner.run.mockResolvedValue('avc1.640028');

        const result = await plan({ mode: 'hls-buffer', transcode: 'copy' }, {}, { probe: true });

        expect(result.transcode).toBe('copy');
        expect(detailOf(result, 'transcode')).toContain('(H.264); kept as copy');
      });

      it('keeps copy when the codec could not be determined', async () => {
        ytDlpRunner.run.mockResolvedValue('');

        expect((await plan({ mode: 'hls', transcode: 'copy' }, {}, { probe: true })).transcode).toBe('copy');
      });

      it('keeps copy and reports the failure when the probe fails', async () => {
        ytDlpRunner.run.mockRejectedValue(new Error('probe timed out'));

        const result = await plan({ mode: 'hls', transcode: 'copy' }, {}, { probe: true });

        expect(result.transcode).toBe('copy');
        expect(detailOf(result, 'transcode')).toContain('probe failed (probe timed out)');
      });

      it('marks the step as probed when probing', async () => {
        ytDlpRunner.run.mockResolvedValue('avc1');

        expect(stepsNamed(await plan({ mode: 'hls', transcode: 'copy' }, {}, { probe: true }), 'transcode')[0].probed).toBe(true);
      });

      it('probes with the resolved quality, client and strictness', async () => {
        ytDlpRunner.run.mockResolvedValue('avc1');

        await plan({ mode: 'hls', transcode: 'copy', quality: '1080', qualityStrictness: 'fixed' }, { ytstream: { playerClient: 'web' } }, { probe: true });

        const args = ytDlpRunner.run.mock.calls[0][0];
        expect(args).toEqual(expect.arrayContaining(['client=web', 'bv*[height=1080][vcodec^=avc1]/bv*[height=1080]']));
      });

      it('does not check the codec when transcoding to h264', async () => {
        await plan({ mode: 'hls', transcode: 'h264' }, {}, { probe: true });

        expect(ytDlpRunner.run).not.toHaveBeenCalled();
      });

      it('does not check the codec in direct mode', async () => {
        await plan({ mode: 'direct', transcode: 'copy' }, {}, { probe: true });

        expect(ytDlpRunner.run).not.toHaveBeenCalled();
      });
    });

    describe('execution narrative', () => {
      const executionDetails = (result) => stepsNamed(result, 'execution').map((s) => s.detail);

      it('describes direct mode', async () => {
        const details = executionDetails(await plan({ mode: 'direct' }));

        expect(details).toEqual([
          'resolve a direct playback URL via yt-dlp (-g)',
          'if that yt-dlp call fails with a client/session extraction error, retry once with player_client=android',
          'once a URL is resolved, fetch it; if that fetch is rejected (e.g. HTTP 403 - a session-bound URL), respond 502 - no fallback',
        ]);
      });

      it('describes direct-redirect mode', async () => {
        const details = executionDetails(await plan({ mode: 'direct-redirect' }));

        expect(details).toHaveLength(3);
        expect(details[0]).toContain('same as plain direct mode');
        expect(details[2]).toContain('302 redirect');
      });

      it('describes hls mode', async () => {
        const details = executionDetails(await plan({ mode: 'hls', transcode: 'copy' }));

        expect(details[0]).toContain('writing real HLS segment files');
        expect(details[details.length - 1]).toBe('if it still fails, respond 502 (HLS stream failed to start)');
      });

      it('mentions the software fallback for a hardware encoder', async () => {
        const details = executionDetails(await plan({ mode: 'hls', transcode: 'h264', hardware: 'nvenc' }));

        expect(details).toContain('if the hardware encoder (nvenc) fails to initialize before any bytes are sent, retry once in software (libx264)');
      });

      it.each([
        ['software encoding', { transcode: 'h264', hardware: 'none' }],
        ['stream copy', { transcode: 'copy', hardware: 'nvenc' }],
      ])('omits the software fallback for %s', async (_label, query) => {
        const details = executionDetails(await plan({ mode: 'hls', ...query }));

        expect(details.some((d) => d.includes('libx264'))).toBe(false);
      });

      it('adds the buffer explanation for hls-buffer', async () => {
        const details = executionDetails(await plan({ mode: 'hls-buffer' }));

        expect(details.filter((d) => d.includes('buffer'))).toHaveLength(5);
        expect(details[details.length - 1]).toBe('if it still fails, respond 502 (HLS stream failed to start)');
      });

      it('does not add the buffer explanation for plain hls', async () => {
        const details = executionDetails(await plan({ mode: 'hls' }));

        expect(details.some((d) => d.includes('local buffer file'))).toBe(false);
      });

      it('skips the narrative when the probe shortcut would fire', async () => {
        probeShortcut.evaluateProbeShortcut.mockReturnValue({ wouldFire: true, reason: 'metadata probe' });

        expect(stepsNamed(await plan({ mode: 'hls-buffer' }), 'execution')).toEqual([]);
      });

      it('evaluates the probe shortcut against the request and config', async () => {
        const config = { ytstream: {} };
        const req = { query: { mode: 'hls' } };

        await playbackPlan.resolvePlaybackPlan(YT_ID, req, config, { probe: false });

        expect(probeShortcut.evaluateProbeShortcut).toHaveBeenCalledWith(req, config);
      });
    });
  });
});
