/* eslint-env jest */

// Drives the post-process script's channel artwork sidecars (poster/logo/
// backdrop/banner copies, and the series-mode show/season files) through the
// real script. The script runs at require time (it reads process.argv), so
// each test loads it in an isolated module registry.

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
jest.mock('../imageResizer', () => ({ resizeImageWithFfmpeg: jest.fn() }));
jest.mock('../seriesEpisodeResolver', () => {
  const actual = jest.requireActual('../seriesEpisodeResolver');
  return {
    deriveSeasonYear: (date) => actual.deriveSeasonYear(date),
    resolveEpisodeNumber: jest.fn(() => Promise.resolve(5)),
  };
});
jest.mock('../resolutionTier', () => ({
  ...jest.requireActual('../resolutionTier'),
  probeVideoDimensions: jest.fn(),
  probeVideoDuration: jest.fn(),
}));
jest.mock('../download/tempPathManager', () => ({
  isEnabled: jest.fn(() => false),
  isTempPath: jest.fn(() => false),
  convertTempToFinal: jest.fn((p) => p),
  getTempBasePath: jest.fn(() => '/tmp/youtarr-downloads'),
}));

const mockChannel = { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() };
const mockJobVideoDownload = { update: jest.fn() };

jest.mock('../../models/channel', () => mockChannel);
jest.mock('../../models/channelvideo', () => ({ findAll: jest.fn(() => Promise.resolve([])) }));
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
const { resizeImageWithFfmpeg } = require('../imageResizer');
const resolutionTier = require('../resolutionTier');

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

