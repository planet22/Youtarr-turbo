/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strm-materializer-'));
const mockImageDir = path.join(mockRoot, 'images');

jest.mock('../../logger');
jest.mock('https', () => ({ get: jest.fn() }));
jest.mock('http', () => ({ get: jest.fn() }));
jest.mock('../configModule', () => ({
  getConfig: jest.fn(),
  directoryPath: mockRoot,
  getImagePath: jest.fn(() => mockImageDir),
  getDefaultSubfolder: jest.fn(() => null),
}));
jest.mock('../ytDlpRunner', () => ({ fetchMetadata: jest.fn() }));
jest.mock('../strmGenerator', () => ({ resolveYtstreamParams: jest.fn(), writeStrmFile: jest.fn() }));
jest.mock('../strmMediaInfoCache', () => ({ writeMediaInfoCacheFile: jest.fn() }));
jest.mock('../nfoGenerator', () => ({
  writeVideoNfoFile: jest.fn(),
  writeEpisodeNfoFile: jest.fn(),
  writeShowNfoFile: jest.fn(),
  writeSeasonNfoFile: jest.fn(),
}));
jest.mock('../videoPersistence', () => ({ upsertVideoForJob: jest.fn(), upsertChannelVideoFromInfo: jest.fn() }));
jest.mock('../youtubeMetadataCache', () => ({ cacheRawInfoJson: jest.fn() }));
jest.mock('../ratingMapper', () => ({ normalizeFromYtdlp: jest.fn() }));
jest.mock('../download/downloadSettingsResolver', () => ({
  resolveFinalLibraryMode: jest.fn(),
  resolveFinalSubfolder: jest.fn(),
}));
jest.mock('../seriesEpisodeResolver', () => ({ deriveSeasonYear: jest.fn(), resolveEpisodeNumber: jest.fn() }));
jest.mock('../messageEmitter', () => ({ emitMessage: jest.fn() }));
jest.mock('../filesystem', () => ({ copySyncWithFallback: jest.fn() }));
jest.mock('../../models', () => ({ Channel: { findOne: jest.fn() } }));
jest.mock('../../models/job', () => ({ findOne: jest.fn() }));
jest.mock('../../models/video', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../channelSettingsModule', () => ({ decodeSeasonEpisode: jest.fn() }));
jest.mock('../jobModule', () => ({ getJob: jest.fn(), emitJobsUpdated: jest.fn() }));

const https = require('https');
const http = require('http');
const logger = require('../../logger');
const configModule = require('../configModule');
const ytDlpRunner = require('../ytDlpRunner');
const strmGenerator = require('../strmGenerator');
const strmMediaInfoCache = require('../strmMediaInfoCache');
const nfoGenerator = require('../nfoGenerator');
const videoPersistence = require('../videoPersistence');
const youtubeMetadataCache = require('../youtubeMetadataCache');
const ratingMapper = require('../ratingMapper');
const downloadSettingsResolver = require('../download/downloadSettingsResolver');
const seriesEpisodeResolver = require('../seriesEpisodeResolver');
const MessageEmitter = require('../messageEmitter');
const { copySyncWithFallback } = require('../filesystem');
const { Channel } = require('../../models');
const Job = require('../../models/job');
const Video = require('../../models/video');
const channelSettingsModule = require('../channelSettingsModule');
const jobModule = require('../jobModule');
const jobEventLog = require('../jobEventLog');
const strmMaterializer = require('../strmMaterializer');

const buildMeta = (overrides = {}) => ({
  id: 'abc123DEF45',
  title: 'My Video',
  fulltitle: 'My Video Full',
  uploader: 'Some Channel',
  channel_id: 'UC123',
  duration: 120.4,
  upload_date: '20240115',
  description: 'desc',
  ...overrides,
});

describe('strmMaterializer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    fs.rmSync(mockRoot, { recursive: true, force: true });
    fs.mkdirSync(mockRoot, { recursive: true });
    strmMaterializer._activeBatch = null;

    configModule.getConfig.mockReturnValue({ strm: {} });
    ytDlpRunner.fetchMetadata.mockResolvedValue(buildMeta());
    strmGenerator.resolveYtstreamParams.mockReturnValue({ mode: 'direct' });
    strmGenerator.writeStrmFile.mockImplementation((mediaBasePath) => {
      const strmPath = path.format({ dir: path.dirname(mediaBasePath), name: path.parse(mediaBasePath).name, ext: '.strm' });
      fs.mkdirSync(path.dirname(strmPath), { recursive: true });
      fs.writeFileSync(strmPath, 'http://x');
      return strmPath;
    });
    strmMediaInfoCache.writeMediaInfoCacheFile.mockReturnValue('/cache/info.json');
    nfoGenerator.writeVideoNfoFile.mockReturnValue(true);
    nfoGenerator.writeEpisodeNfoFile.mockReturnValue(true);
    downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('movie');
    downloadSettingsResolver.resolveFinalSubfolder.mockReturnValue(null);
    seriesEpisodeResolver.deriveSeasonYear.mockImplementation((d) => (d ? Number(String(d).slice(0, 4)) : null));
    seriesEpisodeResolver.resolveEpisodeNumber.mockResolvedValue(7);
    copySyncWithFallback.mockReset();
    Channel.findOne.mockResolvedValue(null);
    Video.findOne.mockResolvedValue(null);
    Video.create.mockResolvedValue({ id: 1 });
    Job.findOne.mockResolvedValue(null);
    videoPersistence.upsertChannelVideoFromInfo.mockResolvedValue(undefined);

    // Network/sidecar helpers have their own tests below; isolate them here.
    jest.spyOn(strmMaterializer, '_writeThumbnail').mockResolvedValue('/thumb.jpg');
    jest.spyOn(strmMaterializer, '_ensureChannelPoster').mockResolvedValue(undefined);
    jest.spyOn(strmMaterializer, '_ensureSeasonPoster').mockResolvedValue(undefined);
    jest.spyOn(strmMaterializer, '_ensureSeriesNfoFiles').mockResolvedValue(undefined);
  });

  afterAll(() => {
    fs.rmSync(mockRoot, { recursive: true, force: true });
  });

  describe('cancelActiveJob', () => {
    it('marks a matching batch cancelled', () => {
      strmMaterializer._activeBatch = { jobId: 'j1', cancelled: false };

      expect(strmMaterializer.cancelActiveJob('j1')).toBe(true);
      expect(strmMaterializer._activeBatch.cancelled).toBe(true);
    });

    it('returns false for another job or no batch', () => {
      expect(strmMaterializer.cancelActiveJob('j1')).toBe(false);
      strmMaterializer._activeBatch = { jobId: 'other', cancelled: false };
      expect(strmMaterializer.cancelActiveJob('j1')).toBe(false);
    });
  });

  describe('setActiveJobRemainingUrls', () => {
    const setBatch = () => {
      strmMaterializer._activeBatch = { jobId: 'j1', remainingUrls: ['a', 'b', 'c'], processedUrls: [], paused: false, cancelled: false };
    };

    it('fails without a matching batch', () => {
      expect(strmMaterializer.setActiveJobRemainingUrls('j1', ['a'])).toEqual({ success: false, error: 'No active STRM batch for this job' });
    });

    it.each([[[]], [null], ['a']])('rejects the invalid list %p', (list) => {
      setBatch();

      expect(strmMaterializer.setActiveJobRemainingUrls('j1', list)).toEqual({ success: false, error: 'orderedRemainingUrls must be a non-empty array' });
    });

    it('applies a reorder in place', () => {
      setBatch();

      expect(strmMaterializer.setActiveJobRemainingUrls('j1', ['c', 'a', 'b'])).toEqual({ success: true });
      expect(strmMaterializer._activeBatch.remainingUrls).toEqual(['c', 'a', 'b']);
    });

    it('drops urls the batch has already moved past', () => {
      setBatch();

      strmMaterializer.setActiveJobRemainingUrls('j1', ['stale', 'b']);

      expect(strmMaterializer._activeBatch.remainingUrls).toEqual(['b']);
    });

    it('fails when none of the urls are still queued', () => {
      setBatch();

      expect(strmMaterializer.setActiveJobRemainingUrls('j1', ['x', 'y']).success).toBe(false);
    });
  });

  describe('media mode helpers', () => {
    it('prefers the override over channel settings', () => {
      expect(strmMaterializer.resolveMediaMode({ mediaMode: 'both' }, { mediaMode: 'strm' })).toBe('strm');
    });

    it('then the channel setting', () => {
      expect(strmMaterializer.resolveMediaMode({ mediaMode: 'both' }, {})).toBe('both');
    });

    it('then the global config', () => {
      configModule.getConfig.mockReturnValue({ mediaMode: 'strm' });

      expect(strmMaterializer.resolveMediaMode({}, {})).toBe('strm');
    });

    it('defaults to download', () => {
      configModule.getConfig.mockReturnValue({});

      expect(strmMaterializer.resolveMediaMode()).toBe('download');
    });

    it.each([['download', false, true], ['strm', true, false], ['both', true, true]])('%s: writeStrm=%s download=%s', (mode, strm, download) => {
      expect(strmMaterializer.shouldWriteStrm(mode)).toBe(strm);
      expect(strmMaterializer.shouldDownloadMedia(mode)).toBe(download);
    });
  });

  describe('_safeName', () => {
    it.each([
      ['a<b>c:d"e/f\\g|h?i*j', 'a_b_c_d_e_f_g_h_i_j'],
      ['  lots   of   space  ', 'lots of space'],
      ['', 'Unknown'],
      [null, 'Unknown'],
      ['///', '___'],
    ])('cleans %p to %p', (input, expected) => {
      expect(strmMaterializer._safeName(input)).toBe(expected);
    });

    it('replaces control characters', () => {
      expect(strmMaterializer._safeName('a\u0001b')).toBe('a_b');
    });
  });

  describe('_toWatchUrl', () => {
    it('keeps a full URL', () => {
      expect(strmMaterializer._toWatchUrl(' https://youtu.be/abc ')).toBe('https://youtu.be/abc');
    });

    it('expands a bare id', () => {
      expect(strmMaterializer._toWatchUrl('abc123DEF45')).toBe('https://www.youtube.com/watch?v=abc123DEF45');
    });

    it('rejects anything else', () => {
      expect(() => strmMaterializer._toWatchUrl('not a url!')).toThrow('Unrecognized URL or id: not a url!');
    });
  });

  describe('_toFailedVideos', () => {
    it('lists only failures and extracts the video id from the url', () => {
      const failed = strmMaterializer._toFailedVideos([
        { ok: true, url: 'https://www.youtube.com/watch?v=okvideo1234' },
        { ok: false, url: 'https://www.youtube.com/watch?v=abc123DEF45', error: 'boom', title: 'T' },
      ]);

      expect(failed).toEqual([{ youtubeId: 'abc123DEF45', title: 'T', error: 'boom' }]);
    });

    it('understands youtu.be links', () => {
      expect(strmMaterializer._toFailedVideos([{ ok: false, url: 'https://youtu.be/abc123DEF45', error: 'x' }])[0].youtubeId).toBe('abc123DEF45');
    });

    it('falls back to the url and an unknown title', () => {
      expect(strmMaterializer._toFailedVideos([{ ok: false, url: 'weird', error: 'x' }])).toEqual([{ youtubeId: 'weird', title: 'Unknown', error: 'x' }]);
    });
  });

  describe('buildOutputPaths', () => {
    const channelDir = path.join(mockRoot, 'Some Channel');

    it('puts a movie-mode video in its own folder under the channel', () => {
      const paths = strmMaterializer.buildOutputPaths(buildMeta());

      expect(paths.channelDir).toBe(channelDir);
      expect(paths.fileStem).toBe('Some Channel - My Video Full [abc123DEF45]');
      expect(paths.videoDir).toBe(path.join(channelDir, paths.fileStem));
      expect(paths.mediaBasePath).toBe(path.join(paths.videoDir, `${paths.fileStem}.mp4`));
      expect(paths.season).toBeNull();
    });

    it('can skip the per-video folder', () => {
      const paths = strmMaterializer.buildOutputPaths(buildMeta(), { skipVideoFolder: true });

      expect(paths.videoDir).toBe(channelDir);
    });

    it('nests under a prefixed subfolder', () => {
      const paths = strmMaterializer.buildOutputPaths(buildMeta(), { subFolder: 'Music' });

      expect(paths.channelDir).toBe(path.join(mockRoot, '__Music', 'Some Channel'));
    });

    it.each([
      [{ uploader: undefined, channel: 'Chan' }, 'Chan'],
      [{ uploader: undefined, channel: undefined, uploader_id: '@handle' }, '@handle'],
      [{ uploader: undefined, channel: undefined, uploader_id: undefined, channel_id: 'UCx' }, 'UCx'],
      [{ uploader: undefined, channel: undefined, uploader_id: undefined, channel_id: undefined }, 'Unknown Channel'],
    ])('falls back through channel naming for %j', (fields, expected) => {
      expect(path.basename(strmMaterializer.buildOutputPaths(buildMeta(fields)).channelDir)).toBe(expected);
    });

    it('sanitises unsafe characters in names', () => {
      const paths = strmMaterializer.buildOutputPaths(buildMeta({ uploader: 'A/B', fulltitle: 'C:D' }));

      expect(paths.fileStem).toBe('A_B - C_D [abc123DEF45]');
    });

    it('truncates the channel to 80 and the title to 64 characters', () => {
      const paths = strmMaterializer.buildOutputPaths(buildMeta({ uploader: 'c'.repeat(200), fulltitle: 't'.repeat(200) }));

      expect(paths.fileStem).toBe(`${'c'.repeat(80)} - ${'t'.repeat(64)} [abc123DEF45]`);
    });

    it('uses the title when there is no fulltitle, and Untitled when neither', () => {
      expect(strmMaterializer.buildOutputPaths(buildMeta({ fulltitle: undefined })).fileStem).toContain('My Video [');
      expect(strmMaterializer.buildOutputPaths(buildMeta({ fulltitle: undefined, title: undefined })).fileStem).toContain('Untitled');
    });

    describe('series mode', () => {
      it('places the episode in a season folder', () => {
        const paths = strmMaterializer.buildOutputPaths(buildMeta(), { libraryMode: 'series', season: 3, episode: 5 });

        expect(paths.season).toBe(3);
        expect(path.dirname(paths.mediaBasePath)).toBe(paths.videoDir);
        expect(path.dirname(paths.videoDir)).toBe(channelDir);
        expect(paths.fileStem).toBe(path.basename(paths.mediaBasePath, '.mp4'));
      });

      it('derives the season from the upload year when none is given', () => {
        const paths = strmMaterializer.buildOutputPaths(buildMeta({ upload_date: '20210601' }), { libraryMode: 'series', episode: 1 });

        expect(paths.season).toBe(2021);
      });

      it('uses the decoded episode title when one is supplied', () => {
        const paths = strmMaterializer.buildOutputPaths(buildMeta(), { libraryMode: 'series', season: 1, episode: 2, seriesEpisodeFilenameTitle: 'Cleaned Title' });

        expect(paths.fileStem).toContain('Cleaned Title');
      });
    });
  });

  describe('materializeOne', () => {
    it('rejects when no metadata comes back', async () => {
      ytDlpRunner.fetchMetadata.mockResolvedValue(null);

      await expect(strmMaterializer.materializeOne('abc123DEF45')).rejects.toThrow('Failed to fetch video metadata');
    });

    it('rejects metadata with no id', async () => {
      ytDlpRunner.fetchMetadata.mockResolvedValue({ title: 'x' });

      await expect(strmMaterializer.materializeOne('abc123DEF45')).rejects.toThrow('Failed to fetch video metadata');
    });

    it('fetches metadata for the watch URL with a 90 second timeout', async () => {
      await strmMaterializer.materializeOne('abc123DEF45');

      expect(ytDlpRunner.fetchMetadata).toHaveBeenCalledWith('https://www.youtube.com/watch?v=abc123DEF45', 90000);
    });

    it('warms the shared metadata cache', async () => {
      const meta = buildMeta();
      ytDlpRunner.fetchMetadata.mockResolvedValue(meta);

      await strmMaterializer.materializeOne('abc123DEF45');

      expect(youtubeMetadataCache.cacheRawInfoJson).toHaveBeenCalledWith('abc123DEF45', 120.4, meta);
    });

    it('returns the written paths and the metadata', async () => {
      const result = await strmMaterializer.materializeOne('abc123DEF45');

      expect(result.youtubeId).toBe('abc123DEF45');
      expect(result.strmPath.endsWith('.strm')).toBe(true);
      expect(result.thumbPath).toBe('/thumb.jpg');
      expect(result.mediaInfoCachePath).toBe('/cache/info.json');
      expect(result.nfoPath.endsWith('.nfo')).toBe(true);
      expect(result.meta.id).toBe('abc123DEF45');
    });

    it('writes the .strm with the caller strm options', async () => {
      await strmMaterializer.materializeOne('abc123DEF45', { strmOpts: { target: 'youtube' } });

      expect(strmGenerator.writeStrmFile).toHaveBeenCalledWith(expect.any(String), 'abc123DEF45', { target: 'youtube' });
    });

    describe('onMetadata callback', () => {
      it('is called with the metadata as soon as it is fetched', async () => {
        const onMetadata = jest.fn();

        await strmMaterializer.materializeOne('abc123DEF45', { onMetadata });

        expect(onMetadata).toHaveBeenCalledWith(expect.objectContaining({ id: 'abc123DEF45' }));
      });

      it('never lets a failing callback break the materialize', async () => {
        const onMetadata = jest.fn(() => { throw new Error('ui broke'); });

        await expect(strmMaterializer.materializeOne('abc123DEF45', { onMetadata })).resolves.toBeDefined();
      });
    });

    describe('rating normalisation', () => {
      it('applies a mapped rating when the video has a content rating', async () => {
        ytDlpRunner.fetchMetadata.mockResolvedValue(buildMeta({ content_rating: 'x' }));
        ratingMapper.normalizeFromYtdlp.mockReturnValue({ normalized_rating: 'TV-14', rating_source: 'youtube' });

        const result = await strmMaterializer.materializeOne('abc123DEF45');

        expect(result.meta).toMatchObject({ normalized_rating: 'TV-14', rating_source: 'youtube' });
      });

      it('also runs for an age limit of zero', async () => {
        ytDlpRunner.fetchMetadata.mockResolvedValue(buildMeta({ age_limit: 0 }));
        ratingMapper.normalizeFromYtdlp.mockReturnValue(null);

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(ratingMapper.normalizeFromYtdlp).toHaveBeenCalled();
      });

      it('is skipped when the video has no rating information', async () => {
        await strmMaterializer.materializeOne('abc123DEF45');

        expect(ratingMapper.normalizeFromYtdlp).not.toHaveBeenCalled();
      });

      it('swallows a mapper failure', async () => {
        ytDlpRunner.fetchMetadata.mockResolvedValue(buildMeta({ content_rating: 'x' }));
        ratingMapper.normalizeFromYtdlp.mockImplementation(() => { throw new Error('bad'); });

        await expect(strmMaterializer.materializeOne('abc123DEF45')).resolves.toBeDefined();
      });
    });

    describe('sidecar files', () => {
      it('writes the media info cache, video nfo, thumbnail and posters by default', async () => {
        await strmMaterializer.materializeOne('abc123DEF45');

        expect(strmMediaInfoCache.writeMediaInfoCacheFile).toHaveBeenCalled();
        expect(nfoGenerator.writeVideoNfoFile).toHaveBeenCalled();
        expect(strmMaterializer._writeThumbnail).toHaveBeenCalled();
        expect(strmMaterializer._ensureChannelPoster).toHaveBeenCalled();
      });

      it('skips the media info cache when the target is a plain YouTube link', async () => {
        configModule.getConfig.mockReturnValue({ strm: { target: 'youtube' } });

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(strmMediaInfoCache.writeMediaInfoCacheFile).not.toHaveBeenCalled();
      });

      it('skips the media info cache when disabled', async () => {
        configModule.getConfig.mockReturnValue({ strm: { writeMediaInfoCache: false } });

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(strmMediaInfoCache.writeMediaInfoCacheFile).not.toHaveBeenCalled();
      });

      it.each([
        ['strm.writeNfo', { strm: { writeNfo: false } }],
        ['writeVideoNfoFiles', { strm: {}, writeVideoNfoFiles: false }],
      ])('skips the nfo when %s is off', async (_label, cfg) => {
        configModule.getConfig.mockReturnValue(cfg);

        const result = await strmMaterializer.materializeOne('abc123DEF45');

        expect(nfoGenerator.writeVideoNfoFile).not.toHaveBeenCalled();
        expect(result.nfoPath).toBeNull();
      });

      it('reports no nfo path when the nfo could not be written', async () => {
        nfoGenerator.writeVideoNfoFile.mockReturnValue(false);

        expect((await strmMaterializer.materializeOne('abc123DEF45')).nfoPath).toBeNull();
      });

      it('copies the thumbnail as a -backdrop.jpg when backdrop images are enabled', async () => {
        configModule.getConfig.mockReturnValue({ strm: {}, writeBackdropImages: true });

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(copySyncWithFallback).toHaveBeenCalledWith('/thumb.jpg', expect.stringMatching(/-backdrop\.jpg$/));
      });

      it('copies the thumbnail as a -fanart.jpg when video fanart is enabled', async () => {
        configModule.getConfig.mockReturnValue({ strm: {}, writeVideoFanart: true });

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(copySyncWithFallback).toHaveBeenCalledWith('/thumb.jpg', expect.stringMatching(/-fanart\.jpg$/));
      });

      it('writes no per-video artwork copies when both settings are off', async () => {
        await strmMaterializer.materializeOne('abc123DEF45');

        expect(copySyncWithFallback).not.toHaveBeenCalledWith('/thumb.jpg', expect.stringMatching(/-(backdrop|fanart)\.jpg$/));
      });

      it('skips the thumbnail when disabled', async () => {
        configModule.getConfig.mockReturnValue({ strm: { writeThumbnail: false } });

        const result = await strmMaterializer.materializeOne('abc123DEF45');

        expect(strmMaterializer._writeThumbnail).not.toHaveBeenCalled();
        expect(result.thumbPath).toBeNull();
      });

      it('writes only the .strm and the UI thumbnail for an NZB grab', async () => {
        const result = await strmMaterializer.materializeOne('abc123DEF45', { skipMediaSidecarFiles: true });

        expect(strmMediaInfoCache.writeMediaInfoCacheFile).not.toHaveBeenCalled();
        expect(nfoGenerator.writeVideoNfoFile).not.toHaveBeenCalled();
        expect(strmMaterializer._ensureChannelPoster).not.toHaveBeenCalled();
        expect(strmMaterializer._writeThumbnail).toHaveBeenCalledWith(expect.anything(), expect.anything(), { skipMediaSidecarFiles: true });
        expect(result.strmPath.endsWith('.strm')).toBe(true);
      });

      it('writes every sidecar before the .strm itself', async () => {
        const order = [];
        strmMediaInfoCache.writeMediaInfoCacheFile.mockImplementation(() => { order.push('mediaInfo'); return 'p'; });
        nfoGenerator.writeVideoNfoFile.mockImplementation(() => { order.push('nfo'); return true; });
        strmMaterializer._writeThumbnail.mockImplementation(async () => { order.push('thumb'); return 't'; });
        strmGenerator.writeStrmFile.mockImplementation((base) => { order.push('strm'); fs.mkdirSync(path.dirname(base), { recursive: true }); fs.writeFileSync(`${base}.strm`, 'x'); return `${base}.strm`; });

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(order).toEqual(['mediaInfo', 'nfo', 'thumb', 'strm']);
      });
    });

    describe('library mode and subfolder resolution', () => {
      it('looks the channel up when the caller resolved neither mode nor subfolder', async () => {
        await strmMaterializer.materializeOne('abc123DEF45');

        expect(Channel.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { channel_id: 'UC123', enabled: true } }));
      });

      it('does not look the channel up when the caller resolved both', async () => {
        await strmMaterializer.materializeOne('abc123DEF45', { libraryMode: 'movie', subFolder: null });

        expect(Channel.findOne).not.toHaveBeenCalled();
      });

      it('does not look the channel up for a video with no channel id', async () => {
        ytDlpRunner.fetchMetadata.mockResolvedValue(buildMeta({ channel_id: undefined }));

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(Channel.findOne).not.toHaveBeenCalled();
      });

      it('carries on when the channel lookup fails', async () => {
        Channel.findOne.mockRejectedValue(new Error('db down'));

        await expect(strmMaterializer.materializeOne('abc123DEF45')).resolves.toBeDefined();
      });

      it('passes the channel record and fallbacks to the settings resolvers', async () => {
        const channelRecord = { library_mode: 'movie' };
        Channel.findOne.mockResolvedValue(channelRecord);

        await strmMaterializer.materializeOne('abc123DEF45', { libraryModeFallback: 'series', subFolderFallback: 'Fallback' });

        expect(downloadSettingsResolver.resolveFinalLibraryMode).toHaveBeenCalledWith(expect.objectContaining({ channelRecord, softFallback: 'series' }));
        expect(downloadSettingsResolver.resolveFinalSubfolder).toHaveBeenCalledWith(expect.objectContaining({ channelRecord, softFallback: 'Fallback' }));
      });

      it('nests under the resolved subfolder', async () => {
        downloadSettingsResolver.resolveFinalSubfolder.mockReturnValue('Shows');

        const result = await strmMaterializer.materializeOne('abc123DEF45');

        expect(result.strmPath).toContain(`${path.sep}__Shows${path.sep}`);
      });

      it('uses a caller-provided subfolder without resolving one', async () => {
        const result = await strmMaterializer.materializeOne('abc123DEF45', { subFolder: 'Given', libraryMode: 'movie' });

        expect(downloadSettingsResolver.resolveFinalSubfolder).not.toHaveBeenCalled();
        expect(result.strmPath).toContain(`${path.sep}__Given${path.sep}`);
      });

      describe('series library mode', () => {
        beforeEach(() => {
          downloadSettingsResolver.resolveFinalLibraryMode.mockReturnValue('series');
        });

        it('uses a real season and episode from an NZB grab', async () => {
          await strmMaterializer.materializeOne('abc123DEF45', { seriesSeasonOverride: 4, seriesEpisodeOverride: 9 });

          expect(nfoGenerator.writeEpisodeNfoFile).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ season: 4, episode: 9 }));
          expect(seriesEpisodeResolver.resolveEpisodeNumber).not.toHaveBeenCalled();
        });

        it('derives the season from the upload year and resolves the next episode number', async () => {
          await strmMaterializer.materializeOne('abc123DEF45');

          expect(nfoGenerator.writeEpisodeNfoFile).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ season: 2024, episode: 7 }));
          expect(seriesEpisodeResolver.resolveEpisodeNumber).toHaveBeenCalledWith({ channelId: 'UC123', youtubeId: 'abc123DEF45', season: 2024 });
        });

        it('uses the channel decode regex when it matches', async () => {
          Channel.findOne.mockResolvedValue({ season_episode_regex: 'S(\\d+)E(\\d+)' });
          channelSettingsModule.decodeSeasonEpisode.mockReturnValue({ matches: true, season: 2, episode: 5, cleanedTitle: 'SxxExx Title' });

          await strmMaterializer.materializeOne('abc123DEF45');

          expect(nfoGenerator.writeEpisodeNfoFile).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ season: 2, episode: 5 }));
          expect(seriesEpisodeResolver.resolveEpisodeNumber).not.toHaveBeenCalled();
        });

        it('takes a decode regex passed in by the caller over the channel one', async () => {
          Channel.findOne.mockResolvedValue({ season_episode_regex: 'channel' });
          channelSettingsModule.decodeSeasonEpisode.mockReturnValue({ matches: true, season: 1, episode: 1 });

          await strmMaterializer.materializeOne('abc123DEF45', { seriesEpisodeRegex: 'caller' });

          expect(channelSettingsModule.decodeSeasonEpisode).toHaveBeenCalledWith('caller', 'My Video');
        });

        it('falls back to the upload year when the regex does not match', async () => {
          Channel.findOne.mockResolvedValue({ season_episode_regex: 'x' });
          channelSettingsModule.decodeSeasonEpisode.mockReturnValue({ matches: false });

          await strmMaterializer.materializeOne('abc123DEF45');

          expect(nfoGenerator.writeEpisodeNfoFile).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.objectContaining({ season: 2024 }));
        });

        it('falls back to the upload year and warns when the regex fails', async () => {
          Channel.findOne.mockResolvedValue({ season_episode_regex: 'x' });
          channelSettingsModule.decodeSeasonEpisode.mockReturnValue({ error: 'bad regex' });

          await strmMaterializer.materializeOne('abc123DEF45');

          expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'bad regex' }), expect.stringContaining('falling back'));
        });

        it('falls back to movie mode when there is no usable upload date', async () => {
          ytDlpRunner.fetchMetadata.mockResolvedValue(buildMeta({ upload_date: undefined }));

          await strmMaterializer.materializeOne('abc123DEF45');

          expect(nfoGenerator.writeVideoNfoFile).toHaveBeenCalled();
          expect(nfoGenerator.writeEpisodeNfoFile).not.toHaveBeenCalled();
        });

        it('writes the show, season nfo and season poster', async () => {
          await strmMaterializer.materializeOne('abc123DEF45');

          expect(strmMaterializer._ensureSeriesNfoFiles).toHaveBeenCalled();
          expect(strmMaterializer._ensureSeasonPoster).toHaveBeenCalled();
        });

        it('skips those extras for an NZB grab', async () => {
          await strmMaterializer.materializeOne('abc123DEF45', { skipMediaSidecarFiles: true });

          expect(strmMaterializer._ensureSeriesNfoFiles).not.toHaveBeenCalled();
          expect(strmMaterializer._ensureSeasonPoster).not.toHaveBeenCalled();
        });

        it('uses the configured series subfolder when nothing else resolved one', async () => {
          configModule.getConfig.mockReturnValue({ strm: {}, seriesOutputSubfolder: ' TV ' });

          const result = await strmMaterializer.materializeOne('abc123DEF45');

          expect(result.strmPath).toContain(`${path.sep}__TV${path.sep}`);
        });

        it('records the season and episode on the video row', async () => {
          await strmMaterializer.materializeOne('abc123DEF45');

          expect(Video.create).toHaveBeenCalledWith(expect.objectContaining({ season: 2024, episode: 7 }));
        });
      });
    });

    describe('saving the video', () => {
      it('creates a new video row flagged as a STRM', async () => {
        await strmMaterializer.materializeOne('abc123DEF45');

        expect(Video.create).toHaveBeenCalledWith(expect.objectContaining({
          youtubeId: 'abc123DEF45',
          youTubeChannelName: 'Some Channel',
          youTubeVideoName: 'My Video Full',
          duration: 120,
          originalDate: '20240115',
          channel_id: 'UC123',
          is_strm: true,
          removed: false,
          media_type: 'video',
          season: null,
          episode: null,
        }));
      });

      it('updates an existing video row instead of creating a duplicate', async () => {
        const existing = { update: jest.fn().mockResolvedValue(undefined) };
        Video.findOne.mockResolvedValue(existing);

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(existing.update).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'abc123DEF45' }));
        expect(Video.create).not.toHaveBeenCalled();
      });

      it('falls back to placeholder names and a null duration for sparse metadata', async () => {
        ytDlpRunner.fetchMetadata.mockResolvedValue({ id: 'abc123DEF45' });

        await strmMaterializer.materializeOne('abc123DEF45');

        expect(Video.create).toHaveBeenCalledWith(expect.objectContaining({
          youTubeChannelName: 'Unknown',
          youTubeVideoName: 'Untitled',
          duration: null,
          originalDate: null,
          description: null,
          channel_id: null,
        }));
      });

      it('links the video to the job when one is given and exists', async () => {
        // The Jobs table has no `data` column (only jobModule's in-memory
        // job objects carry job.data.nzb), so the row itself can't supply
        // this - the caller (downloadModule.js) threads it through options
        // instead. See videoPersistence.upsertVideoForJob's tracked-state
        // logging for why this matters (an 'untracked' NZB grab must not be
        // marked tracked just because its row was briefly created).
        const job = { id: 'j1', jobType: 'NZB Grab: TV' };
        Job.findOne.mockResolvedValue(job);

        await strmMaterializer.materializeOne('abc123DEF45', { jobId: 'j1', nzbImportStrategy: 'untracked' });

        expect(videoPersistence.upsertVideoForJob).toHaveBeenCalledWith(
          expect.objectContaining({ youtubeId: 'abc123DEF45' }),
          { id: 'j1', jobType: 'NZB Grab: TV', data: { nzb: { importStrategy: 'untracked' } } },
          true
        );
        expect(Video.create).not.toHaveBeenCalled();
      });

      it('preserves the real job id so the JobVideo link does not break', async () => {
        // Regression test: an earlier version of this passed a hand-built
        // object that dropped .id, which upsertVideoForJob needs for its
        // real `where: { job_id }` query - every job then failed with
        // "WHERE parameter 'job_id' has invalid 'undefined' value".
        Job.findOne.mockResolvedValue({ id: 'real-job-id', jobType: 'Channel Downloads' });

        await strmMaterializer.materializeOne('abc123DEF45', { jobId: 'real-job-id' });

        const passedJobArg = videoPersistence.upsertVideoForJob.mock.calls[0][1];
        expect(passedJobArg.id).toBe('real-job-id');
      });

      it('saves the video on its own when the job no longer exists', async () => {
        Job.findOne.mockResolvedValue(null);

        await strmMaterializer.materializeOne('abc123DEF45', { jobId: 'gone' });

        expect(videoPersistence.upsertVideoForJob).not.toHaveBeenCalled();
        expect(Video.create).toHaveBeenCalled();
      });

      it('marks a self-saved video tracked when the job no longer exists', async () => {
        Job.findOne.mockResolvedValue(null);

        await strmMaterializer.materializeOne('abc123DEF45', { jobId: 'gone' });

        expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123DEF45', true);
      });

      it('does not mark a self-saved video tracked for an untracked-strategy NZB grab', async () => {
        // Same race as above (job row not found yet) but for a grab whose
        // category strategy is 'untracked' - it must not read as tracked
        // just because this fallback path lost track of the job context.
        Job.findOne.mockResolvedValue(null);

        await strmMaterializer.materializeOne('abc123DEF45', { jobId: 'gone', nzbImportStrategy: 'untracked' });

        expect(jobEventLog.markTracked).not.toHaveBeenCalled();
      });

      it('records the channel video entry', async () => {
        await strmMaterializer.materializeOne('abc123DEF45');

        expect(videoPersistence.upsertChannelVideoFromInfo).toHaveBeenCalledWith(expect.objectContaining({ id: 'abc123DEF45', title: 'My Video Full', channel_id: 'UC123' }));
      });

      it('does not fail the materialize when the channel video upsert fails', async () => {
        videoPersistence.upsertChannelVideoFromInfo.mockRejectedValue(new Error('constraint'));

        await expect(strmMaterializer.materializeOne('abc123DEF45')).resolves.toBeDefined();
        expect(logger.error).toHaveBeenCalled();
      });
    });
  });

  describe('materializeMany', () => {
    const urls = ['https://youtu.be/aaaaaaaaaaa', 'https://youtu.be/bbbbbbbbbbb'];

    beforeEach(() => {
      jest.spyOn(strmMaterializer, 'materializeOne').mockImplementation(async (url, options) => {
        options.onMetadata(buildMeta({ id: url.slice(-11), fulltitle: `Title ${url.slice(-11)}` }));
        return { youtubeId: url.slice(-11), meta: buildMeta({ id: url.slice(-11) }) };
      });
    });

    const payloads = () => MessageEmitter.emitMessage.mock.calls.map((c) => c[4]);
    const finalPayload = () => payloads()[payloads().length - 1];

    it('materializes every url in order', async () => {
      const results = await strmMaterializer.materializeMany(urls);

      expect(results.map((r) => r.youtubeId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('starts by clearing the previous summary', async () => {
      await strmMaterializer.materializeMany(urls);

      expect(payloads()[0]).toMatchObject({ text: 'Materializing STRM files...', clearPreviousSummary: true });
    });

    it('broadcasts progress on the download channel', async () => {
      await strmMaterializer.materializeMany(urls, { jobId: 'j1' });

      expect(MessageEmitter.emitMessage).toHaveBeenCalledWith('broadcast', null, 'download', 'downloadProgress', expect.objectContaining({
        progress: expect.objectContaining({ jobId: 'j1', state: 'materializing_strm' }),
      }));
    });

    it('shows the current video title once its metadata resolves', async () => {
      await strmMaterializer.materializeMany(urls);

      expect(payloads().some((p) => p.text === 'Materializing STRM: Title aaaaaaaaaaa')).toBe(true);
    });

    it('truncates a long title in the progress text', async () => {
      strmMaterializer.materializeOne.mockImplementation(async (_url, options) => {
        options.onMetadata(buildMeta({ fulltitle: 'x'.repeat(100) }));
        return { youtubeId: 'a', meta: {} };
      });

      await strmMaterializer.materializeMany([urls[0]]);

      expect(payloads().some((p) => p.text === `Materializing STRM: ${'x'.repeat(57)}...`)).toBe(true);
    });

    it('reports the current and total video counts', async () => {
      await strmMaterializer.materializeMany(urls);

      const counts = payloads().map((p) => p.progress.videoCount);
      expect(counts.some((c) => c.current === 2 && c.total === 2)).toBe(true);
    });

    it('finishes as complete with a summary', async () => {
      await strmMaterializer.materializeMany(urls, { jobType: 'Manual' });

      expect(finalPayload().progress.state).toBe('complete');
      expect(finalPayload().finalSummary).toMatchObject({ totalDownloaded: 2, totalFailed: 0, jobType: 'Manual', failedVideos: [] });
    });

    it('defaults the job type to STRM', async () => {
      await strmMaterializer.materializeMany(urls);

      expect(finalPayload().finalSummary.jobType).toBe('STRM');
    });

    it('records a failure and carries on with the rest', async () => {
      strmMaterializer.materializeOne.mockRejectedValueOnce(new Error('metadata failed'));

      const results = await strmMaterializer.materializeMany(urls);

      expect(results[0]).toMatchObject({ ok: false, error: 'metadata failed' });
      expect(results[1].ok).toBe(true);
    });

    it('reports failed videos with their ids', async () => {
      strmMaterializer.materializeOne.mockRejectedValueOnce(new Error('metadata failed'));

      const results = await strmMaterializer.materializeMany(['https://www.youtube.com/watch?v=aaaaaaaaaaa']);

      expect(results.failedVideos).toEqual([{ youtubeId: 'aaaaaaaaaaa', title: 'Unknown', error: 'metadata failed' }]);
    });

    it('still complete when only some videos failed', async () => {
      strmMaterializer.materializeOne.mockRejectedValueOnce(new Error('x'));

      await strmMaterializer.materializeMany(urls);

      expect(finalPayload().progress.state).toBe('complete');
    });

    it('finishes as error when every video failed', async () => {
      strmMaterializer.materializeOne.mockRejectedValue(new Error('x'));

      await strmMaterializer.materializeMany(urls);

      expect(finalPayload().progress.state).toBe('error');
    });

    it('carries the title of a video that failed after its metadata resolved', async () => {
      strmMaterializer.materializeOne.mockImplementationOnce(async (_url, options) => {
        options.onMetadata(buildMeta({ fulltitle: 'Half Done' }));
        throw new Error('nfo write failed');
      });

      const results = await strmMaterializer.materializeMany([urls[0]]);

      expect(results[0].title).toBe('Half Done');
    });

    it('exposes cancelled, failedVideos and notStartedCount on the result', async () => {
      const results = await strmMaterializer.materializeMany(urls);

      expect(results).toMatchObject({ cancelled: false, failedVideos: [], notStartedCount: 0 });
    });

    it('clears the active batch when finished', async () => {
      await strmMaterializer.materializeMany(urls);

      expect(strmMaterializer._activeBatch).toBeNull();
    });

    it('clears the active batch even when the loop throws', async () => {
      MessageEmitter.emitMessage.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('emit failed'); });

      await expect(strmMaterializer.materializeMany(urls)).rejects.toThrow('emit failed');

      expect(strmMaterializer._activeBatch).toBeNull();
    });

    it('registers the batch while running so it can be controlled', async () => {
      let seen = null;
      strmMaterializer.materializeOne.mockImplementationOnce(async (_url, options) => {
        seen = strmMaterializer.getActiveBatchState('j1');
        options.onMetadata(buildMeta());
        return { youtubeId: 'a', meta: {} };
      });

      await strmMaterializer.materializeMany([urls[0]], { jobId: 'j1' });

      expect(seen).toMatchObject({ processedUrls: [urls[0]], remainingUrls: [], paused: false });
    });

    describe('cancellation', () => {
      it('stops before the next video and finishes as terminated', async () => {
        strmMaterializer.materializeOne.mockImplementationOnce(async (_url, options) => {
          strmMaterializer.cancelActiveJob('j1');
          options.onMetadata(buildMeta());
          return { youtubeId: 'a', meta: {} };
        });

        const results = await strmMaterializer.materializeMany(urls, { jobId: 'j1' });

        expect(results).toHaveLength(1);
        expect(results.cancelled).toBe(true);
        expect(results.notStartedCount).toBe(1);
        expect(finalPayload().progress.state).toBe('terminated');
        expect(finalPayload()).toMatchObject({ warning: true, terminationReason: 'User requested termination' });
      });
    });

    describe('pausing', () => {
      it('waits between videos until resumed', async () => {
        jest.useFakeTimers();
        try {
          strmMaterializer.materializeOne.mockImplementationOnce(async (_url, options) => {
            strmMaterializer.pauseActiveJob('j1');
            options.onMetadata(buildMeta());
            return { youtubeId: 'a', meta: {} };
          });

          const pending = strmMaterializer.materializeMany(urls, { jobId: 'j1' });
          await jest.advanceTimersByTimeAsync(1000);
          expect(strmMaterializer.materializeOne).toHaveBeenCalledTimes(1);

          strmMaterializer.resumeActiveJob('j1');
          await jest.advanceTimersByTimeAsync(400);
          await pending;

          expect(strmMaterializer.materializeOne).toHaveBeenCalledTimes(2);
        } finally {
          jest.useRealTimers();
        }
      });

      it('stops waiting when cancelled while paused', async () => {
        jest.useFakeTimers();
        try {
          strmMaterializer.materializeOne.mockImplementationOnce(async (_url, options) => {
            strmMaterializer.pauseActiveJob('j1');
            options.onMetadata(buildMeta());
            return { youtubeId: 'a', meta: {} };
          });

          const pending = strmMaterializer.materializeMany(urls, { jobId: 'j1' });
          await jest.advanceTimersByTimeAsync(500);
          strmMaterializer.cancelActiveJob('j1');
          await jest.advanceTimersByTimeAsync(400);
          const results = await pending;

          expect(results.cancelled).toBe(true);
        } finally {
          jest.useRealTimers();
        }
      });
    });

    describe('live job progress', () => {
      it('does nothing without a job id', async () => {
        await strmMaterializer.materializeMany(urls);

        expect(jobModule.getJob).not.toHaveBeenCalled();
      });

      it('keeps the job record current after each video', async () => {
        const job = {};
        jobModule.getJob.mockReturnValue(job);

        await strmMaterializer.materializeMany(urls, { jobId: 'j1' });

        expect(job.data.videos.map((v) => v.youtubeId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
        expect(job.data.failedVideos).toEqual([]);
        expect(jobModule.emitJobsUpdated).toHaveBeenCalledWith('j1', 'VideoProgress');
      });

      it('lists failures on the job record', async () => {
        const job = { data: {} };
        jobModule.getJob.mockReturnValue(job);
        strmMaterializer.materializeOne.mockRejectedValueOnce(new Error('boom'));

        await strmMaterializer.materializeMany(urls, { jobId: 'j1' });

        expect(job.data.failedVideos).toHaveLength(1);
      });

      it('ignores a job that no longer exists', async () => {
        jobModule.getJob.mockReturnValue(null);

        await strmMaterializer.materializeMany(urls, { jobId: 'j1' });

        expect(jobModule.emitJobsUpdated).not.toHaveBeenCalled();
      });

      it('never lets a sync failure break the batch', async () => {
        jobModule.getJob.mockImplementation(() => { throw new Error('boom'); });

        const results = await strmMaterializer.materializeMany(urls, { jobId: 'j1' });

        expect(results).toHaveLength(2);
      });
    });
  });

  describe('sidecar helpers', () => {
    beforeEach(() => {
      strmMaterializer._writeThumbnail.mockRestore();
      strmMaterializer._ensureChannelPoster.mockRestore();
      strmMaterializer._ensureSeasonPoster.mockRestore();
      strmMaterializer._ensureSeriesNfoFiles.mockRestore();
      jest.spyOn(strmMaterializer, '_downloadFile').mockResolvedValue(undefined);
    });

    describe('_cachedChannelThumbPath', () => {
      it('is null without a channel id', () => {
        expect(strmMaterializer._cachedChannelThumbPath(null)).toBeNull();
      });

      it('is null when the avatar is not cached', () => {
        expect(strmMaterializer._cachedChannelThumbPath('UC123')).toBeNull();
      });

      it('returns the cached avatar path', () => {
        fs.mkdirSync(mockImageDir, { recursive: true });
        const cached = path.join(mockImageDir, 'channelthumb-UC123.jpg');
        fs.writeFileSync(cached, 'x');

        expect(strmMaterializer._cachedChannelThumbPath('UC123')).toBe(cached);
      });
    });

    describe.each([
      ['_ensureChannelPoster', () => path.join(mockRoot, 'Channel')],
      ['_ensureSeasonPoster', () => path.join(mockRoot, 'Channel', 'Season 1')],
    ])('%s', (method, dirFn) => {
      const posterPath = () => path.join(dirFn(), 'poster.jpg');

      it('does nothing when a poster already exists', async () => {
        fs.mkdirSync(dirFn(), { recursive: true });
        fs.writeFileSync(posterPath(), 'x');

        await strmMaterializer[method](buildMeta(), dirFn());

        expect(strmMaterializer._downloadFile).not.toHaveBeenCalled();
        expect(copySyncWithFallback).not.toHaveBeenCalled();
      });

      it('does nothing when channel posters are disabled', async () => {
        configModule.getConfig.mockReturnValue({ writeChannelPosters: false });

        await strmMaterializer[method](buildMeta(), dirFn());

        expect(strmMaterializer._downloadFile).not.toHaveBeenCalled();
        expect(fs.existsSync(dirFn())).toBe(false);
      });

      it('copies the cached channel avatar when there is one', async () => {
        fs.mkdirSync(mockImageDir, { recursive: true });
        const cached = path.join(mockImageDir, 'channelthumb-UC123.jpg');
        fs.writeFileSync(cached, 'x');

        await strmMaterializer[method](buildMeta(), dirFn());

        expect(copySyncWithFallback).toHaveBeenCalledWith(cached, posterPath());
        expect(strmMaterializer._downloadFile).not.toHaveBeenCalled();
      });

      it('falls back to the video thumbnail when copying the avatar fails', async () => {
        fs.mkdirSync(mockImageDir, { recursive: true });
        fs.writeFileSync(path.join(mockImageDir, 'channelthumb-UC123.jpg'), 'x');
        copySyncWithFallback.mockImplementation(() => { throw new Error('copy failed'); });

        await strmMaterializer[method](buildMeta(), dirFn());

        expect(strmMaterializer._downloadFile).toHaveBeenCalledWith('https://i.ytimg.com/vi/abc123DEF45/mqdefault.jpg', posterPath());
      });

      it('swallows a failed thumbnail download', async () => {
        strmMaterializer._downloadFile.mockRejectedValue(new Error('404'));

        await expect(strmMaterializer[method](buildMeta(), dirFn())).resolves.toBeUndefined();
      });
    });

    it('does not download a channel poster for a video with no channel id', async () => {
      await strmMaterializer._ensureChannelPoster(buildMeta({ channel_id: undefined }), path.join(mockRoot, 'Channel'));

      expect(strmMaterializer._downloadFile).not.toHaveBeenCalled();
    });

    describe('_ensureSeriesNfoFiles', () => {
      const paths = { channelDir: '/c', videoDir: '/c/Season 1' };

      it('writes the show and season nfo files', async () => {
        await strmMaterializer._ensureSeriesNfoFiles(buildMeta(), paths, 1, { description: 'About' });

        expect(nfoGenerator.writeShowNfoFile).toHaveBeenCalledWith('/c', { title: 'Some Channel', plot: 'About', channelId: 'UC123' });
        expect(nfoGenerator.writeSeasonNfoFile).toHaveBeenCalledWith('/c/Season 1', { showTitle: 'Some Channel', season: 1 });
      });

      it('uses an empty plot without a channel record', async () => {
        await strmMaterializer._ensureSeriesNfoFiles(buildMeta(), paths, 1, null);

        expect(nfoGenerator.writeShowNfoFile.mock.calls[0][1].plot).toBe('');
      });

      it('does not throw when an nfo write fails', async () => {
        nfoGenerator.writeShowNfoFile.mockImplementation(() => { throw new Error('disk full'); });

        await expect(strmMaterializer._ensureSeriesNfoFiles(buildMeta(), paths, 1, null)).resolves.toBeUndefined();
      });
    });
  });

  describe('_downloadFile', () => {
    let dest;

    beforeEach(() => {
      dest = path.join(mockRoot, 'download.jpg');
    });

    // Fake an http(s).get that answers with `res` (or an error/timeout)
    function respondWith(mod, { res, error, timeout } = {}) {
      mod.get.mockImplementation((_url, _opts, cb) => {
        const req = new EventEmitter();
        req.destroy = jest.fn();
        setImmediate(() => {
          if (error) req.emit('error', error);
          else if (timeout) req.emit('timeout');
          else cb(res);
        });
        return req;
      });
    }

    const okResponse = (body = 'jpeg-bytes') => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.pipe = (file) => { file.end(body); return file; };
      return res;
    };

    it('downloads over https to the destination', async () => {
      respondWith(https, { res: okResponse('jpeg-bytes') });

      await expect(strmMaterializer._downloadFile('https://i.ytimg.com/x.jpg', dest)).resolves.toBe(dest);

      expect(fs.readFileSync(dest, 'utf8')).toBe('jpeg-bytes');
    });

    it('uses plain http for an http url', async () => {
      respondWith(http, { res: okResponse() });

      await strmMaterializer._downloadFile('http://example.com/x.jpg', dest);

      expect(http.get).toHaveBeenCalled();
      expect(https.get).not.toHaveBeenCalled();
    });

    it('uses a 30 second request timeout', async () => {
      respondWith(https, { res: okResponse() });

      await strmMaterializer._downloadFile('https://i.ytimg.com/x.jpg', dest);

      expect(https.get.mock.calls[0][1]).toEqual({ timeout: 30000 });
    });

    it('follows a redirect', async () => {
      const redirect = new EventEmitter();
      redirect.statusCode = 302;
      redirect.headers = { location: 'https://cdn.example/final.jpg' };
      let call = 0;
      https.get.mockImplementation((url, _opts, cb) => {
        const req = new EventEmitter();
        const res = call++ === 0 ? redirect : okResponse('final');
        setImmediate(() => cb(res));
        return req;
      });

      await strmMaterializer._downloadFile('https://i.ytimg.com/x.jpg', dest);

      expect(https.get.mock.calls[1][0]).toBe('https://cdn.example/final.jpg');
    });

    it('rejects a non-200 response', async () => {
      const res = new EventEmitter();
      res.statusCode = 404;
      res.headers = {};
      respondWith(https, { res });

      await expect(strmMaterializer._downloadFile('https://i.ytimg.com/x.jpg', dest)).rejects.toThrow('HTTP 404');
    });

    it('rejects on a request error', async () => {
      respondWith(https, { error: new Error('ECONNRESET') });

      await expect(strmMaterializer._downloadFile('https://i.ytimg.com/x.jpg', dest)).rejects.toThrow('ECONNRESET');
    });

    it('destroys the request and rejects on timeout', async () => {
      respondWith(https, { timeout: true });

      await expect(strmMaterializer._downloadFile('https://i.ytimg.com/x.jpg', dest)).rejects.toThrow('thumbnail timeout');
    });
  });
});
