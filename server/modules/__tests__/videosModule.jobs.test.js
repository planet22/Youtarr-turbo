/* eslint-env jest */

jest.mock('../../logger');

// The maintenance jobs on videosModule: resolution-tag backfill, channel image
// regeneration and NFO/.strmtool.json regeneration. Info JSON files are real
// files in a temp jobs dir; everything that talks to the DB or writes sidecars
// is mocked.
describe('VideosModule maintenance jobs', () => {
  let fs;
  let os;
  let path;
  let jobsDir;
  let infoDir;
  let videosModule;
  let logger;
  let Video;
  let Channel;
  let configModule;
  let configStore;
  let messageEmitter;
  let nfoGenerator;
  let strmGenerator;
  let strmMediaInfoCache;
  let youtubeMetadataCache;
  let channelThumbnails;

  const writeInfo = (youtubeId, data = { title: 'T', formats: [] }) => {
    fs.writeFileSync(path.join(infoDir, `${youtubeId}.info.json`), JSON.stringify(data));
  };
  const video = (id, overrides = {}) => ({ id, youtubeId: `yt${id}`, filePath: `/lib/v${id}.mp4`, ...overrides });
  const serveVideos = (rows) => {
    Video.count.mockResolvedValue(rows.length);
    Video.findAll.mockResolvedValueOnce(rows).mockResolvedValue([]);
  };
  const lastRunSaved = (key) => configModule.updateConfig.mock.calls.map(([cfg]) => cfg[key]).filter(Boolean).pop();
  const statusEvents = (name) => messageEmitter.emitMessage.mock.calls.filter(([, , , event]) => event === name).map(([, , , , payload]) => payload);

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    fs = require('fs');
    os = require('os');
    path = require('path');
    jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vjobs-test-'));
    infoDir = path.join(jobsDir, 'info');
    fs.mkdirSync(infoDir);

    configStore = {};
    Video = { count: jest.fn().mockResolvedValue(0), findAll: jest.fn().mockResolvedValue([]) };
    Channel = { findAll: jest.fn().mockResolvedValue([]) };
    configModule = { getJobsPath: () => jobsDir, getConfig: jest.fn(() => configStore), updateConfig: jest.fn() };
    messageEmitter = { emitMessage: jest.fn() };
    nfoGenerator = { patchExistingNfoWithResolutionTag: jest.fn(), writeVideoNfoFile: jest.fn(() => true), writeEpisodeNfoFile: jest.fn(() => true) };
    strmGenerator = { resolveYtstreamParams: jest.fn(() => ({ container: 'mp4' })) };
    strmMediaInfoCache = { updateContainerOnly: jest.fn(), writeMediaInfoCacheFile: jest.fn(() => '/cache/path') };
    youtubeMetadataCache = { getCachedRawInfoJson: jest.fn().mockResolvedValue(null) };
    channelThumbnails = { regenerateChannelImages: jest.fn().mockResolvedValue({ copied: 3, skippedNoSource: 1, skippedNoFolder: 0, errors: 0 }) };

    jest.doMock('../../db.js', () => ({ Sequelize: {}, sequelize: {} }));
    jest.doMock('../../models', () => ({ Video, Channel }));
    jest.doMock('../configModule', () => configModule);
    jest.doMock('../fileCheckModule', () => ({}));
    jest.doMock('../mediaServers/watchStatusQueries', () => ({}));
    jest.doMock('../messageEmitter', () => messageEmitter);
    jest.doMock('../m3uGenerator', () => ({}));
    jest.doMock('../nfoGenerator', () => nfoGenerator);
    jest.doMock('../strmGenerator', () => strmGenerator);
    jest.doMock('../strmMediaInfoCache', () => strmMediaInfoCache);
    jest.doMock('../youtubeMetadataCache', () => youtubeMetadataCache);
    jest.doMock('../channel/channelThumbnails', () => channelThumbnails);

    logger = require('../../logger');
    videosModule = require('../videosModule');
  });

  afterEach(() => {
    fs.rmSync(jobsDir, { recursive: true, force: true });
  });

  describe('backfillResolutionTags', () => {
    it('patches the NFO next to each video that has cached info', async () => {
      writeInfo('yt1');
      serveVideos([video(1)]);
      nfoGenerator.patchExistingNfoWithResolutionTag.mockResolvedValue(true);

      const result = await videosModule.backfillResolutionTags();

      expect(nfoGenerator.patchExistingNfoWithResolutionTag).toHaveBeenCalledWith(path.format({ dir: '/lib', name: 'v1', ext: '.nfo' }), { title: 'T', formats: [] });
      expect(result).toMatchObject({ scanned: 1, tagged: 1, skippedNoCache: 0, skippedNoNfo: 0, errors: 0, status: 'completed', trigger: 'manual' });
    });

    it('counts videos that have no cached info', async () => {
      serveVideos([video(1)]);

      const result = await videosModule.backfillResolutionTags();

      expect(result).toMatchObject({ skippedNoCache: 1, tagged: 0 });
      expect(nfoGenerator.patchExistingNfoWithResolutionTag).not.toHaveBeenCalled();
    });

    it('counts unreadable cached info as missing', async () => {
      fs.writeFileSync(path.join(infoDir, 'yt1.info.json'), '{broken');
      serveVideos([video(1)]);

      const result = await videosModule.backfillResolutionTags();

      expect(result.skippedNoCache).toBe(1);
    });

    it('counts NFOs that were not changed', async () => {
      writeInfo('yt1');
      serveVideos([video(1)]);
      nfoGenerator.patchExistingNfoWithResolutionTag.mockResolvedValue(false);

      const result = await videosModule.backfillResolutionTags();

      expect(result).toMatchObject({ skippedNoNfo: 1, tagged: 0 });
    });

    it('ignores videos with no file', async () => {
      serveVideos([video(1, { filePath: null })]);

      const result = await videosModule.backfillResolutionTags();

      expect(result).toMatchObject({ scanned: 1, skippedNoCache: 0, tagged: 0 });
    });

    it('counts and logs a patch that throws, then carries on', async () => {
      writeInfo('yt1');
      writeInfo('yt2');
      serveVideos([video(1), video(2)]);
      nfoGenerator.patchExistingNfoWithResolutionTag.mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce(true);

      const result = await videosModule.backfillResolutionTags();

      expect(result).toMatchObject({ errors: 1, tagged: 1 });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'yt1' }), 'Failed to patch resolution tag into existing NFO');
    });

    it('reads videos in chunks of 500', async () => {
      Video.count.mockResolvedValue(1200);
      Video.findAll.mockResolvedValue([]);

      await videosModule.backfillResolutionTags();

      expect(Video.findAll.mock.calls[0][0]).toMatchObject({ limit: 500, offset: 0, raw: true });
    });

    it('reads videos in id order so consecutive chunks cannot overlap or skip rows', async () => {
      Video.count.mockResolvedValue(1200);
      Video.findAll.mockResolvedValue([]);

      await videosModule.backfillResolutionTags();

      expect(Video.findAll.mock.calls[0][0]).toMatchObject({ order: [['id', 'ASC']] });
    });

    it('accepts a bare number as the time limit', async () => {
      serveVideos([video(1)]);

      const result = await videosModule.backfillResolutionTags(-1);

      expect(result.status).toBe('timed-out');
    });

    it('stops and reports timed-out when the time limit passes', async () => {
      serveVideos([video(1)]);

      const result = await videosModule.backfillResolutionTags({ timeLimit: -1 });

      expect(result).toMatchObject({ status: 'timed-out', scanned: 0 });
    });

    it('records the trigger', async () => {
      const result = await videosModule.backfillResolutionTags({ trigger: 'scheduled' });

      expect(result.trigger).toBe('scheduled');
    });

    it('skips when a run is already in progress', async () => {
      Video.count.mockImplementation(() => new Promise(() => {}));
      videosModule.backfillResolutionTags();
      await new Promise((resolve) => setImmediate(resolve));

      await expect(videosModule.backfillResolutionTags()).resolves.toEqual({ skipped: true, reason: 'already-running' });
    });

    it('reports it is running only while it works', async () => {
      const running = [];
      Video.count.mockImplementation(async () => {
        running.push(videosModule.isResolutionTagBackfillRunning());
        return 0;
      });

      await videosModule.backfillResolutionTags();

      expect(running).toEqual([true]);
      expect(videosModule.isResolutionTagBackfillRunning()).toBe(false);
    });

    it('broadcasts start and finish and saves the last run', async () => {
      await videosModule.backfillResolutionTags({ trigger: 'scheduled' });

      const events = statusEvents('resolutionTagBackfillStatus');
      expect(events[0]).toEqual({ running: true, trigger: 'scheduled' });
      expect(events[1]).toMatchObject({ running: false, lastRun: { status: 'completed' } });
      expect(lastRunSaved('resolutionTagBackfillLastRun')).toMatchObject({ status: 'completed' });
    });

    it('keeps the rest of the config when saving the last run', async () => {
      configStore = { keep: 'me' };

      await videosModule.backfillResolutionTags();

      expect(configModule.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ keep: 'me' }));
    });

    it('rethrows an unexpected failure and records it as an error run', async () => {
      Video.count.mockRejectedValue(new Error('db down'));

      await expect(videosModule.backfillResolutionTags()).rejects.toThrow('db down');

      expect(lastRunSaved('resolutionTagBackfillLastRun')).toMatchObject({ status: 'error', errorMessage: 'db down' });
      expect(videosModule.isResolutionTagBackfillRunning()).toBe(false);
    });

    it('still finishes when saving the last run fails', async () => {
      configModule.updateConfig.mockImplementation(() => { throw new Error('read-only'); });

      await expect(videosModule.backfillResolutionTags()).resolves.toMatchObject({ status: 'completed' });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to persist resolutionTagBackfillLastRun');
    });

    it('still finishes when the completion broadcast fails', async () => {
      messageEmitter.emitMessage.mockImplementation((a, b, c, event, payload) => {
        if (payload.running === false) throw new Error('ws down');
      });

      await expect(videosModule.backfillResolutionTags()).resolves.toMatchObject({ status: 'completed' });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to emit resolutionTagBackfillStatus completion');
    });

    describe('tryStartResolutionTagBackfill', () => {
      it('starts a run in the background', async () => {
        const result = videosModule.tryStartResolutionTagBackfill({ trigger: 'scheduled' });
        await new Promise((resolve) => setImmediate(resolve));

        expect(result).toEqual({ started: true });
        expect(lastRunSaved('resolutionTagBackfillLastRun')).toMatchObject({ trigger: 'scheduled' });
      });

      it('refuses while one is running', async () => {
        Video.count.mockImplementation(() => new Promise(() => {}));
        videosModule.tryStartResolutionTagBackfill();
        await new Promise((resolve) => setImmediate(resolve));

        expect(videosModule.tryStartResolutionTagBackfill()).toEqual({ started: false, reason: 'already-running' });
      });

      it('logs a failed background run', async () => {
        Video.count.mockRejectedValue(new Error('db down'));

        videosModule.tryStartResolutionTagBackfill();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Manual resolution tag backfill run failed');
      });
    });
  });

  describe('regenerateChannelImages', () => {
    it('regenerates for every enabled channel and reports the counts', async () => {
      Channel.findAll.mockResolvedValue([{ id: 1 }, { id: 2 }]);

      const result = await videosModule.regenerateChannelImages();

      expect(Channel.findAll).toHaveBeenCalledWith({ where: { enabled: true }, raw: true });
      expect(channelThumbnails.regenerateChannelImages).toHaveBeenCalledWith([{ id: 1 }, { id: 2 }]);
      expect(result).toMatchObject({ channelsScanned: 2, copied: 3, skippedNoSource: 1, status: 'completed', trigger: 'manual' });
    });

    it('broadcasts progress and saves the last run', async () => {
      await videosModule.regenerateChannelImages({ trigger: 'scheduled' });

      expect(statusEvents('channelImageRegenStatus')[0]).toEqual({ running: true, trigger: 'scheduled' });
      expect(lastRunSaved('channelImageRegenLastRun')).toMatchObject({ status: 'completed' });
    });

    it('skips when a run is already in progress', async () => {
      Channel.findAll.mockImplementation(() => new Promise(() => {}));
      videosModule.regenerateChannelImages();
      await new Promise((resolve) => setImmediate(resolve));

      await expect(videosModule.regenerateChannelImages()).resolves.toEqual({ skipped: true, reason: 'already-running' });
      expect(videosModule.isImageRegenRunning()).toBe(true);
    });

    it('rethrows a failure and records it as an error run', async () => {
      channelThumbnails.regenerateChannelImages.mockRejectedValue(new Error('no space'));

      await expect(videosModule.regenerateChannelImages()).rejects.toThrow('no space');

      expect(lastRunSaved('channelImageRegenLastRun')).toMatchObject({ status: 'error', errorMessage: 'no space' });
      expect(videosModule.isImageRegenRunning()).toBe(false);
    });

    it('still finishes when saving the last run fails', async () => {
      configModule.updateConfig.mockImplementation(() => { throw new Error('read-only'); });

      await expect(videosModule.regenerateChannelImages()).resolves.toMatchObject({ status: 'completed' });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to persist channelImageRegenLastRun');
    });

    it('still finishes when the completion broadcast fails', async () => {
      messageEmitter.emitMessage.mockImplementation((a, b, c, event, payload) => {
        if (payload.running === false) throw new Error('ws down');
      });

      await expect(videosModule.regenerateChannelImages()).resolves.toMatchObject({ status: 'completed' });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to emit channelImageRegenStatus completion');
    });

    it('tryStartImageRegen starts in the background and refuses while running', async () => {
      Channel.findAll.mockImplementation(() => new Promise(() => {}));

      expect(videosModule.tryStartImageRegen()).toEqual({ started: true });
      await new Promise((resolve) => setImmediate(resolve));

      expect(videosModule.tryStartImageRegen()).toEqual({ started: false, reason: 'already-running' });
    });

    it('tryStartImageRegen logs a failed background run', async () => {
      Channel.findAll.mockRejectedValue(new Error('db down'));

      videosModule.tryStartImageRegen();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Manual channel image regeneration run failed');
    });
  });

  describe('regenerateVideoMetadataFiles', () => {
    it('rewrites the movie NFO from cached info with the video\'s own rating', async () => {
      writeInfo('yt1', { title: 'T' });
      serveVideos([video(1, { normalized_rating: 'PG', rating_source: 'Channel Default' })]);

      const result = await videosModule.regenerateVideoMetadataFiles();

      expect(nfoGenerator.writeVideoNfoFile).toHaveBeenCalledWith('/lib/v1.mp4', { title: 'T', normalized_rating: 'PG', rating_source: 'Channel Default' });
      expect(result).toMatchObject({ scanned: 1, regenerated: 1, errors: 0, status: 'completed' });
    });

    it('reads videos in id order so consecutive chunks cannot overlap or skip rows', async () => {
      Video.count.mockResolvedValue(1200);
      Video.findAll.mockResolvedValue([]);

      await videosModule.regenerateVideoMetadataFiles();

      expect(Video.findAll.mock.calls[0][0]).toMatchObject({ limit: 500, offset: 0, order: [['id', 'ASC']] });
    });

    it('rewrites an episode NFO for a series video', async () => {
      writeInfo('yt1', { title: 'T' });
      serveVideos([video(1, { season: 2024, episode: 5, youTubeChannelName: 'Show' })]);

      await videosModule.regenerateVideoMetadataFiles();

      expect(nfoGenerator.writeEpisodeNfoFile).toHaveBeenCalledWith('/lib/v1.mp4', expect.any(Object), { season: 2024, episode: 5, showTitle: 'Show' });
      expect(nfoGenerator.writeVideoNfoFile).not.toHaveBeenCalled();
    });

    it('treats season 0 as a series video', async () => {
      writeInfo('yt1');
      serveVideos([video(1, { season: 0, episode: 1 })]);

      await videosModule.regenerateVideoMetadataFiles();

      expect(nfoGenerator.writeEpisodeNfoFile).toHaveBeenCalled();
    });

    it.each([
      ['has no file', { filePath: null }],
      ['is marked removed', { removed: true }],
    ])('leaves a video that %s alone', async (_label, overrides) => {
      writeInfo('yt1');
      serveVideos([video(1, overrides)]);

      const result = await videosModule.regenerateVideoMetadataFiles();

      expect(result.skippedNoFile).toBe(1);
      expect(nfoGenerator.writeVideoNfoFile).not.toHaveBeenCalled();
    });

    it('uses the metadata cache when there is no info file', async () => {
      youtubeMetadataCache.getCachedRawInfoJson.mockResolvedValue({ data: { title: 'From DB' } });
      serveVideos([video(1)]);

      const result = await videosModule.regenerateVideoMetadataFiles();

      expect(nfoGenerator.writeVideoNfoFile).toHaveBeenCalledWith('/lib/v1.mp4', expect.objectContaining({ title: 'From DB' }));
      expect(result.regenerated).toBe(1);
    });

    it('skips a video with no cached info anywhere', async () => {
      serveVideos([video(1)]);

      const result = await videosModule.regenerateVideoMetadataFiles();

      expect(result).toMatchObject({ skippedNoCache: 1, regenerated: 0 });
    });

    it('counts an NFO write that reports failure as an error', async () => {
      writeInfo('yt1');
      serveVideos([video(1)]);
      nfoGenerator.writeVideoNfoFile.mockReturnValue(false);

      const result = await videosModule.regenerateVideoMetadataFiles();

      expect(result).toMatchObject({ errors: 1, regenerated: 0 });
    });

    it('counts and logs an NFO write that throws', async () => {
      writeInfo('yt1');
      serveVideos([video(1)]);
      nfoGenerator.writeVideoNfoFile.mockImplementation(() => { throw new Error('disk'); });

      const result = await videosModule.regenerateVideoMetadataFiles();

      expect(result.errors).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'yt1' }), 'Failed to regenerate NFO file');
    });

    describe('.strmtool.json sidecars', () => {
      const strmVideo = (overrides = {}) => video(1, { is_strm: true, filePath: '/lib/v1.strm', ...overrides });

      it('regenerates the sidecar for a STRM video from the cached info', async () => {
        writeInfo('yt1');
        serveVideos([strmVideo()]);

        const result = await videosModule.regenerateVideoMetadataFiles();

        expect(strmMediaInfoCache.writeMediaInfoCacheFile).toHaveBeenCalledWith('/lib/v1.strm', expect.any(Object), { container: 'mp4' });
        expect(result.strmToolRegenerated).toBe(1);
      });

      it('does not count a sidecar that was not written', async () => {
        writeInfo('yt1');
        serveVideos([strmVideo()]);
        strmMediaInfoCache.writeMediaInfoCacheFile.mockReturnValue(null);

        const result = await videosModule.regenerateVideoMetadataFiles();

        expect(result.strmToolRegenerated).toBe(0);
      });

      it('warns and carries on when the sidecar cannot be written', async () => {
        writeInfo('yt1');
        serveVideos([strmVideo()]);
        strmMediaInfoCache.writeMediaInfoCacheFile.mockImplementation(() => { throw new Error('perm'); });

        const result = await videosModule.regenerateVideoMetadataFiles();

        expect(result.regenerated).toBe(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'yt1' }), 'Failed to regenerate .strmtool.json sidecar');
      });

      it('does not touch sidecars of regular videos', async () => {
        writeInfo('yt1');
        serveVideos([video(1)]);

        await videosModule.regenerateVideoMetadataFiles();

        expect(strmMediaInfoCache.writeMediaInfoCacheFile).not.toHaveBeenCalled();
      });

      it.each([
        ['the STRM target is YouTube', { strm: { target: 'youtube' } }],
        ['the media info cache is turned off', { strm: { writeMediaInfoCache: false } }],
      ])('leaves sidecars alone when %s', async (_label, cfg) => {
        configStore = cfg;
        writeInfo('yt1');
        serveVideos([strmVideo()]);

        await videosModule.regenerateVideoMetadataFiles();

        expect(strmMediaInfoCache.writeMediaInfoCacheFile).not.toHaveBeenCalled();
        expect(strmGenerator.resolveYtstreamParams).not.toHaveBeenCalled();
      });

      it('logs the values behind the sidecar gate', async () => {
        configStore = { strm: { target: 'youtube', writeMediaInfoCache: true } };

        await videosModule.regenerateVideoMetadataFiles();

        expect(logger.info).toHaveBeenCalledWith({ strmTarget: 'youtube', strmWriteMediaInfoCache: true, canRegenerateStrmTool: false }, expect.stringContaining('.strmtool.json regen gate'));
      });

      describe('with no cached info anywhere', () => {
        it('patches just the container and counts a rewrite', async () => {
          serveVideos([strmVideo()]);
          strmMediaInfoCache.updateContainerOnly.mockReturnValue('written');

          const result = await videosModule.regenerateVideoMetadataFiles();

          expect(strmMediaInfoCache.updateContainerOnly).toHaveBeenCalledWith('/lib/v1.strm', { container: 'mp4' });
          expect(result).toMatchObject({ strmToolRegenerated: 1, strmToolAlreadyCorrect: 0, skippedNoCache: 1 });
        });

        it('counts a sidecar that was already correct', async () => {
          serveVideos([strmVideo()]);
          strmMediaInfoCache.updateContainerOnly.mockReturnValue('already-correct');

          const result = await videosModule.regenerateVideoMetadataFiles();

          expect(result).toMatchObject({ strmToolRegenerated: 0, strmToolAlreadyCorrect: 1 });
        });

        it('counts neither for any other outcome', async () => {
          serveVideos([strmVideo()]);
          strmMediaInfoCache.updateContainerOnly.mockReturnValue('no-sidecar');

          const result = await videosModule.regenerateVideoMetadataFiles();

          expect(result).toMatchObject({ strmToolRegenerated: 0, strmToolAlreadyCorrect: 0 });
        });

        it('warns and carries on when the patch fails', async () => {
          serveVideos([strmVideo()]);
          strmMediaInfoCache.updateContainerOnly.mockImplementation(() => { throw new Error('perm'); });

          await videosModule.regenerateVideoMetadataFiles();

          expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'yt1' }), expect.stringContaining('Failed to patch .strmtool.json container'));
        });

        it('leaves a regular video with no cache alone', async () => {
          serveVideos([video(1)]);

          await videosModule.regenerateVideoMetadataFiles();

          expect(strmMediaInfoCache.updateContainerOnly).not.toHaveBeenCalled();
        });
      });
    });

    it('accepts a bare number as the time limit', async () => {
      serveVideos([video(1)]);

      const result = await videosModule.regenerateVideoMetadataFiles(-1);

      expect(result.status).toBe('timed-out');
    });

    it('reports timed-out with what was done so far', async () => {
      serveVideos([video(1)]);

      const result = await videosModule.regenerateVideoMetadataFiles({ timeLimit: -1 });

      expect(result).toMatchObject({ status: 'timed-out', scanned: 0, regenerated: 0 });
    });

    it('skips when a run is already in progress', async () => {
      Video.count.mockImplementation(() => new Promise(() => {}));
      videosModule.regenerateVideoMetadataFiles();
      await new Promise((resolve) => setImmediate(resolve));

      await expect(videosModule.regenerateVideoMetadataFiles()).resolves.toEqual({ skipped: true, reason: 'already-running' });
      expect(videosModule.isMetadataRegenRunning()).toBe(true);
    });

    it('broadcasts progress and saves the last run', async () => {
      await videosModule.regenerateVideoMetadataFiles({ trigger: 'scheduled' });

      expect(statusEvents('metadataRegenStatus')[0]).toEqual({ running: true, trigger: 'scheduled' });
      expect(lastRunSaved('metadataRegenLastRun')).toMatchObject({ status: 'completed', trigger: 'scheduled' });
    });

    it('rethrows a failure and records it as an error run with the counts so far', async () => {
      Video.count.mockRejectedValue(new Error('db down'));

      await expect(videosModule.regenerateVideoMetadataFiles()).rejects.toThrow('db down');

      expect(lastRunSaved('metadataRegenLastRun')).toMatchObject({ status: 'error', errorMessage: 'db down', scanned: 0 });
      expect(videosModule.isMetadataRegenRunning()).toBe(false);
    });

    it('still finishes when saving the last run fails', async () => {
      configModule.updateConfig.mockImplementation(() => { throw new Error('read-only'); });

      await expect(videosModule.regenerateVideoMetadataFiles()).resolves.toMatchObject({ status: 'completed' });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to persist metadataRegenLastRun');
    });

    it('still finishes when the completion broadcast fails', async () => {
      messageEmitter.emitMessage.mockImplementation((a, b, c, event, payload) => {
        if (payload.running === false) throw new Error('ws down');
      });

      await expect(videosModule.regenerateVideoMetadataFiles()).resolves.toMatchObject({ status: 'completed' });

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Failed to emit metadataRegenStatus completion');
    });

    it('tryStartMetadataRegen starts in the background and refuses while running', async () => {
      Video.count.mockImplementation(() => new Promise(() => {}));

      expect(videosModule.tryStartMetadataRegen()).toEqual({ started: true });
      await new Promise((resolve) => setImmediate(resolve));

      expect(videosModule.tryStartMetadataRegen()).toEqual({ started: false, reason: 'already-running' });
    });

    it('tryStartMetadataRegen logs a failed background run', async () => {
      Video.count.mockRejectedValue(new Error('db down'));

      videosModule.tryStartMetadataRegen();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Manual metadata regeneration run failed');
    });
  });

  describe('setVideoProtection', () => {
    it('updates the flag and returns the new state', async () => {
      const row = { id: 4, update: jest.fn().mockResolvedValue(undefined) };
      Video.findByPk = jest.fn().mockResolvedValue(row);

      await expect(videosModule.setVideoProtection(4, true)).resolves.toEqual({ id: 4, protected: true });

      expect(row.update).toHaveBeenCalledWith({ protected: true });
    });

    it('throws when the video does not exist', async () => {
      Video.findByPk = jest.fn().mockResolvedValue(null);

      await expect(videosModule.setVideoProtection(4, true)).rejects.toThrow('Video not found');
    });

    describe('video/events log', () => {
      const row = () => ({
        id: 4, youtubeId: 'abc123', youTubeVideoName: 'A Title', youTubeChannelName: 'A Channel',
        update: jest.fn().mockResolvedValue(undefined),
      });

      it('records video.protected with the video facts when protection is turned on', async () => {
        Video.findByPk = jest.fn().mockResolvedValue(row());

        await videosModule.setVideoProtection(4, true);

        expect(require('../jobEventLog').record).toHaveBeenCalledWith('video.protected', {
          youtubeId: 'abc123', videoTitle: 'A Title', channelName: 'A Channel',
        });
      });

      it('records video.unprotected when protection is turned off', async () => {
        Video.findByPk = jest.fn().mockResolvedValue(row());

        await videosModule.setVideoProtection(4, false);

        expect(require('../jobEventLog').record).toHaveBeenCalledWith('video.unprotected', expect.objectContaining({ youtubeId: 'abc123' }));
      });

      it('records nothing when the video does not exist', async () => {
        Video.findByPk = jest.fn().mockResolvedValue(null);

        await expect(videosModule.setVideoProtection(4, true)).rejects.toThrow('Video not found');

        expect(require('../jobEventLog').record).not.toHaveBeenCalled();
      });

      it('records nothing when saving the flag fails', async () => {
        const failing = row();
        failing.update.mockRejectedValue(new Error('db down'));
        Video.findByPk = jest.fn().mockResolvedValue(failing);

        await expect(videosModule.setVideoProtection(4, true)).rejects.toThrow('db down');

        expect(require('../jobEventLog').record).not.toHaveBeenCalled();
      });
    });
  });
});
