/* eslint-env jest */

// Drives the post-process script's channel resolution, series-mode episode
// numbering, STRM cache-on-play move and leftover-file cleanup through the real
// script. The script runs at require time (it reads process.argv), so each test
// loads it in an isolated module registry.

const mockFsState = { existing: new Set() };

jest.mock('fs-extra', () => ({
  existsSync: jest.fn((p) => mockFsState.existing.has(p)),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  ensureDirSync: jest.fn(),
  moveSync: jest.fn(),
  copySync: jest.fn(),
  removeSync: jest.fn(),
  renameSync: jest.fn(),
  utimesSync: jest.fn(),
  pathExists: jest.fn(),
  stat: jest.fn(),
  move: jest.fn(),
  remove: jest.fn(),
  ensureDir: jest.fn(),
  readdir: jest.fn(),
  promises: {},
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawnSync: jest.fn(() => ({ status: 0, error: null })),
  spawn: jest.fn(),
  execFile: jest.fn((cmd, args, callback) => callback(null, '', '')),
  execFileSync: jest.fn(),
}));

const mockConfig = {};

jest.mock('../configModule', () => ({
  getConfig: jest.fn(() => mockConfig),
  getJobsPath: jest.fn(() => '/mock/jobs'),
  getImagePath: jest.fn(() => '/mock/images'),
  stopWatchingConfig: jest.fn(),
  getCookiesPath: jest.fn(() => null),
  getDefaultSubfolder: jest.fn(() => null),
  ffmpegPath: '/usr/bin/ffmpeg',
  atomicParsleyPath: '/usr/bin/AtomicParsley',
  directoryPath: '/library',
}));

jest.mock('../nfoGenerator', () => ({
  writeVideoNfoFile: jest.fn(),
  writeEpisodeNfoFile: jest.fn(),
  writeShowNfoFile: jest.fn(),
  writeSeasonNfoFile: jest.fn(),
}));
jest.mock('../seriesEpisodeResolver', () => {
  const actual = jest.requireActual('../seriesEpisodeResolver');
  return {
    deriveSeasonYear: (date) => actual.deriveSeasonYear(date),
    resolveEpisodeNumber: jest.fn(() => Promise.resolve(5)),
  };
});
jest.mock('../download/tempPathManager', () => ({
  isEnabled: jest.fn(() => false),
  isTempPath: jest.fn(() => false),
  convertTempToFinal: jest.fn((p) => p),
  getTempBasePath: jest.fn(() => '/tmp/youtarr-downloads'),
}));

const mockChannel = { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() };
const mockChannelVideo = { findAll: jest.fn() };
const mockChannelSettings = { decodeSeasonEpisode: jest.fn() };
const mockJobVideoDownload = { update: jest.fn() };

jest.mock('../../models/channel', () => mockChannel);
jest.mock('../../models/channelvideo', () => mockChannelVideo);
jest.mock('../channelSettingsModule', () => mockChannelSettings);
jest.mock('../../models', () => ({ JobVideoDownload: mockJobVideoDownload, Channel: mockChannel }));
jest.mock('../videoPersistence', () => ({ persistDownloadedVideoForJob: jest.fn(() => Promise.resolve(null)) }));
jest.mock('../../logger');
jest.mock('../filesystem', () => ({
  ...jest.requireActual('../filesystem'),
  cleanupEmptyParents: jest.fn(() => Promise.resolve()),
  moveWithRetries: jest.fn(async () => {}),
  ensureDirWithRetries: jest.fn(async () => {}),
}));

const path = require('path');

const fs = require('fs-extra');
const childProcess = require('child_process');
const logger = require('../../logger');
const nfoGenerator = require('../nfoGenerator');
const tempPathManager = require('../download/tempPathManager');
const { moveWithRetries } = require('../filesystem');

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT = process.exit;

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(predicate, attempts = 400) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('condition was not met in time');
}