describe('videoDownloadPostProcessFiles channel artwork', () => {
  const channelDir = path.join('/library', 'Channel');
  const videoDir = path.join(channelDir, 'Video Title [abc123]');
  const videoPath = path.join(videoDir, 'Video Title [abc123].mp4');
  const jsonPath = path.join(videoDir, 'Video Title [abc123].info.json');
  const thumb = path.join('/mock/images', 'channelthumb-channel123.jpg');
  const banner = path.join('/mock/images', 'channelbanner-channel123.jpg');

  let info;

  const copies = () => fs.copySync.mock.calls.map(([src, dest]) => [src, dest]);
  const copiedTo = (name) => copies().filter(([, dest]) => path.basename(dest) === name);

  async function run() {
    process.argv = ['node', 'script', videoPath];
    jest.isolateModules(() => {
      require('../videoDownloadPostProcessFiles');
    });
    await waitUntil(() => mockJobVideoDownload.update.mock.calls.length > 0 || process.exit.mock.calls.length > 0);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFsState.existing = new Set([jsonPath, videoPath, thumb, banner]);
    fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p));
    Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
    Object.assign(mockConfig, { writeChannelPosters: true, writeBackdropImages: true, writeVideoNfoFiles: false });

    process.env.YOUTARR_JOB_ID = 'job-1';
    process.exit = jest.fn();

    info = { id: 'abc123', upload_date: '20240131', title: 'Video Title', uploader: 'Channel', channel_id: 'channel123' };
    fs.readFileSync.mockImplementation(() => JSON.stringify(info));
    fs.pathExists.mockResolvedValue(false);
    fs.stat.mockResolvedValue({ size: 1000 });
    fs.move.mockResolvedValue();
    fs.remove.mockResolvedValue();
    fs.ensureDir.mockResolvedValue();
    fs.readdir.mockResolvedValue([]);
    fs.copySync.mockReset();
    fs.renameSync.mockReset();

    mockChannel.findOne.mockResolvedValue(null);
    mockChannel.findAll.mockResolvedValue([]);
    mockChannel.update.mockResolvedValue([1]);
    mockJobVideoDownload.update.mockResolvedValue([1]);
    childProcess.spawnSync.mockReturnValue({ status: 0, error: null });
    resolutionTier.probeVideoDimensions.mockResolvedValue('1920x1080');
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    process.exit = ORIGINAL_EXIT;
    delete process.env.YOUTARR_JOB_ID;
    delete process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES;
  });

  describe('channel poster, logo, backdrop and banner', () => {
    it('copies the cached channel thumbnail as poster.jpg and logo.jpg', async () => {
      await run();

      expect(copiedTo('poster.jpg').map(([src]) => src)).toEqual([thumb]);
      expect(copiedTo('logo.jpg').map(([src]) => src)).toEqual([thumb]);
    });

    it('copies the cached channel banner as backdrop.jpg and banner.jpg', async () => {
      await run();

      expect(copiedTo('backdrop.jpg').map(([src]) => src)).toEqual([banner]);
      expect(copiedTo('banner.jpg').map(([src]) => src)).toEqual([banner]);
    });

    it('puts channel artwork in the channel folder', async () => {
      await run();

      expect(path.dirname(copiedTo('poster.jpg')[0][1])).toBe(channelDir);
    });

    it('skips posters and logos when channel posters are disabled', async () => {
      mockConfig.writeChannelPosters = false;

      await run();

      expect(copiedTo('poster.jpg')).toEqual([]);
      expect(copiedTo('logo.jpg')).toEqual([]);
    });

    it('skips backdrop and banner when backdrop images are disabled', async () => {
      mockConfig.writeBackdropImages = false;

      await run();

      expect(copiedTo('backdrop.jpg')).toEqual([]);
      expect(copiedTo('banner.jpg')).toEqual([]);
    });

    it('does not overwrite artwork that already exists', async () => {
      ['poster.jpg', 'logo.jpg', 'backdrop.jpg', 'banner.jpg'].forEach((name) => mockFsState.existing.add(path.join(channelDir, name)));

      await run();

      expect(['poster.jpg', 'logo.jpg', 'backdrop.jpg', 'banner.jpg'].flatMap(copiedTo)).toEqual([]);
    });

    it('does not create a backdrop when no banner is cached', async () => {
      mockFsState.existing.delete(banner);

      await run();

      expect(copiedTo('backdrop.jpg')).toEqual([]);
      expect(copiedTo('banner.jpg')).toEqual([]);
    });

    it('does nothing for a video without a channel id', async () => {
      delete info.channel_id;

      await run();

      expect(copiedTo('poster.jpg')).toEqual([]);
      expect(copiedTo('backdrop.jpg')).toEqual([]);
    });

    it('does not write channel artwork for NZB grabs', async () => {
      process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES = 'true';

      await run();

      expect(['poster.jpg', 'logo.jpg', 'backdrop.jpg', 'banner.jpg'].flatMap(copiedTo)).toEqual([]);
    });

    it('logs and carries on when a copy fails', async () => {
      fs.copySync.mockImplementation((src, dest) => {
        if (path.basename(dest) === 'poster.jpg') throw new Error('disk full');
      });

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Error copying channel poster');
      expect(copiedTo('logo.jpg')).toHaveLength(1);
    });

    it('logs and carries on when the banner copy fails', async () => {
      fs.copySync.mockImplementation((src, dest) => {
        if (path.basename(dest) === 'banner.jpg') throw new Error('disk full');
      });

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Error copying channel banner');
    });

    it('logs and carries on when the backdrop copy fails', async () => {
      fs.copySync.mockImplementation((src, dest) => {
        if (path.basename(dest) === 'backdrop.jpg') throw new Error('disk full');
      });

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Error copying channel backdrop');
    });

    it('logs and carries on when the logo copy fails', async () => {
      fs.copySync.mockImplementation((src, dest) => {
        if (path.basename(dest) === 'logo.jpg') throw new Error('disk full');
      });

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Error copying channel logo');
    });
  });

  describe('when the channel thumbnail is not cached yet', () => {
    beforeEach(() => {
      mockFsState.existing.delete(thumb);
    });

    it('downloads it with yt-dlp for the channel url', async () => {
      childProcess.spawnSync.mockImplementation((cmd) => {
        if (cmd === 'yt-dlp') mockFsState.existing.add(thumb);
        return { status: 0, error: null };
      });

      await run();

      const call = childProcess.spawnSync.mock.calls.find(([cmd]) => cmd === 'yt-dlp');
      expect(call[1]).toEqual(expect.arrayContaining(['https://www.youtube.com/channel/channel123', thumb]));
    });

    it('downloads it only once for all the artwork that needs it', async () => {
      childProcess.spawnSync.mockImplementation((cmd) => {
        if (cmd === 'yt-dlp') mockFsState.existing.add(thumb);
        return { status: 0, error: null };
      });

      await run();

      expect(childProcess.spawnSync.mock.calls.filter(([cmd]) => cmd === 'yt-dlp')).toHaveLength(1);
    });

    it('shrinks the downloaded thumbnail and swaps it into place', async () => {
      childProcess.spawnSync.mockImplementation((cmd) => {
        if (cmd === 'yt-dlp') mockFsState.existing.add(thumb);
        return { status: 0, error: null };
      });

      await run();

      const tempPath = thumb.replace(/\.jpg$/, '.temp.jpg');
      expect(resizeImageWithFfmpeg).toHaveBeenCalledWith(thumb, tempPath, 0.4, { stdio: 'pipe' });
      expect(fs.renameSync).toHaveBeenCalledWith(tempPath, thumb);
    });

    it('then uses it as the poster', async () => {
      childProcess.spawnSync.mockImplementation((cmd) => {
        if (cmd === 'yt-dlp') mockFsState.existing.add(thumb);
        return { status: 0, error: null };
      });

      await run();

      expect(copiedTo('poster.jpg').map(([src]) => src)).toEqual([thumb]);
    });

    it('skips the poster when the download produced no file', async () => {
      await run();

      expect(copiedTo('poster.jpg')).toEqual([]);
    });

    it('warns when yt-dlp cannot be started', async () => {
      childProcess.spawnSync.mockImplementation((cmd) => (cmd === 'yt-dlp' ? { error: new Error('spawn yt-dlp ENOENT') } : { status: 0, error: null }));

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: 'spawn yt-dlp ENOENT' }) }), 'Error downloading channel thumbnail');
    });

    it('warns with the yt-dlp error output when it fails', async () => {
      childProcess.spawnSync.mockImplementation((cmd) => (cmd === 'yt-dlp' ? { status: 1, stderr: 'HTTP 404' } : { status: 0, error: null }));

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: 'HTTP 404' }) }), 'Error downloading channel thumbnail');
    });

    it('reports the exit code when yt-dlp fails silently', async () => {
      childProcess.spawnSync.mockImplementation((cmd) => (cmd === 'yt-dlp' ? { status: 2 } : { status: 0, error: null }));

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ message: 'yt-dlp exited with code 2' }) }), 'Error downloading channel thumbnail');
    });
  });

  describe('series library mode', () => {
    beforeEach(() => {
      Object.assign(mockConfig, { defaultLibraryMode: 'series' });
      // The final file lands in a new season folder that the mocked move never creates.
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4'));
      mockChannel.findOne.mockResolvedValue({
        id: 7,
        channel_id: 'channel123',
        enabled: true,
        title: 'Channel Show',
        description: 'About the show',
        sub_folder: null,
        uploader: 'Channel',
        folder_name: 'Channel',
        library_mode: 'series',
      });
    });

    it('writes tvshow.nfo and season.nfo when the video is filed as a series episode', async () => {
      await run();

      expect(nfoGenerator.writeShowNfoFile).toHaveBeenCalledTimes(1);
      expect(nfoGenerator.writeSeasonNfoFile).toHaveBeenCalledTimes(1);
    });

    it('titles the show from the channel record and includes its description and id', async () => {
      await run();

      expect(nfoGenerator.writeShowNfoFile).toHaveBeenCalledWith(expect.any(String), { title: 'Channel Show', plot: 'About the show', channelId: 'channel123' });
    });

    it('numbers the season by the upload year', async () => {
      await run();

      expect(nfoGenerator.writeSeasonNfoFile).toHaveBeenCalledWith(expect.any(String), { showTitle: 'Channel Show', season: 2024 });
    });

    it('also copies the channel thumbnail as the season poster and logo', async () => {
      await run();

      const seasonDests = [...copiedTo('poster.jpg'), ...copiedTo('logo.jpg')].map(([, dest]) => path.dirname(dest));
      expect(new Set(seasonDests).size).toBe(2);
    });

    it('does not write show or season files for NZB grabs', async () => {
      process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES = 'true';

      await run();

      expect(nfoGenerator.writeShowNfoFile).not.toHaveBeenCalled();
      expect(nfoGenerator.writeSeasonNfoFile).not.toHaveBeenCalled();
    });
  });

  describe('NZB release tag on series episodes', () => {
    const finalName = () => path.basename(mockJobVideoDownload.update.mock.calls[0][0].file_path);

    beforeEach(() => {
      Object.assign(mockConfig, { defaultLibraryMode: 'series' });
      fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p) || p.endsWith('.mp4'));
      // Staged in temp, so the script renames and moves the episode into its season folder.
      tempPathManager.isTempPath.mockReturnValue(true);
      fs.readdir.mockResolvedValue([path.basename(videoPath)]);
      process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES = 'true';
    });

    it('adds the probed resolution and channel as a scene-style tag before the id suffix', async () => {
      await run();

      expect(finalName()).toMatch(/ 1080p WEBDL-Channel \[abc123\]\.mp4$/);
    });

    it('rounds an odd probed height to its selection tier', async () => {
      resolutionTier.probeVideoDimensions.mockResolvedValue('1280x700');

      await run();

      expect(finalName()).toMatch(/ 720p WEBDL-Channel \[abc123\]\.mp4$/);
    });

    it('falls back to the preferred resolution when the probe finds nothing', async () => {
      resolutionTier.probeVideoDimensions.mockResolvedValue(null);
      mockConfig.preferredResolution = '480';

      await run();

      expect(finalName()).toMatch(/ 480p WEBDL-Channel \[abc123\]\.mp4$/);
    });

    it('falls back to the preferred resolution when the probe fails', async () => {
      resolutionTier.probeVideoDimensions.mockRejectedValue(new Error('no ffprobe'));
      mockConfig.preferredResolution = '360';

      await run();

      expect(finalName()).toMatch(/ 360p WEBDL-Channel \[abc123\]\.mp4$/);
    });

    it('leaves out the resolution when it is unknown', async () => {
      resolutionTier.probeVideoDimensions.mockResolvedValue(null);

      await run();

      expect(finalName()).toMatch(/ WEBDL-Channel \[abc123\]\.mp4$/);
      expect(finalName()).not.toMatch(/\dp WEBDL/);
    });

    it('strips punctuation from the channel name used as the release group', async () => {
      info.uploader = 'My Chan! (Official)';

      await run();

      expect(finalName()).toContain('WEBDL-MyChanOfficial');
    });

    it('uses YOUTARR as the group when the channel name has no usable characters', async () => {
      info.uploader = '!!!';

      await run();

      expect(finalName()).toContain('WEBDL-YOUTARR');
    });

    it('does not tag regular downloads', async () => {
      delete process.env.YOUTARR_SKIP_MEDIA_SIDECAR_FILES;

      await run();

      expect(finalName()).not.toContain('WEBDL');
    });
  });
});
