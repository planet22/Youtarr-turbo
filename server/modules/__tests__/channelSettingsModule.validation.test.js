/* eslint-env jest */

jest.mock('../../logger');

// Validators, the python-backed season/episode decode wrapper, the combined
// filter preview and the small read helpers of channelSettingsModule.
describe('ChannelSettingsModule validators and previews', () => {
  let mod;
  let execFileSync;
  let Channel;
  let ChannelVideo;
  let Video;
  let JobVideoDownload;
  let jobModule;
  let configValues;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    execFileSync = jest.fn();
    Channel = { findOne: jest.fn(), findAll: jest.fn().mockResolvedValue([]) };
    ChannelVideo = { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) };
    Video = { findOne: jest.fn() };
    JobVideoDownload = { count: jest.fn().mockResolvedValue(0), findAll: jest.fn().mockResolvedValue([]) };
    jobModule = { getAllJobs: jest.fn().mockReturnValue({}) };
    configValues = {};

    jest.doMock('child_process', () => ({ execFileSync, execFile: jest.fn(), execSync: jest.fn(), spawn: jest.fn(), spawnSync: jest.fn() }));
    jest.doMock('../../models/channel', () => Channel);
    jest.doMock('../../models/channelvideo', () => ChannelVideo);
    jest.doMock('../../models/video', () => Video);
    jest.doMock('../../models', () => ({ JobVideoDownload }));
    jest.doMock('../configModule', () => ({ directoryPath: '/out', getConfig: () => configValues, getDefaultSubfolder: () => null }));
    jest.doMock('../plexModule', () => ({}));
    jest.doMock('../subfolderModule', () => ({ getAll: jest.fn().mockResolvedValue(['__a', '__b']), register: jest.fn() }));
    jest.doMock('../m3uGenerator', () => ({}));
    jest.doMock('../jobModule', () => jobModule);

    mod = require('../channelSettingsModule');
  });

  describe('decodeSeasonEpisode', () => {
    it('runs the decode script with the pattern and title', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: true, season: 2, episode: 5 }));

      const result = mod.decodeSeasonEpisode('(?P<season>\\d)', 'S2E5');

      expect(result).toEqual({ matches: true, season: 2, episode: 5 });
      const [cmd, args, options] = execFileSync.mock.calls[0];
      expect(cmd).toBe('python3');
      expect(args.slice(1)).toEqual(['(?P<season>\\d)', 'S2E5']);
      expect(options).toMatchObject({ encoding: 'utf8', timeout: 1000 });
    });

    it('passes an empty title when none is given', () => {
      execFileSync.mockReturnValue('{}');

      mod.decodeSeasonEpisode('p', undefined);

      expect(execFileSync.mock.calls[0][1][2]).toBe('');
    });

    it('returns the script\'s own error report from a non-zero exit', () => {
      const err = Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ error: 'bad pattern' }) });
      execFileSync.mockImplementation(() => { throw err; });

      expect(mod.decodeSeasonEpisode('p', 't')).toEqual({ error: 'bad pattern' });
    });

    it('falls back to the exception message when stdout is not JSON', () => {
      const err = Object.assign(new Error('boom'), { stdout: 'garbage' });
      execFileSync.mockImplementation(() => { throw err; });

      expect(mod.decodeSeasonEpisode('p', 't')).toEqual({ matches: false, season: null, episode: null, error: 'boom' });
    });

    it('falls back to the exception message when there is no output at all', () => {
      execFileSync.mockImplementation(() => { throw new Error('spawn python3 ENOENT'); });

      expect(mod.decodeSeasonEpisode('p', 't').error).toBe('spawn python3 ENOENT');
    });
  });

  describe('validateSeasonEpisodeRegex', () => {
    it.each([[null], [undefined], [''], ['   ']])('treats %p as valid (use the default)', (pattern) => {
      expect(mod.validateSeasonEpisodeRegex(pattern)).toEqual({ valid: true });
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('rejects a pattern over 500 characters', () => {
      expect(mod.validateSeasonEpisodeRegex('a'.repeat(501))).toEqual({ valid: false, error: 'Season/episode regex must be 500 characters or less' });
    });

    it('accepts a pattern of exactly 500 characters', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: false }));

      expect(mod.validateSeasonEpisodeRegex('a'.repeat(500))).toEqual({ valid: true });
    });

    it('accepts a pattern the script can compile', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: false, season: null, episode: null }));

      expect(mod.validateSeasonEpisodeRegex('(?P<season>\\d+)(?P<episode>\\d+)')).toEqual({ valid: true });
    });

    it('passes the trimmed pattern and a placeholder title to the script', () => {
      execFileSync.mockReturnValue('{}');

      mod.validateSeasonEpisodeRegex('  pat  ');

      expect(execFileSync.mock.calls[0][1].slice(1)).toEqual(['pat', 'validation placeholder title']);
    });

    it('rejects a pattern the script reports an error for', () => {
      execFileSync.mockReturnValue(JSON.stringify({ error: 'missing named groups' }));

      expect(mod.validateSeasonEpisodeRegex('bad')).toEqual({ valid: false, error: 'missing named groups' });
    });
  });

  describe('small validators', () => {
    it.each([
      ['validateAudioFormat', null, true],
      ['validateAudioFormat', undefined, true],
      ['validateAudioFormat', 'video_mp3', true],
      ['validateAudioFormat', 'mp3_only', true],
      ['validateAudioFormat', 'flac', false],
      ['validateAudioFormat', '', false],
      ['validateSkipVideoFolder', null, true],
      ['validateSkipVideoFolder', undefined, true],
      ['validateSkipVideoFolder', true, true],
      ['validateSkipVideoFolder', false, true],
      ['validateSkipVideoFolder', 'true', false],
      ['validateSkipVideoFolder', 1, false],
      ['validateMediaMode', null, true],
      ['validateMediaMode', 'download', true],
      ['validateMediaMode', 'strm', true],
      ['validateMediaMode', 'both', true],
      ['validateMediaMode', 'stream', false],
      ['validateLibraryMode', undefined, true],
      ['validateLibraryMode', 'movie', true],
      ['validateLibraryMode', 'series', true],
      ['validateLibraryMode', 'show', false],
    ])('%s(%p) is valid: %s', (method, value, valid) => {
      expect(mod[method](value).valid).toBe(valid);
    });

    it('explains an invalid audio format', () => {
      expect(mod.validateAudioFormat('x').error).toBe('Invalid audio format. Valid values: video_mp3, mp3_only, or null for video only');
    });

    it('explains an invalid skip video folder value', () => {
      expect(mod.validateSkipVideoFolder('x').error).toBe('skip_video_folder must be true, false, or null');
    });

    it('explains an invalid media mode', () => {
      expect(mod.validateMediaMode('x').error).toBe('media_mode must be download, strm, both, or null');
    });

    it('explains an invalid library mode', () => {
      expect(mod.validateLibraryMode('x').error).toBe('library_mode must be movie, series, or null');
    });

    it('delegates the default rating to the canonical validator', () => {
      expect(mod.validateDefaultRating('pg')).toMatchObject({ valid: true });
      expect(mod.validateDefaultRating('not-a-rating').valid).toBe(false);
    });

    it('treats NR as no default rating', () => {
      expect(mod.validateDefaultRating('NR')).toEqual({ valid: true, value: null });
    });
  });

  describe('validateAutoDownloadEnabledTabs', () => {
    it.each([[null], [undefined]])('accepts %p', (value) => {
      expect(mod.validateAutoDownloadEnabledTabs(value, 'videos', [])).toEqual({ valid: true });
    });

    it('rejects a value that is not a string', () => {
      expect(mod.validateAutoDownloadEnabledTabs(['video'], 'videos', [])).toEqual({ valid: false, error: 'auto_download_enabled_tabs must be a string' });
    });

    it.each([[''], [' , ,']])('normalizes %p to an empty string', (value) => {
      expect(mod.validateAutoDownloadEnabledTabs(value, 'videos', [])).toEqual({ valid: true, normalized: '' });
    });

    it('rejects an unknown media type and lists the allowed ones', () => {
      const result = mod.validateAutoDownloadEnabledTabs('video,podcast', 'videos', []);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid auto_download_enabled_tabs entry: podcast. Allowed values: video, short, livestream');
    });

    it('keeps the media types of the detected tabs', () => {
      expect(mod.validateAutoDownloadEnabledTabs('video,short', 'videos,shorts', [])).toEqual({ valid: true, normalized: 'video,short' });
    });

    it('drops media types whose tab was not detected', () => {
      expect(mod.validateAutoDownloadEnabledTabs('video,short', 'shorts', [])).toEqual({ valid: true, normalized: 'short' });
    });

    it('drops media types whose tab is hidden', () => {
      expect(mod.validateAutoDownloadEnabledTabs('video,livestream', 'videos,streams', ['streams'])).toEqual({ valid: true, normalized: 'video' });
    });

    it('removes duplicates and whitespace', () => {
      expect(mod.validateAutoDownloadEnabledTabs(' video , video ', 'videos', undefined)).toEqual({ valid: true, normalized: 'video' });
    });

    it('drops everything when no tabs were detected', () => {
      expect(mod.validateAutoDownloadEnabledTabs('video', null, [])).toEqual({ valid: true, normalized: '' });
    });
  });

  describe('previewCombinedFilters', () => {
    let batch;

    const cv = (id, title, publishedAt) => ({ youtube_id: id, title, publishedAt });

    beforeEach(() => {
      Channel.findOne.mockResolvedValue({ uploader: 'The Channel' });
      batch = jest.spyOn(mod, 'testChannelFiltersBatch').mockReturnValue({ results: [] });
      jest.spyOn(mod, 'validateTitleRegex').mockReturnValue({ valid: true });
      jest.spyOn(mod, 'validateSeasonEpisodeRegex').mockReturnValue({ valid: true });
    });

    it('rejects an invalid title filter', async () => {
      mod.validateTitleRegex.mockReturnValue({ valid: false, error: 'bad title regex' });

      await expect(mod.previewCombinedFilters('UC1', '(', '')).rejects.toThrow('bad title regex');
    });

    it('rejects an invalid season/episode regex', async () => {
      mod.validateSeasonEpisodeRegex.mockReturnValue({ valid: false, error: 'bad decode regex' });

      await expect(mod.previewCombinedFilters('UC1', '', '(')).rejects.toThrow('bad decode regex');
    });

    it('reads the 50 most recent videos of the channel', async () => {
      await mod.previewCombinedFilters('UC1', '', '');

      expect(ChannelVideo.findAll).toHaveBeenCalledWith({
        where: { channel_id: 'UC1' },
        attributes: ['youtube_id', 'title', 'publishedAt'],
        order: [['publishedAt', 'DESC']],
        limit: 50,
      });
    });

    it('sends the trimmed filters and the video list to the batch tester', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'Title A', '2024-01-01'), cv('b', null, '2024-02-01')]);

      await mod.previewCombinedFilters('UC1', '  ^S  ', '  (?P<season>\\d)  ');

      expect(batch).toHaveBeenCalledWith({
        titleFilterRegex: '^S',
        seasonEpisodeRegex: '(?P<season>\\d)',
        videos: [{ id: 'a', title: 'Title A' }, { id: 'b', title: '' }],
      });
    });

    it('reports every video as matching when there is no filter and the batch gave no answer', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'A', '2024-05-01T00:00:00Z')]);

      const result = await mod.previewCombinedFilters('UC1', '', '');

      expect(result).toMatchObject({ totalCount: 1, titleMatchCount: 1, decodedCount: 0 });
      expect(result.videos[0]).toMatchObject({ video_id: 'a', titleMatches: true, season: 2024, episode: null, filename: null, seasonEpisodeMatches: false });
    });

    it('reports a video as not matching when a filter was set but the batch gave no answer', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'A', '2024-05-01T00:00:00Z')]);

      const result = await mod.previewCombinedFilters('UC1', '^S', '');

      expect(result.videos[0].titleMatches).toBe(false);
      expect(result.titleMatchCount).toBe(0);
    });

    it('does not decode a video the title filter excludes', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'A', '2024-05-01T00:00:00Z')]);
      batch.mockReturnValue({ results: [{ id: 'a', titleMatches: false, seasonEpisodeMatches: true, season: 1, episode: 1 }] });

      const result = await mod.previewCombinedFilters('UC1', '^S', '(?P<season>1)');

      expect(result.videos[0]).toMatchObject({ titleMatches: false, season: null, episode: null, filename: null });
    });

    it('falls back to the publish year as the season when the decode did not match', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'A', '2023-05-01T00:00:00Z')]);
      batch.mockReturnValue({ results: [{ id: 'a', titleMatches: true, seasonEpisodeMatches: false }] });

      const result = await mod.previewCombinedFilters('UC1', '', 'x');

      expect(result.videos[0]).toMatchObject({ titleMatches: true, season: 2023, seasonEpisodeMatches: false });
    });

    it('has no fallback season when there is no publish date', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'A', null)]);

      const result = await mod.previewCombinedFilters('UC1', '', '');

      expect(result.videos[0].season).toBeNull();
    });

    it('names a decoded video with the episode filename template', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('abc', 'Raw Title', '2024-05-01T00:00:00Z')]);
      batch.mockReturnValue({ results: [{ id: 'abc', titleMatches: true, seasonEpisodeMatches: true, season: 3, episode: 7, cleanedTitle: 'Clean' }] });

      const result = await mod.previewCombinedFilters('UC1', '', '(?P<season>3)');

      expect(result.videos[0]).toMatchObject({ season: 3, episode: 7, seasonEpisodeMatches: true });
      expect(result.videos[0].filename).toContain('Clean');
      expect(result.videos[0].filename).toContain('[abc].mp4');
      expect(result.decodedCount).toBe(1);
    });

    it('uses the original title when the decode gave no cleaned title', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('abc', 'Raw Title', '2024-05-01T00:00:00Z')]);
      batch.mockReturnValue({ results: [{ id: 'abc', titleMatches: true, seasonEpisodeMatches: true, season: 3, episode: 7 }] });

      const result = await mod.previewCombinedFilters('UC1', '', 'x');

      expect(result.videos[0].filename).toContain('Raw Title');
    });

    it('counts matches across videos', async () => {
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'A', '2024-01-01T00:00:00Z'), cv('b', 'B', '2024-01-02T00:00:00Z'), cv('c', 'C', '2024-01-03T00:00:00Z')]);
      batch.mockReturnValue({
        results: [
          { id: 'a', titleMatches: true, seasonEpisodeMatches: true, season: 1, episode: 1 },
          { id: 'b', titleMatches: true, seasonEpisodeMatches: false },
          { id: 'c', titleMatches: false, seasonEpisodeMatches: false },
        ],
      });

      const result = await mod.previewCombinedFilters('UC1', '^x', 'y');

      expect(result).toMatchObject({ totalCount: 3, titleMatchCount: 2, decodedCount: 1 });
    });

    it('works for a channel that is not in the database', async () => {
      Channel.findOne.mockResolvedValue(null);
      ChannelVideo.findAll.mockResolvedValue([cv('a', 'A', '2024-01-01T00:00:00Z')]);
      batch.mockReturnValue({ results: [{ id: 'a', titleMatches: true, seasonEpisodeMatches: true, season: 1, episode: 1 }] });

      const result = await mod.previewCombinedFilters('UC1', '', 'x');

      expect(result.videos[0].seasonEpisodeMatches).toBe(true);
    });

    it('applies the configured episode filename prefix', async () => {
      configValues = { episodeFilenamePrefix: 'EP' };
      ChannelVideo.findAll.mockResolvedValue([cv('abc', 'T', '2024-05-01T00:00:00Z')]);
      batch.mockReturnValue({ results: [{ id: 'abc', titleMatches: true, seasonEpisodeMatches: true, season: 1, episode: 2 }] });

      const result = await mod.previewCombinedFilters('UC1', '', 'x');

      expect(result.videos[0].filename).toContain('EP');
    });
  });

  describe('hasActiveDownloads', () => {
    const activeJob = (id, status = 'In Progress') => ({ [id]: { id, status } });

    it('is false when there are no jobs', async () => {
      await expect(mod.hasActiveDownloads('UC1')).resolves.toBe(false);
    });

    it.each(['Complete', 'Error', 'Terminated'])('ignores %s jobs', async (status) => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1', status));

      await expect(mod.hasActiveDownloads('UC1')).resolves.toBe(false);
      expect(JobVideoDownload.count).not.toHaveBeenCalled();
    });

    it.each(['In Progress', 'Pending'])('checks the download rows of a %s job', async (status) => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1', status));

      await mod.hasActiveDownloads('UC1');

      expect(JobVideoDownload.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ job_id: 'j1' }) }));
    });

    it('is false when the job has no pending or in-progress downloads', async () => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1'));
      JobVideoDownload.count.mockResolvedValue(0);

      await expect(mod.hasActiveDownloads('UC1')).resolves.toBe(false);
      expect(JobVideoDownload.findAll).not.toHaveBeenCalled();
    });

    it('is true when an active download belongs to the channel', async () => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1'));
      JobVideoDownload.count.mockResolvedValue(2);
      JobVideoDownload.findAll.mockResolvedValue([{ youtube_id: 'a' }, { youtube_id: 'b' }]);
      Video.findOne.mockResolvedValueOnce({ channel_id: 'other' }).mockResolvedValueOnce({ channel_id: 'UC1' });

      await expect(mod.hasActiveDownloads('UC1')).resolves.toBe(true);
    });

    it('is false when the active downloads belong to other channels', async () => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1'));
      JobVideoDownload.count.mockResolvedValue(1);
      JobVideoDownload.findAll.mockResolvedValue([{ youtube_id: 'a' }]);
      Video.findOne.mockResolvedValue({ channel_id: 'other' });

      await expect(mod.hasActiveDownloads('UC1')).resolves.toBe(false);
    });

    it('attributes a first-time download to the channel that lists the video', async () => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1'));
      JobVideoDownload.count.mockResolvedValue(1);
      JobVideoDownload.findAll.mockResolvedValue([{ youtube_id: 'brand-new' }]);
      Video.findOne.mockResolvedValue(null);
      ChannelVideo.findOne.mockResolvedValue({ id: 5 });

      await expect(mod.hasActiveDownloads('UC1')).resolves.toBe(true);
      expect(ChannelVideo.findOne).toHaveBeenCalledWith({ where: { youtube_id: 'brand-new', channel_id: 'UC1' }, attributes: ['id'] });
    });

    it('is false for a first-time download that no listing of the channel contains', async () => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1'));
      JobVideoDownload.count.mockResolvedValue(1);
      JobVideoDownload.findAll.mockResolvedValue([{ youtube_id: 'brand-new' }]);
      Video.findOne.mockResolvedValue(null);
      ChannelVideo.findOne.mockResolvedValue(null);

      await expect(mod.hasActiveDownloads('UC1')).resolves.toBe(false);
    });

    it('does not consult the listing when the video row already names another channel', async () => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1'));
      JobVideoDownload.count.mockResolvedValue(1);
      JobVideoDownload.findAll.mockResolvedValue([{ youtube_id: 'a' }]);
      Video.findOne.mockResolvedValue({ channel_id: 'other' });

      await mod.hasActiveDownloads('UC1');

      expect(ChannelVideo.findOne).not.toHaveBeenCalled();
    });

    it('looks the video up by YouTube id', async () => {
      jobModule.getAllJobs.mockReturnValue(activeJob('j1'));
      JobVideoDownload.count.mockResolvedValue(1);
      JobVideoDownload.findAll.mockResolvedValue([{ youtube_id: 'a' }]);
      Video.findOne.mockResolvedValue(null);

      await mod.hasActiveDownloads('UC1');

      expect(Video.findOne).toHaveBeenCalledWith({ where: { youtubeId: 'a' }, attributes: ['channel_id'] });
    });
  });

  describe('channel counting helpers', () => {
    it('counts channels using the global default subfolder and lists up to ten names', async () => {
      Channel.findAll.mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ uploader: `Ch${i}` })));

      const result = await mod.getChannelsUsingDefaultSubfolder();

      expect(result.count).toBe(12);
      expect(result.channelNames).toHaveLength(10);
      expect(Channel.findAll).toHaveBeenCalledWith({ attributes: ['uploader'], where: { sub_folder: '##USE_GLOBAL_DEFAULT##' } });
    });

    it('counts only enabled channels that inherit the file structure', async () => {
      Channel.findAll.mockResolvedValue([{ uploader: 'A' }]);

      const result = await mod.getChannelsUsingGlobalFileStructure();

      expect(result).toEqual({ count: 1, channelNames: ['A'] });
      expect(Channel.findAll).toHaveBeenCalledWith({ attributes: ['uploader'], where: { enabled: true, skip_video_folder: null } });
    });

    it('lists the known subfolders from the registry', async () => {
      await expect(mod.getAllSubFolders()).resolves.toEqual(['__a', '__b']);
    });
  });
});