describe('videoDownloadPostProcessFiles routing and finalize', () => {
  const channelDir = path.join('/library', 'Channel');
  const videoDir = path.join(channelDir, 'Video Title [abc123]');
  const videoPath = path.join(videoDir, 'Video Title [abc123].mp4');
  const jsonPath = path.join(videoDir, 'Video Title [abc123].info.json');
  const CHANNEL = 'UCmeta000000000000000000';
  const OWNER = 'UCown0000000000000000000';

  let info;

  const channelRow = (overrides = {}) => ({
    id: 7,
    channel_id: CHANNEL,
    enabled: true,
    title: 'Channel Show',
    description: 'About the show',
    sub_folder: null,
    uploader: 'Channel',
    folder_name: 'Channel',
    default_rating: null,
    library_mode: null,
    season_episode_regex: null,
    ...overrides,
  });

  const lookedUpChannelIds = () => mockChannel.findOne.mock.calls.map(([query]) => query.where.channel_id);
  const completedPath = () => mockJobVideoDownload.update.mock.calls[0][0].file_path;
  const moves = () => moveWithRetries.mock.calls.map(([src, dest]) => [src, dest]);

  async function run() {
    process.argv = ['node', 'script', videoPath];
    jest.isolateModules(() => {
      require('../videoDownloadPostProcessFiles');
    });
    await waitUntil(() => mockJobVideoDownload.update.mock.calls.length > 0 || process.exit.mock.calls.length > 0);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFsState.existing = new Set([jsonPath, videoPath]);
    fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p));
    Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
    Object.assign(mockConfig, { writeChannelPosters: false, writeBackdropImages: false, writeVideoNfoFiles: false });

    process.env.YOUTARR_JOB_ID = 'job-1';
    process.exit = jest.fn();

    info = { id: 'abc123', upload_date: '20240131', title: 'Video Title', uploader: 'Channel', channel_id: CHANNEL };
    fs.readFileSync.mockImplementation(() => JSON.stringify(info));
    fs.pathExists.mockResolvedValue(false);
    fs.stat.mockResolvedValue({ size: 1000 });
    fs.move.mockResolvedValue();
    fs.remove.mockResolvedValue();
    fs.ensureDir.mockResolvedValue();
    fs.readdir.mockResolvedValue([]);
    fs.removeSync.mockReset();

    mockChannel.findOne.mockResolvedValue(null);
    mockChannel.findAll.mockResolvedValue([]);
    mockChannel.update.mockResolvedValue([1]);
    mockChannelVideo.findAll.mockResolvedValue([]);
    mockJobVideoDownload.update.mockResolvedValue([1]);
    tempPathManager.isTempPath.mockReturnValue(false);
    mockChannelSettings.decodeSeasonEpisode.mockReturnValue({ matches: false });
    childProcess.spawnSync.mockReturnValue({ status: 0, error: null });
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    process.exit = ORIGINAL_EXIT;
    [
      'YOUTARR_JOB_ID', 'YOUTARR_OWNER_CHANNEL_ID', 'YOUTARR_OWNER_CHANNEL_MAP', 'YOUTARR_SERIES_SEASON_OVERRIDE',
      'YOUTARR_SERIES_EPISODE_OVERRIDE', 'YOUTARR_STRM_CACHE_TARGET_DIR', 'YOUTARR_STRM_CACHE_FILE_STEM',
      'YOUTARR_SKIP_MEDIA_SIDECAR_FILES',
    ].forEach((name) => delete process.env[name]);
  });

  describe('which channel owns the video', () => {
    it('uses the explicit owner channel from the environment', async () => {
      process.env.YOUTARR_OWNER_CHANNEL_ID = `  ${OWNER}  `;

      await run();

      expect(lookedUpChannelIds()).toEqual([OWNER]);
      expect(mockChannelVideo.findAll).not.toHaveBeenCalled();
    });

    it('uses the per-video owner map for playlist downloads', async () => {
      process.env.YOUTARR_OWNER_CHANNEL_MAP = JSON.stringify({ abc123: OWNER, other: 'UCx' });

      await run();

      expect(lookedUpChannelIds()).toEqual([OWNER]);
    });

    it('prefers the explicit owner over the owner map', async () => {
      process.env.YOUTARR_OWNER_CHANNEL_ID = OWNER;
      process.env.YOUTARR_OWNER_CHANNEL_MAP = JSON.stringify({ abc123: 'UCmapped' });

      await run();

      expect(lookedUpChannelIds()).toEqual([OWNER]);
    });

    it('falls back to the video\'s own channel when the map has no entry for it', async () => {
      process.env.YOUTARR_OWNER_CHANNEL_MAP = JSON.stringify({ other: OWNER });

      await run();

      expect(lookedUpChannelIds()).toEqual([CHANNEL]);
    });

    it('warns and ignores an owner map that is not valid JSON', async () => {
      process.env.YOUTARR_OWNER_CHANNEL_MAP = '{not json';

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Post-process: could not parse owner channel map');
      expect(lookedUpChannelIds()).toEqual([CHANNEL]);
    });

    it('ignores an owner map that is not an object', async () => {
      process.env.YOUTARR_OWNER_CHANNEL_MAP = 'null';

      await run();

      expect(lookedUpChannelIds()).toEqual([CHANNEL]);
    });

    describe('when the video is already associated with tracked channels', () => {
      const associated = (...ids) => mockChannelVideo.findAll.mockResolvedValue(ids.map((channel_id) => ({ channel_id })));
      const tracked = (...rows) => mockChannel.findAll.mockResolvedValue(rows);

      it('prefers an enabled tracked channel', async () => {
        associated('UcOff', OWNER);
        tracked({ channel_id: 'UcOff', enabled: false }, { channel_id: OWNER, enabled: true });

        await run();

        expect(lookedUpChannelIds()).toEqual([OWNER]);
      });

      it('uses the video\'s own channel first when it is tracked and enabled', async () => {
        associated(OWNER);
        tracked({ channel_id: CHANNEL, enabled: true }, { channel_id: OWNER, enabled: true });

        await run();

        expect(lookedUpChannelIds()).toEqual([CHANNEL]);
      });

      it('still returns a disabled tracked channel when there is no enabled one', async () => {
        associated(OWNER);
        tracked({ channel_id: OWNER, enabled: false });

        await run();

        expect(lookedUpChannelIds()).toEqual([OWNER]);
      });

      it('never picks an untracked channel', async () => {
        associated('UcUntracked');
        tracked();

        await run();

        expect(lookedUpChannelIds()).toEqual([CHANNEL]);
      });

      it('queries the tracked channels by every candidate id without duplicates', async () => {
        associated(CHANNEL, OWNER, OWNER);

        await run();

        expect(mockChannel.findAll.mock.calls[0][0].where.channel_id).toEqual([CHANNEL, OWNER]);
      });

      it('warns and uses the video\'s own channel when the lookup fails', async () => {
        mockChannelVideo.findAll.mockRejectedValue(new Error('db down'));

        await run();

        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'abc123' }), 'Post-process: tracked owner channel lookup failed');
        expect(lookedUpChannelIds()).toEqual([CHANNEL]);
      });

      it('skips the lookup when there are no candidate channels at all', async () => {
        delete info.channel_id;

        await run();

        expect(mockChannel.findAll).not.toHaveBeenCalled();
        expect(mockChannel.findOne).not.toHaveBeenCalled();
      });
    });

    describe('channel metadata backfill', () => {
      it('records the on-disk folder name when it differs', async () => {
        mockChannel.findOne.mockResolvedValue(channelRow({ folder_name: 'Old Name' }));

        await run();

        expect(mockChannel.update).toHaveBeenCalledWith({ folder_name: 'Channel' }, { where: { id: 7 } });
      });

      it('does not backfill a channel resolved through an explicit owner', async () => {
        process.env.YOUTARR_OWNER_CHANNEL_ID = OWNER;
        mockChannel.findOne.mockResolvedValue(channelRow({ channel_id: OWNER, folder_name: 'Old Name', title: null, uploader: null }));

        await run();

        expect(mockChannel.update).not.toHaveBeenCalled();
      });

      it('carries on when the backfill update fails', async () => {
        mockChannel.findOne.mockResolvedValue(channelRow({ folder_name: 'Old Name' }));
        mockChannel.update.mockRejectedValue(new Error('db down'));

        await run();

        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Post-process error updating channel metadata');
        expect(mockJobVideoDownload.update).toHaveBeenCalled();
      });

      it('carries on when the channel lookup itself fails', async () => {
        mockChannel.findOne.mockRejectedValue(new Error('db down'));

        await run();

        expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Post-process error looking up channel');
        expect(mockJobVideoDownload.update).toHaveBeenCalled();
      });
    });
  });

  describe('series library mode episode numbering', () => {
    beforeEach(() => {
      mockConfig.defaultLibraryMode = 'series';
      mockConfig.writeVideoNfoFiles = true;
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4'));
      mockChannel.findOne.mockResolvedValue(channelRow());
    });

    const episodeNfoOptions = () => nfoGenerator.writeEpisodeNfoFile.mock.calls[0][2];

    it('uses the upload year as the season and the next episode number by default', async () => {
      await run();

      expect(episodeNfoOptions()).toEqual({ season: 2024, episode: 5, showTitle: 'Channel Show' });
    });

    it('takes the season and episode from an NZB grab\'s own numbering', async () => {
      process.env.YOUTARR_SERIES_SEASON_OVERRIDE = '3';
      process.env.YOUTARR_SERIES_EPISODE_OVERRIDE = '12';

      await run();

      expect(episodeNfoOptions()).toMatchObject({ season: 3, episode: 12 });
    });

    it('ignores an NZB override that only has a season', async () => {
      process.env.YOUTARR_SERIES_SEASON_OVERRIDE = '3';

      await run();

      expect(episodeNfoOptions()).toMatchObject({ season: 2024, episode: 5 });
    });

    describe('with a channel season/episode decode regex', () => {
      beforeEach(() => {
        mockChannel.findOne.mockResolvedValue(channelRow({ season_episode_regex: 'S(\\d+)E(\\d+)' }));
      });

      it('uses the decoded season and episode', async () => {
        mockChannelSettings.decodeSeasonEpisode.mockReturnValue({ matches: true, season: 21, episode: 10, cleanedTitle: 'S21E10' });

        await run();

        expect(episodeNfoOptions()).toMatchObject({ season: 21, episode: 10 });
      });

      it('decodes against the video title', async () => {
        await run();

        expect(mockChannelSettings.decodeSeasonEpisode).toHaveBeenCalledWith('S(\\d+)E(\\d+)', 'Video Title');
      });

      it('falls back to the upload year when the title does not match', async () => {
        mockChannelSettings.decodeSeasonEpisode.mockReturnValue({ matches: false });

        await run();

        expect(episodeNfoOptions()).toMatchObject({ season: 2024, episode: 5 });
        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ title: 'Video Title' }), expect.stringContaining('did not match this title'));
      });

      it('falls back to the upload year and warns when the regex is broken', async () => {
        mockChannelSettings.decodeSeasonEpisode.mockReturnValue({ error: 'bad regex' });

        await run();

        expect(episodeNfoOptions()).toMatchObject({ season: 2024 });
        expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'bad regex' }), expect.stringContaining('decode regex failed'));
      });

      it('falls back to the upload year when the match has no episode number', async () => {
        mockChannelSettings.decodeSeasonEpisode.mockReturnValue({ matches: true, season: 2, episode: null });

        await run();

        expect(episodeNfoOptions()).toMatchObject({ season: 2024, episode: 5 });
      });
    });

    it('files the video as a movie when it has no valid upload date', async () => {
      info.upload_date = 'not-a-date';

      await run();

      expect(nfoGenerator.writeEpisodeNfoFile).not.toHaveBeenCalled();
      expect(nfoGenerator.writeVideoNfoFile).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ id: 'abc123' }), expect.stringContaining('series mode requires a valid upload_date'));
    });

    it('names the show after the uploader when the channel is not tracked', async () => {
      mockChannel.findOne.mockResolvedValue(null);

      await run();

      expect(episodeNfoOptions().showTitle).toBe('Channel');
    });

    it('puts series content in the dedicated series subfolder when one is configured', async () => {
      mockConfig.seriesOutputSubfolder = ' Shows ';
      tempPathManager.isTempPath.mockReturnValue(true);
      fs.readdir.mockResolvedValue([path.basename(videoPath)]);

      await run();

      const [showFolder] = nfoGenerator.writeShowNfoFile.mock.calls[0];
      expect(showFolder).toBe(path.join('/library', '__Shows', 'Channel'));
    });

    it('does not use the series subfolder for a movie-mode channel', async () => {
      mockChannel.findOne.mockResolvedValue(channelRow({ library_mode: 'movie' }));
      mockConfig.seriesOutputSubfolder = 'Shows';

      await run();

      expect(nfoGenerator.writeShowNfoFile).not.toHaveBeenCalled();
    });

    it('writes a regular NFO for movie mode', async () => {
      mockChannel.findOne.mockResolvedValue(channelRow({ library_mode: 'movie' }));

      await run();

      expect(nfoGenerator.writeVideoNfoFile).toHaveBeenCalledTimes(1);
      expect(nfoGenerator.writeEpisodeNfoFile).not.toHaveBeenCalled();
    });
  });

  describe('moving files out of temp for a series episode', () => {
    beforeEach(() => {
      mockConfig.defaultLibraryMode = 'series';
      tempPathManager.isTempPath.mockReturnValue(true);
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4'));
      fs.readdir.mockResolvedValue(['Video Title [abc123].mp4', 'Video Title [abc123].jpg', 'Video Title [abc123].en.srt', 'unrelated.txt']);
      mockChannel.findOne.mockResolvedValue(channelRow());
    });

    it('renames and moves every file that shares the video id into the season folder', async () => {
      await run();

      const seasonFolder = path.dirname(completedPath());
      expect(moves().map(([, dest]) => path.basename(dest))).toEqual([
        expect.stringMatching(/^S2024E05 - .*\.mp4$/),
        expect.stringMatching(/^S2024E05 .*\.jpg$/),
        expect.stringMatching(/^S2024E05 .*\.en\.srt$/),
      ]);
      expect(new Set(moves().map(([, dest]) => path.dirname(dest)))).toEqual(new Set([seasonFolder]));
    });

    it('leaves files that do not belong to the video', async () => {
      await run();

      expect(moves().some(([src]) => path.basename(src) === 'unrelated.txt')).toBe(false);
    });

    it('records the episode file as the final path', async () => {
      await run();

      expect(path.basename(completedPath())).toMatch(/^S2024E05 - .*\.mp4$/);
      expect(path.basename(path.dirname(completedPath()))).toBe('Season 2024');
    });

    it('overwrites an existing target with a warning', async () => {
      fs.pathExists.mockResolvedValue(true);

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ destPath: expect.any(String) }), expect.stringContaining('already exists, overwriting (series mode)'));
      expect(fs.remove).toHaveBeenCalled();
    });
  });

  describe('STRM cache-on-play', () => {
    const target = path.join('/library', 'Channel', 'Video Title [abc123]');

    beforeEach(() => {
      process.env.YOUTARR_STRM_CACHE_TARGET_DIR = target;
      process.env.YOUTARR_STRM_CACHE_FILE_STEM = 'Existing Stem [abc123]';
      tempPathManager.isTempPath.mockReturnValue(true);
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4'));
      fs.readdir.mockResolvedValue(['Video Title [abc123].mp4', 'Video Title [abc123].jpg']);
    });

    it('moves every matching file into the pinned folder under the existing stem', async () => {
      await run();

      expect(moves().map(([, dest]) => dest)).toEqual([
        path.join(target, 'Existing Stem [abc123].mp4'),
        path.join(target, 'Existing Stem [abc123].jpg'),
      ]);
    });

    it('records the pinned path as the final path', async () => {
      await run();

      expect(completedPath()).toBe(path.join(target, 'Existing Stem [abc123].mp4'));
    });

    it('overwrites an existing file with a warning', async () => {
      fs.pathExists.mockResolvedValue(true);

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ destPath: expect.any(String) }), expect.stringContaining('overwriting (STRM cache-on-play)'));
    });
  });

  describe('leftover file cleanup after the move', () => {
    beforeEach(() => {
      tempPathManager.isTempPath.mockReturnValue(true);
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4'));
    });

    it.each([
      ['a yt-dlp video fragment', 'Video Title [abc123].f137.mp4'],
      ['a yt-dlp audio fragment', 'Video Title [abc123].f140.m4a'],
      ['a ranged fragment', 'Video Title [abc123].f299-1.webm'],
      ['an original webp thumbnail', 'Video Title [abc123].webp'],
      ['an original vtt subtitle', 'Video Title [abc123].en.vtt'],
    ])('removes %s', async (_label, file) => {
      fs.readdir.mockResolvedValue([file]);

      await run();

      expect(fs.remove).toHaveBeenCalledWith(path.join(videoDir, file));
    });

    it('keeps the finished video and its converted files', async () => {
      fs.readdir.mockResolvedValue(['Video Title [abc123].mp4', 'Video Title [abc123].jpg', 'Video Title [abc123].en.srt']);

      await run();

      expect(fs.remove).not.toHaveBeenCalledWith(path.join(videoDir, 'Video Title [abc123].jpg'));
      expect(fs.remove).not.toHaveBeenCalledWith(path.join(videoDir, 'Video Title [abc123].en.srt'));
    });

    it('exits with an error when the final video is missing after the move', async () => {
      fs.existsSync.mockImplementation((p) => p === jsonPath);

      await run();

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ finalVideoPath: expect.any(String) }), expect.stringContaining('Final video file doesn\'t exist after move'));
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    it('drops the thumbnail jpg from the final location for NZB grabs', async () => {
      process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES = 'true';
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4') || p.endsWith('.jpg'));

      await run();

      expect(fs.removeSync).toHaveBeenCalledWith(completedPath().replace(/\.mp4$/, '.jpg'));
    });

    it('carries on when the NZB thumbnail cannot be removed', async () => {
      process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES = 'true';
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4') || p.endsWith('.jpg'));
      fs.removeSync.mockImplementation(() => { throw new Error('locked'); });

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ finalImagePathForCleanup: expect.any(String) }), expect.stringContaining('Failed to remove thumbnail jpg for NZB grab'));
    });

    it('keeps the thumbnail jpg for regular downloads', async () => {
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4') || p.endsWith('.jpg'));

      await run();

      expect(fs.removeSync).not.toHaveBeenCalledWith(completedPath().replace(/\.mp4$/, '.jpg'));
    });
  });
});
