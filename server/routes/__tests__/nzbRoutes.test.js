/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nzb-routes-'));
let mockCfg;

jest.mock('../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../modules/configModule', () => ({
  getConfig: jest.fn(() => mockCfg),
  directoryPath: mockRoot,
}));
jest.mock('../../modules/videoSearchModule', () => ({
  searchVideos: jest.fn(),
  attachLocalResolutionHeight: jest.fn(),
  SearchCanceledError: class SearchCanceledError extends Error {},
  SearchTimeoutError: class SearchTimeoutError extends Error {},
}));
jest.mock('../../modules/nzbThumbnailProbe', () => ({ fillUnknownDefinitions: jest.fn() }));
jest.mock('../../modules/nzbDiagnosticLog', () => ({
  resolveLogLimit: jest.fn(() => 20),
  recordDiagnosticEvent: jest.fn().mockResolvedValue(undefined),
  getDiagnosticEvents: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../modules/jobModule', () => ({
  getRunningJobs: jest.fn(),
  getJob: jest.fn(),
  saveJobOnly: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../modules/downloadModule', () => ({
  doSpecificDownloads: jest.fn(),
  getCurrentActivitySnapshot: jest.fn(),
}));
jest.mock('../../modules/archiveModule', () => ({ removeVideoFromArchive: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../modules/filesystem', () => ({ cleanupEmptyParents: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../models', () => ({
  JobVideo: { destroy: jest.fn(), findAll: jest.fn() },
  VideoWatchStatus: { destroy: jest.fn() },
  Job: { findAll: jest.fn() },
}));
jest.mock('../../models/channelvideo', () => ({ findAll: jest.fn() }));
jest.mock('../../models/video', () => ({ findOne: jest.fn(), destroy: jest.fn(), findByPk: jest.fn() }));

const express = require('express');
const request = require('supertest');
const logger = require('../../logger');
const videoSearchModule = require('../../modules/videoSearchModule');
const nzbThumbnailProbe = require('../../modules/nzbThumbnailProbe');
const nzbDiagnosticLog = require('../../modules/nzbDiagnosticLog');
const jobModule = require('../../modules/jobModule');
const jobEventLog = require('../../modules/jobEventLog');
const downloadModule = require('../../modules/downloadModule');
const archiveModule = require('../../modules/archiveModule');
const { cleanupEmptyParents } = require('../../modules/filesystem');
const { JobVideo, VideoWatchStatus, Job } = require('../../models');
const ChannelVideo = require('../../models/channelvideo');
const Video = require('../../models/video');
const createNzbRoutes = require('../nzb');

const API_KEY = 'secret-api-key';
const YT_ID = 'abc123DEF45';

const tvCategory = (overrides = {}) => ({
  name: 'TV',
  subfolder: 'Sonarr',
  mediaMode: 'download',
  searchMode: 'flat',
  importStrategy: 'hardlink',
  newznabCategoryIds: ['5040', '5000'],
  additionalLocalFilter: false,
  excludeTerms: [],
  ...overrides,
});

const baseConfig = (nzb = {}) => ({
  preferredResolution: '1080',
  nzb: { enabled: true, apiKey: API_KEY, categories: [tvCategory()], ...nzb },
});

const buildApp = () => {
  const app = express();
  app.use(createNzbRoutes());
  return app;
};

describe('nzb routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    fs.rmSync(mockRoot, { recursive: true, force: true });
    fs.mkdirSync(mockRoot, { recursive: true });
    mockCfg = baseConfig();
    app = buildApp();

    videoSearchModule.searchVideos.mockResolvedValue([]);
    videoSearchModule.attachLocalResolutionHeight.mockResolvedValue(undefined);
    nzbThumbnailProbe.fillUnknownDefinitions.mockResolvedValue(0);
    nzbDiagnosticLog.resolveLogLimit.mockReturnValue(20);
    nzbDiagnosticLog.recordDiagnosticEvent.mockResolvedValue(undefined);
    jobModule.getRunningJobs.mockReturnValue([]);
    downloadModule.getCurrentActivitySnapshot.mockReturnValue(null);
    ChannelVideo.findAll.mockResolvedValue([]);
    Video.findOne.mockResolvedValue(null);
  });

  afterAll(() => {
    fs.rmSync(mockRoot, { recursive: true, force: true });
  });

  const get = (url) => request(app).get(url);

  describe('API key protection', () => {
    it.each(['/nzb/newznab?t=caps', `/nzb/download/TV/${YT_ID}.nzb`, '/nzb/sab/api?mode=version'])('rejects a request with no key to %s', async (url) => {
      const res = await get(url);

      expect(res.status).toBe(401);
      expect(res.text).toBe('Missing apikey');
    });

    it('rejects a wrong key', async () => {
      const res = await get('/nzb/newznab?t=caps&apikey=nope');

      expect(res.status).toBe(401);
      expect(res.text).toBe('Invalid apikey');
    });

    it('rejects a key of the right length that does not match', async () => {
      const res = await get(`/nzb/newznab?t=caps&apikey=${'x'.repeat(API_KEY.length)}`);

      expect(res.status).toBe(401);
    });

    it('rejects an array-valued key', async () => {
      const res = await get('/nzb/newznab?t=caps&apikey=a&apikey=b');

      expect(res.status).toBe(401);
    });

    it('reports the integration as unavailable when disabled', async () => {
      mockCfg = baseConfig({ enabled: false });

      const res = await get(`/nzb/newznab?t=caps&apikey=${API_KEY}`);

      expect(res.status).toBe(503);
      expect(res.text).toBe('Youtarr NZB integration is not enabled');
    });

    it('reports the integration as unavailable when no key is configured', async () => {
      mockCfg = baseConfig({ apiKey: '' });

      const res = await get('/nzb/newznab?t=caps&apikey=x');

      expect(res.status).toBe(503);
    });

    it('lets a correct key through', async () => {
      const res = await get(`/nzb/newznab?t=caps&apikey=${API_KEY}`);

      expect(res.status).toBe(200);
    });
  });

  describe('GET /nzb/newznab', () => {
    const url = (params = '') => `/nzb/newznab?apikey=${API_KEY}${params}`;

    it('returns the caps document as xml', async () => {
      const res = await get(url('&t=caps'));

      expect(res.type).toBe('application/xml');
      expect(res.text).toContain('<caps>');
    });

    it('is case-insensitive about the search type', async () => {
      const res = await get(url('&t=CAPS'));

      expect(res.text).toContain('<caps>');
    });

    it('lists a configured non-standard category in caps', async () => {
      mockCfg = baseConfig({ categories: [tvCategory({ name: 'Docs', newznabCategoryIds: ['5045'] })] });

      const res = await get(url('&t=caps'));

      expect(res.text).toContain('name="Docs"');
    });

    it('rejects an unsupported search type', async () => {
      const res = await get(url('&t=music'));

      expect(res.status).toBe(400);
      expect(res.text).toContain('code="202"');
    });

    it('rejects a search when no category is configured', async () => {
      mockCfg = baseConfig({ categories: [] });

      const res = await get(url('&t=search&q=cats'));

      expect(res.status).toBe(400);
      expect(res.text).toContain('No category configured');
    });

    describe('RSS mode (blank query)', () => {
      it('serves recent known channel videos', async () => {
        ChannelVideo.findAll.mockResolvedValue([{ youtube_id: 'aaaaaaaaaaa', title: 'Recent One', publishedAt: '2026-01-01T00:00:00Z' }]);

        const res = await get(url('&t=search'));

        expect(res.status).toBe(200);
        expect(res.text).toContain('Recent One [1080p]');
        expect(res.text).toContain('watch?v=aaaaaaaaaaa');
      });

      it('only lists visible, non-removed videos, newest first', async () => {
        await get(url('&t=search&limit=50&offset=10'));

        expect(ChannelVideo.findAll).toHaveBeenCalledWith({
          where: { ignored: false, youtube_removed: false, media_type: 'video' },
          order: [['publishedAt', 'DESC']],
          limit: 50,
          offset: 10,
        });
      });

      it('does not run a live search', async () => {
        await get(url('&t=search'));

        expect(videoSearchModule.searchVideos).not.toHaveBeenCalled();
      });

      it('answers 500 with an error document when the lookup fails', async () => {
        ChannelVideo.findAll.mockRejectedValue(new Error('db down'));

        const res = await get(url('&t=search'));

        expect(res.status).toBe(500);
        expect(res.text).toContain('Search failed');
      });
    });

    describe('search', () => {
      const result = (id, title, extra = {}) => ({ youtubeId: id, title, duration: 600, ...extra });

      it('searches with the query and tags the origin', async () => {
        await get(url('&t=search&q=my+show'));

        expect(videoSearchModule.searchVideos).toHaveBeenCalledWith('my show', 25, { origin: 'nzb', searchId: expect.any(String) });
      });

      it('remembers the real title and channel of each result for the video/events log', async () => {
        videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Match One', { channelName: 'Some Channel' })]);

        await get(url('&t=search&q=cats'));

        expect(jobEventLog.rememberVideo).toHaveBeenCalledWith('aaaaaaaaaaa', { title: 'Match One', channelName: 'Some Channel' });
      });

      it('remembers every result offered, not just the first', async () => {
        videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'One'), result('bbbbbbbbbbb', 'Two')]);

        await get(url('&t=search&q=cats'));

        expect(jobEventLog.rememberVideo).toHaveBeenCalledTimes(2);
      });

      it('remembers nothing when the search finds nothing', async () => {
        videoSearchModule.searchVideos.mockResolvedValue([]);

        await get(url('&t=search&q=cats'));

        expect(jobEventLog.rememberVideo).not.toHaveBeenCalled();
      });

      it('returns the results as a feed', async () => {
        videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Match One')]);

        const res = await get(url('&t=search&q=match'));

        expect(res.status).toBe(200);
        expect(res.text).toContain('<title>Match One [1080p]</title>');
      });

      it.each([
        ['', 25],
        ['&limit=abc', 25],
        ['&limit=0', 25],
        ['&limit=12', 10],
        ['&limit=40', 50],
        ['&limit=500', 100],
      ])('asks for %s -> %i results', async (param, expected) => {
        await get(url(`&t=search&q=x${param}`));

        expect(videoSearchModule.searchVideos.mock.calls[0][1]).toBe(expected);
      });

      it('fetches enough raw results to slice a later page', async () => {
        await get(url('&t=search&q=x&limit=25&offset=30'));

        expect(videoSearchModule.searchVideos.mock.calls[0][1]).toBe(100);
      });

      it('slices the requested page out of the results', async () => {
        videoSearchModule.searchVideos.mockResolvedValue(Array.from({ length: 30 }, (_, i) => result(`id${String(i).padStart(9, '0')}`, `Video ${i}`)));

        const res = await get(url('&t=search&q=video&limit=10&offset=10'));

        expect(res.text).toContain('Video 10 [');
        expect(res.text).toContain('Video 19 [');
        expect(res.text).not.toContain('Video 9 [');
        expect(res.text).not.toContain('Video 20 [');
      });

      it('returns an empty page past the end of the results', async () => {
        videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Only One')]);

        const res = await get(url('&t=search&q=only&offset=50'));

        expect(res.status).toBe(200);
        expect(res.text).not.toContain('<item>');
      });

      it('treats a negative offset as zero', async () => {
        await get(url('&t=search&q=x&offset=-5'));

        expect(videoSearchModule.searchVideos.mock.calls[0][1]).toBe(25);
      });

      it('answers 500 with an error document when the search fails', async () => {
        videoSearchModule.searchVideos.mockRejectedValue(new Error('yt-dlp broke'));

        const res = await get(url('&t=search&q=x'));

        expect(res.status).toBe(500);
        expect(res.text).toContain('Search failed');
      });

      it('picks the category matching the requested Newznab id', async () => {
        mockCfg = baseConfig({ categories: [tvCategory({ name: 'TV', newznabCategoryIds: ['5040'] }), tvCategory({ name: 'Movies', newznabCategoryIds: ['2040'] })] });
        videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'A Movie')]);

        const res = await get(url('&t=movie&q=movie&cat=2040'));

        expect(res.text).toContain('/nzb/download/Movies/');
      });

      it('matches a category from a comma separated list of ids', async () => {
        mockCfg = baseConfig({ categories: [tvCategory({ name: 'TV', newznabCategoryIds: ['5040'] }), tvCategory({ name: 'Movies', newznabCategoryIds: ['2040'] })] });
        videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'A Movie')]);

        const res = await get(url('&t=search&q=movie&cat=2040,2000'));

        expect(res.text).toContain('/nzb/download/Movies/');
      });

      it('falls back to the first category for an unknown id', async () => {
        videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Any')]);

        const res = await get(url('&t=search&q=any&cat=9999'));

        expect(res.text).toContain('/nzb/download/TV/');
      });

      describe('tvsearch season and episode', () => {
        it.each([['season=abc'], ['season=1&ep=xyz']])('rejects an invalid number (%s)', async (params) => {
          const res = await get(url(`&t=tvsearch&q=show&${params}`));

          expect(res.status).toBe(400);
          expect(res.text).toContain('code="201"');
        });

        it('appends SxxExx in episode search mode', async () => {
          mockCfg = baseConfig({ categories: [tvCategory({ searchMode: 'episode' })] });

          await get(url('&t=tvsearch&q=show&season=2&ep=5'));

          expect(videoSearchModule.searchVideos.mock.calls[0][0]).toBe('show S02E05');
        });

        it('appends only the season when there is no episode', async () => {
          mockCfg = baseConfig({ categories: [tvCategory({ searchMode: 'episode' })] });

          await get(url('&t=tvsearch&q=show&season=2'));

          expect(videoSearchModule.searchVideos.mock.calls[0][0]).toBe('show S02');
        });

        it('leaves the query alone in flat search mode', async () => {
          await get(url('&t=tvsearch&q=show&season=2&ep=5'));

          expect(videoSearchModule.searchVideos.mock.calls[0][0]).toBe('show');
        });

        it('carries the real season and episode into the download links', async () => {
          videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Ep')]);

          const res = await get(url('&t=tvsearch&q=show&season=2&ep=5'));

          expect(res.text).toContain('season=2&amp;ep=5');
        });

        it('does not carry a lone season into the links', async () => {
          videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Ep')]);

          const res = await get(url('&t=tvsearch&q=show&season=2'));

          expect(res.text).not.toContain('season=');
        });

        it('ignores season and episode for a plain search', async () => {
          await get(url('&t=search&q=show&season=abc'));

          expect(videoSearchModule.searchVideos).toHaveBeenCalled();
        });
      });

      describe('additional local filter', () => {
        const filteredCategory = (extra = {}) => tvCategory({ additionalLocalFilter: true, ...extra });

        beforeEach(() => {
          mockCfg = baseConfig({ categories: [filteredCategory()] });
          videoSearchModule.searchVideos.mockResolvedValue([
            result('aaaaaaaaaaa', 'My Show Episode'),
            result('bbbbbbbbbbb', 'Totally Unrelated'),
          ]);
        });

        it('drops results whose titles miss the search terms', async () => {
          const res = await get(url('&t=search&q=my+show'));

          expect(res.text).toContain('My Show Episode');
          expect(res.text).not.toContain('Totally Unrelated');
        });

        it('drops results matching an excluded term', async () => {
          mockCfg = baseConfig({ categories: [filteredCategory({ excludeTerms: ['episode'] })] });

          const res = await get(url('&t=search&q=my+show'));

          expect(res.text).not.toContain('My Show Episode');
        });

        it('records every candidate verdict in the search trace', async () => {
          await get(url('&t=search&q=my+show'));

          const [type, trace] = nzbDiagnosticLog.recordDiagnosticEvent.mock.calls[0];
          expect(type).toBe('trace');
          expect(trace.additionalLocalFilterEnabled).toBe(true);
          expect(trace.items.map((i) => [i.youtubeId, i.kept, i.reason])).toEqual([
            ['aaaaaaaaaaa', true, null],
            ['bbbbbbbbbbb', false, 'keyword'],
          ]);
        });

        it('requires a season/episode code only in episode search mode', async () => {
          mockCfg = baseConfig({ categories: [filteredCategory({ searchMode: 'episode' })] });

          const res = await get(url('&t=tvsearch&q=my+show&season=1&ep=2'));

          expect(res.text).not.toContain('My Show Episode');
        });

        it('does not require a season/episode code in flat search mode', async () => {
          const res = await get(url('&t=tvsearch&q=my+show&season=1&ep=2'));

          expect(res.text).toContain('My Show Episode');
        });
      });

      describe('search trace', () => {
        it('records the search details', async () => {
          videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Match')]);

          await get(url('&t=search&q=match&limit=10'));

          const [, trace, max] = nzbDiagnosticLog.recordDiagnosticEvent.mock.calls[0];
          expect(max).toBe(20);
          expect(trace).toMatchObject({
            categoryName: 'TV',
            searchType: 'search',
            query: 'match',
            newquery: null,
            season: null,
            ep: null,
            additionalLocalFilterEnabled: false,
            offset: 0,
            limit: 10,
            configuredHeightTier: 1080,
          });
        });

        it('records the adjusted query when it differs', async () => {
          mockCfg = baseConfig({ categories: [tvCategory({ searchMode: 'episode' })] });

          await get(url('&t=tvsearch&q=show&season=2&ep=5'));

          expect(nzbDiagnosticLog.recordDiagnosticEvent.mock.calls[0][1]).toMatchObject({ query: 'show', newquery: 'show S02E05', season: 2, ep: 5 });
        });

        it('shares its search id with the search call', async () => {
          await get(url('&t=search&q=x'));

          const searchId = videoSearchModule.searchVideos.mock.calls[0][2].searchId;
          expect(nzbDiagnosticLog.recordDiagnosticEvent.mock.calls[0][1].searchId).toBe(searchId);
        });

        it('attaches resolution info to the kept items on the returned page', async () => {
          videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Match', { definition: 'sd' })]);

          await get(url('&t=search&q=match'));

          const item = nzbDiagnosticLog.recordDiagnosticEvent.mock.calls[0][1].items[0];
          expect(item).toMatchObject({ definition: 'sd', effectiveHeightTier: 480, resolutionSource: 'api' });
        });

        it('leaves resolution info off items that fell outside the page', async () => {
          videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'One'), result('bbbbbbbbbbb', 'Two')]);

          await get(url('&t=search&q=x&limit=10&offset=1'));

          const [first, second] = nzbDiagnosticLog.recordDiagnosticEvent.mock.calls[0][1].items;
          expect(first.effectiveHeightTier).toBeUndefined();
          expect(second.effectiveHeightTier).toBe(1080);
        });
      });

      describe('resolution detection', () => {
        it('looks up known local resolutions and probes the rest using the configured checks', async () => {
          mockCfg = baseConfig({ resolutionDetection: { fixed: true, thumb: false, extract: true } });
          videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Match')]);

          await get(url('&t=search&q=match'));

          expect(videoSearchModule.attachLocalResolutionHeight).toHaveBeenCalled();
          expect(nzbThumbnailProbe.fillUnknownDefinitions).toHaveBeenCalledWith(expect.any(Array), { useThumb: false, useExtract: true });
        });

        it('caps a previously downloaded low resolution video', async () => {
          videoSearchModule.searchVideos.mockResolvedValue([result('aaaaaaaaaaa', 'Match', { localResolutionHeight: 360 })]);

          const res = await get(url('&t=search&q=match'));

          expect(res.text).toContain('Match [360p]');
        });
      });
    });
  });

  describe('GET /nzb/download/:categoryName/:file', () => {
    const dl = (file, params = '') => get(`/nzb/download/TV/${file}?apikey=${API_KEY}${params}`);

    it('serves a synthetic nzb for the video', async () => {
      const res = await dl(`${YT_ID}.nzb`, '&title=My%20Video');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/x-nzb');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${YT_ID}.nzb"`);
      expect(res.text).toContain(`<meta type="youtubeId">${YT_ID}</meta>`);
      expect(res.text).toContain('My Video');
    });

    it('accepts an id with no extension', async () => {
      const res = await dl(YT_ID);

      expect(res.status).toBe(200);
    });

    it('carries the size estimate into the nzb', async () => {
      const res = await dl(`${YT_ID}.nzb`, '&size=5000');

      expect(res.text).toContain('<meta type="size">5000</meta>');
    });

    it('titles the file after the id when no title is given', async () => {
      const res = await dl(`${YT_ID}.nzb`);

      expect(res.text).toContain(`${YT_ID} [${YT_ID}]`);
    });

    it('includes season and episode when given', async () => {
      const res = await dl(`${YT_ID}.nzb`, '&season=2&ep=5');

      expect(res.text).toContain('<meta type="season">2</meta>');
      expect(res.text).toContain('<meta type="episode">5</meta>');
    });

    it('drops season and episode that are not numbers', async () => {
      const res = await dl(`${YT_ID}.nzb`, '&season=x&ep=y');

      expect(res.text).not.toContain('type="season"');
    });

    it.each(['ab', 'bad!id!bad', 'x'.repeat(30)])('rejects the invalid id %s', async (id) => {
      const res = await dl(`${id}.nzb`);

      expect(res.status).toBe(400);
      expect(res.text).toBe('Invalid video id');
    });
  });

  describe('/nzb/sab/api', () => {
    const sab = (params = '') => `/nzb/sab/api?apikey=${API_KEY}${params}`;

    it('reports its version', async () => {
      const res = await get(sab('&mode=version'));

      expect(res.body).toEqual({ version: '1.0.0' });
    });

    it('lists the categories with the mandatory catch-all first', async () => {
      const res = await get(sab('&mode=get_config'));

      expect(res.body.config.categories).toEqual([
        { name: '*', order: 0, pp: '3', script: 'None', dir: '', newzbin: '', priority: 0 },
        { name: 'TV', order: 1, pp: '', script: 'None', dir: 'Sonarr', newzbin: '', priority: 0 },
      ]);
    });

    it('uses an empty dir for a category without a subfolder', async () => {
      mockCfg = baseConfig({ categories: [tvCategory({ subfolder: null })] });

      const res = await get(sab('&mode=get_config'));

      expect(res.body.config.categories[1].dir).toBe('');
    });

    it('answers 200 with an error for an unsupported mode', async () => {
      const res = await get(sab('&mode=shutdown'));

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: false, error: 'Unsupported mode: shutdown' });
    });

    it('accepts POST as well as GET', async () => {
      const res = await request(app).post(sab('&mode=version'));

      expect(res.body).toEqual({ version: '1.0.0' });
    });

    describe('mode=addfile', () => {
      const nzbFile = (overrides = {}) => Buffer.from(
        `<nzb><head><meta type="youtubeId">${overrides.id || YT_ID}</meta><meta type="category">${overrides.category || 'TV'}</meta>`
        + `<meta type="nzbName">${overrides.name || 'My Video [abc]'}</meta>${overrides.extra || ''}</head></nzb>`
      );
      const upload = (buffer) => request(app).post(sab('&mode=addfile')).attach('name', buffer, 'release.nzb');

      beforeEach(() => {
        downloadModule.doSpecificDownloads.mockResolvedValue(42);
      });

      it('rejects a request with no file, still answering 200', async () => {
        const res = await request(app).post(sab('&mode=addfile'));

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: false, error: 'No NZB file uploaded' });
      });

      it('rejects an nzb it cannot read a video id from', async () => {
        const res = await upload(Buffer.from('<nzb></nzb>'));

        expect(res.body).toEqual({ status: false, error: 'Could not recover video id from NZB' });
      });

      it('rejects an unknown category', async () => {
        mockCfg = baseConfig({ categories: [] });

        const res = await upload(nzbFile({ category: 'Nope' }));

        expect(res.body.status).toBe(false);
        expect(res.body.error).toContain('Unknown category');
      });

      it('queues the download and returns its job id', async () => {
        const res = await upload(nzbFile());

        expect(res.body).toEqual({ status: true, nzo_ids: ['42'] });
      });

      it('downloads the video with the category settings', async () => {
        await upload(nzbFile());

        const body = downloadModule.doSpecificDownloads.mock.calls[0][0].body;
        expect(body.urls).toEqual([`https://www.youtube.com/watch?v=${YT_ID}`]);
        expect(body.overrideSettings).toMatchObject({ subfolder: 'Sonarr', mediaMode: 'download', skipMediaSidecarFiles: true });
        expect(body.nzb).toEqual({ categoryName: 'TV', youtubeId: YT_ID, nzbName: 'My Video [abc]', importStrategy: 'hardlink', estimatedBytes: null });
      });

      it('keeps the size estimate the nzb carries', async () => {
        await upload(nzbFile({ extra: '<meta type="size">5000</meta>' }));

        expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.nzb.estimatedBytes).toBe(5000);
      });

      it('applies the real season and episode when both are present', async () => {
        await upload(nzbFile({ extra: '<meta type="season">3</meta><meta type="episode">8</meta>' }));

        expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.overrideSettings).toMatchObject({ seriesSeasonOverride: 3, seriesEpisodeOverride: 8 });
      });

      it('does not apply a lone season', async () => {
        await upload(nzbFile({ extra: '<meta type="season">3</meta>' }));

        expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.overrideSettings.seriesSeasonOverride).toBeUndefined();
      });

      it('uses the category media mode and import strategy', async () => {
        mockCfg = baseConfig({ categories: [tvCategory({ mediaMode: 'strm', importStrategy: 'untracked', subfolder: null })] });

        await upload(nzbFile());

        const body = downloadModule.doSpecificDownloads.mock.calls[0][0].body;
        expect(body.overrideSettings).toMatchObject({ mediaMode: 'strm', subfolder: null });
        expect(body.nzb.importStrategy).toBe('untracked');
      });

      it('forces the grab-requested event untracked for an untracked-strategy category', async () => {
        mockCfg = baseConfig({ categories: [tvCategory({ importStrategy: 'untracked' })] });

        await upload(nzbFile());

        const call = jobEventLog.record.mock.calls.find(([type]) => type === 'nzb.grab_requested');
        expect(call[1].isTracked).toBe(false);
      });

      it('does not force the grab-requested event untracked for a hardlink-strategy category', async () => {
        await upload(nzbFile());

        const call = jobEventLog.record.mock.calls.find(([type]) => type === 'nzb.grab_requested');
        expect(call[1].isTracked).toBeUndefined();
      });

      it('answers 200 with an error when enqueueing fails', async () => {
        downloadModule.doSpecificDownloads.mockRejectedValue(new Error('queue full'));

        const res = await upload(nzbFile());

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: false, error: 'queue full' });
      });
    });

    describe('mode=queue', () => {
      const activeJob = (overrides = {}) => ({
        id: 7,
        status: 'In Progress',
        data: { nzb: { nzbName: 'Release One', categoryName: 'TV' } },
        ...overrides,
      });

      it('is empty and idle with no NZB jobs', async () => {
        const res = await get(sab('&mode=queue'));

        expect(res.body.queue).toMatchObject({ status: 'Idle', noofslots: 0, slots: [] });
      });

      it('lists only pending and in-progress NZB jobs', async () => {
        jobModule.getRunningJobs.mockReturnValue([
          activeJob(),
          activeJob({ id: 8, status: 'Pending' }),
          activeJob({ id: 9, status: 'Complete' }),
          { id: 10, status: 'In Progress', data: {} },
        ]);

        const res = await get(sab('&mode=queue'));

        expect(res.body.queue.slots.map((s) => [s.nzo_id, s.status])).toEqual([['7', 'Downloading'], ['8', 'Queued']]);
      });

      it('is downloading while any job is', async () => {
        jobModule.getRunningJobs.mockReturnValue([activeJob()]);

        const res = await get(sab('&mode=queue'));

        expect(res.body.queue.status).toBe('Downloading');
      });

      it('reports the live progress of the job that is running', async () => {
        jobModule.getRunningJobs.mockReturnValue([activeJob()]);
        downloadModule.getCurrentActivitySnapshot.mockReturnValue({
          jobId: 7,
          activity: { progress: { totalBytes: 10 * 1024 * 1024, downloadedBytes: 4 * 1024 * 1024, percent: 40.7, etaSeconds: 3725 } },
        });

        const res = await get(sab('&mode=queue'));

        expect(res.body.queue.slots[0]).toMatchObject({ mb: 10, mbleft: 6, percentage: 40, timeleft: '1:02:05', filename: 'Release One', cat: 'TV' });
      });

      it('reports the size estimate before the real size is known', async () => {
        jobModule.getRunningJobs.mockReturnValue([activeJob({ data: { nzb: { nzbName: 'R', estimatedBytes: 10 * 1024 * 1024 } } })]);

        const res = await get(sab('&mode=queue'));

        expect(res.body.queue.slots[0]).toMatchObject({ mb: 10, mbleft: 10, percentage: 0 });
      });

      it('reports the real size over the estimate once it is known', async () => {
        jobModule.getRunningJobs.mockReturnValue([activeJob({ data: { nzb: { nzbName: 'R', estimatedBytes: 99 * 1024 * 1024 } } })]);
        downloadModule.getCurrentActivitySnapshot.mockReturnValue({
          jobId: 7,
          activity: { progress: { totalBytes: 10 * 1024 * 1024, downloadedBytes: 4 * 1024 * 1024, percent: 40 } },
        });

        const res = await get(sab('&mode=queue'));

        expect(res.body.queue.slots[0]).toMatchObject({ mb: 10, mbleft: 6 });
      });

      it('reports zero progress for a job that is not the running one', async () => {
        jobModule.getRunningJobs.mockReturnValue([activeJob({ id: 8 })]);
        downloadModule.getCurrentActivitySnapshot.mockReturnValue({ jobId: 7, activity: { progress: { totalBytes: 100, percent: 50 } } });

        const res = await get(sab('&mode=queue'));

        expect(res.body.queue.slots[0]).toMatchObject({ mb: 0, percentage: 0, timeleft: '0:00:00' });
      });

      it('falls back to the youtarr category name', async () => {
        jobModule.getRunningJobs.mockReturnValue([activeJob({ data: { nzb: { nzbName: 'X' } } })]);

        const res = await get(sab('&mode=queue'));

        expect(res.body.queue.slots[0].cat).toBe('youtarr');
      });

      it('still answers when the activity snapshot throws', async () => {
        jobModule.getRunningJobs.mockReturnValue([activeJob()]);
        downloadModule.getCurrentActivitySnapshot.mockImplementation(() => { throw new Error('no snapshot'); });

        const res = await get(sab('&mode=queue'));

        expect(res.status).toBe(200);
        expect(res.body.queue.slots).toHaveLength(1);
      });
    });

    describe('mode=history', () => {
      let libraryFile;

      const historyJob = (overrides = {}) => ({
        id: 11,
        status: 'Complete',
        output: 'done',
        timeInitiated: '2026-01-01T00:00:00Z',
        data: {
          nzb: { nzbName: 'Release One', categoryName: 'TV', youtubeId: YT_ID },
          videos: [{ id: 5, youtubeId: YT_ID, filePath: libraryFile, fileSize: 2048 }],
        },
        ...overrides,
      });

      beforeEach(() => {
        fs.mkdirSync(path.join(mockRoot, 'library'), { recursive: true });
        libraryFile = path.join(mockRoot, 'library', 'video.mp4');
        fs.writeFileSync(libraryFile, 'video-bytes');
      });

      it('lists finished NZB jobs and skips active, removed and non-NZB ones', async () => {
        const removed = historyJob({ id: 12 });
        removed.data.nzb.historyRemoved = true;
        jobModule.getRunningJobs.mockReturnValue([
          historyJob(),
          historyJob({ id: 13, status: 'In Progress' }),
          removed,
          { id: 14, status: 'Complete', data: {} },
        ]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots.map((s) => s.nzo_id)).toEqual(['11']);
      });

      it.each(['Complete', 'Complete with Warnings'])('reports a %s job as completed', async (status) => {
        jobModule.getRunningJobs.mockReturnValue([historyJob({ status })]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0]).toMatchObject({ status: 'Completed', fail_message: '', bytes: 2048, downloaded: 2048, category: 'TV', name: 'Release One', nzb_name: 'Release One.nzb' });
      });

      it('formats the size', async () => {
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].size).toBe('2.00 KB');
      });

      it('stages a hardlink for the hardlink strategy and reports that path', async () => {
        const job = historyJob();
        jobModule.getRunningJobs.mockReturnValue([job]);

        const res = await get(sab('&mode=history'));

        const staged = path.join(mockRoot, '.nzb_staging', 'TV', 'video.mp4');
        expect(res.body.history.slots[0].storage).toBe(staged);
        expect(res.body.history.slots[0].path).toBe(staged);
        expect(fs.readFileSync(staged, 'utf8')).toBe('video-bytes');
        expect(job.data.nzb.stagedPath).toBe(staged);
      });

      it('reuses an existing staged file on later polls', async () => {
        const job = historyJob();
        jobModule.getRunningJobs.mockReturnValue([job]);
        await get(sab('&mode=history'));
        const linkSpy = jest.spyOn(fs, 'linkSync');

        await get(sab('&mode=history'));

        expect(linkSpy).not.toHaveBeenCalled();
      });

      it('notes when the staged file has since been imported away and stages again', async () => {
        const job = historyJob();
        jobModule.getRunningJobs.mockReturnValue([job]);
        await get(sab('&mode=history'));
        fs.rmSync(job.data.nzb.stagedPath);

        await get(sab('&mode=history'));

        expect(job.data.nzb.importedAt).toEqual(expect.any(Number));
        expect(fs.existsSync(job.data.nzb.stagedPath)).toBe(true);
      });

      it('falls back to a real copy across filesystems', async () => {
        jest.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); });
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        await get(sab('&mode=history'));

        expect(fs.readFileSync(path.join(mockRoot, '.nzb_staging', 'TV', 'video.mp4'), 'utf8')).toBe('video-bytes');
      });

      it('tolerates another poll having already created the staged file', async () => {
        jest.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); });
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].status).toBe('Completed');
      });

      it('reports the real library path when staging fails outright', async () => {
        jest.spyOn(fs, 'linkSync').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].storage).toBe(libraryFile);
        expect(logger.warn).toHaveBeenCalled();
      });

      it('reports the real file directly for the untracked strategy', async () => {
        mockCfg = baseConfig({ categories: [tvCategory({ importStrategy: 'untracked' })] });
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].storage).toBe(libraryFile);
        expect(fs.existsSync(path.join(mockRoot, '.nzb_staging'))).toBe(false);
      });

      it('reports an empty path when the library file is missing', async () => {
        fs.rmSync(libraryFile);
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].storage).toBe('');
      });

      it('swaps the library prefix for the path Sonarr/Radarr sees', async () => {
        mockCfg = baseConfig({ remoteBasePath: '/data/' , categories: [tvCategory({ importStrategy: 'untracked' })] });
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].storage).toBe(`/data${libraryFile.slice(mockRoot.length)}`);
      });

      it('leaves a path outside the library alone when remapping', async () => {
        mockCfg = baseConfig({ remoteBasePath: '/data', categories: [tvCategory({ importStrategy: 'untracked' })] });
        const outside = path.join(os.tmpdir(), 'elsewhere.mp4');
        jobModule.getRunningJobs.mockReturnValue([historyJob({ data: { nzb: { nzbName: 'R', categoryName: 'TV', youtubeId: YT_ID }, videos: [{ id: 5, filePath: outside, fileSize: 1 }] } })]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].storage).toBe(outside);
      });

      it('reports an errored job as failed with its output', async () => {
        jobModule.getRunningJobs.mockReturnValue([historyJob({ status: 'Error', output: 'yt-dlp exploded' })]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0]).toMatchObject({ status: 'Failed', fail_message: 'yt-dlp exploded', storage: '' });
      });

      it('gives a generic failure message for an errored job with no output', async () => {
        jobModule.getRunningJobs.mockReturnValue([historyJob({ status: 'Terminated', output: '' })]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].fail_message).toBe('Failed');
      });

      it('reports a completed job with no video as failed without writing the failed-grab log', async () => {
        const job = historyJob({ data: { nzb: { nzbName: 'R', categoryName: 'TV', youtubeId: YT_ID }, videos: [] } });
        jobModule.getRunningJobs.mockReturnValue([job]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0]).toMatchObject({ status: 'Failed', fail_message: expect.stringContaining('No video file was produced') });
        expect(nzbDiagnosticLog.recordDiagnosticEvent).not.toHaveBeenCalled();
      });

      it('finds an already downloaded video by id when the job has none of its own', async () => {
        Video.findOne.mockResolvedValue({ dataValues: { id: 5, youtubeId: YT_ID, filePath: libraryFile, fileSize: 10 } });
        jobModule.getRunningJobs.mockReturnValue([historyJob({ id: 99, data: { nzb: { nzbName: 'R', categoryName: 'TV', youtubeId: YT_ID }, videos: [] } })]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].status).toBe('Completed');
      });

      it('treats a failed video lookup as no video', async () => {
        Video.findOne.mockRejectedValue(new Error('db down'));
        jobModule.getRunningJobs.mockReturnValue([historyJob({ id: 98, data: { nzb: { nzbName: 'R', categoryName: 'TV', youtubeId: YT_ID }, videos: [] } })]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history.slots[0].status).toBe('Failed');
      });

      it('summarises the slot count', async () => {
        jobModule.getRunningJobs.mockReturnValue([historyJob()]);

        const res = await get(sab('&mode=history'));

        expect(res.body.history).toMatchObject({ noofslots: 1, ppslots: 0 });
      });

      describe('deleting entries', () => {
        beforeEach(() => {
          mockCfg = baseConfig({ categories: [tvCategory({ importStrategy: 'untracked' })] });
          JobVideo.destroy.mockResolvedValue(1);
          VideoWatchStatus.destroy.mockResolvedValue(0);
          Video.destroy.mockResolvedValue(1);
        });

        it('removes the entries and answers ok', async () => {
          const job = historyJob();
          jobModule.getJob.mockReturnValue(job);

          const res = await get(sab('&mode=history&name=delete&value=11'));

          expect(res.body).toEqual({ status: true });
          expect(job.data.nzb.historyRemoved).toBe(true);
        });

        it('accepts several comma separated ids', async () => {
          jobModule.getJob.mockReturnValue(null);

          const res = await get(sab('&mode=history&name=delete&value=1,%202,,3'));

          expect(res.body).toEqual({ status: true });
          expect(jobModule.getJob.mock.calls.map((c) => c[0])).toEqual(['1', '2', '3']);
        });

        it('is case-insensitive about the delete keyword', async () => {
          jobModule.getJob.mockReturnValue(null);

          const res = await get(sab('&mode=history&name=DELETE&value=1'));

          expect(res.body).toEqual({ status: true });
        });
      });
    });
  });

  describe('getRecentSearchTraces / getRecentFailedGrabs', () => {
    it('reads traces with the configured limit', async () => {
      nzbDiagnosticLog.resolveLogLimit.mockReturnValue(7);
      nzbDiagnosticLog.getDiagnosticEvents.mockResolvedValue([{ query: 'x' }]);

      await expect(createNzbRoutes.getRecentSearchTraces()).resolves.toEqual([{ query: 'x' }]);
      expect(nzbDiagnosticLog.getDiagnosticEvents).toHaveBeenCalledWith('trace', 7);
    });

    it('reads failed grabs with the configured limit', async () => {
      nzbDiagnosticLog.resolveLogLimit.mockReturnValue(3);
      nzbDiagnosticLog.getDiagnosticEvents.mockResolvedValue([]);

      await createNzbRoutes.getRecentFailedGrabs();

      expect(nzbDiagnosticLog.resolveLogLimit).toHaveBeenCalledWith(mockCfg, 'failedGrabs');
      expect(nzbDiagnosticLog.getDiagnosticEvents).toHaveBeenCalledWith('failedGrab', 3);
    });
  });

  describe('getNzbJobsSnapshot', () => {
    it('lists active and finished NZB jobs', async () => {
      jobModule.getRunningJobs.mockReturnValue([
        { id: 1, status: 'In Progress', data: { nzb: { categoryName: 'TV', nzbName: 'Active' } } },
        { id: 2, status: 'Pending', data: { nzb: { categoryName: null, nzbName: null } } },
        { id: 3, status: 'Error', data: { nzb: { categoryName: 'TV', nzbName: 'Broken' } } },
        { id: 4, status: 'Complete', data: { nzb: { categoryName: 'TV', nzbName: 'Done', youtubeId: 'zzzzzzzzzzz', }, videos: [{ filePath: '/x', fileSize: 500 }] } },
      ]);

      const snapshot = await createNzbRoutes.getNzbJobsSnapshot();

      expect(snapshot.active.map((a) => [a.jobId, a.status, a.categoryName, a.nzbName])).toEqual([['1', 'Downloading', 'TV', 'Active'], ['2', 'Queued', null, null]]);
      expect(snapshot.history.map((h) => [h.jobId, h.status, h.bytes])).toEqual([['3', 'Failed', 0], ['4', 'Completed', 500]]);
    });

    it('marks and fills in the job that is currently running', async () => {
      jobModule.getRunningJobs.mockReturnValue([{ id: 1, status: 'In Progress', data: { nzb: { categoryName: 'TV', nzbName: 'Active' } } }]);
      downloadModule.getCurrentActivitySnapshot.mockReturnValue({ jobId: 1, activity: { progress: { percent: 55.9, etaSeconds: 30, totalBytes: 100, downloadedBytes: 50 } } });

      const snapshot = await createNzbRoutes.getNzbJobsSnapshot();

      expect(snapshot.active[0]).toEqual({ jobId: '1', isCurrent: true, status: 'Downloading', categoryName: 'TV', nzbName: 'Active', percent: 55, etaSeconds: 30, totalBytes: 100, downloadedBytes: 50 });
    });

    it('excludes history the client has removed', async () => {
      jobModule.getRunningJobs.mockReturnValue([{ id: 3, status: 'Error', data: { nzb: { historyRemoved: true } } }]);

      const snapshot = await createNzbRoutes.getNzbJobsSnapshot();

      expect(snapshot.history).toEqual([]);
    });
  });

  describe('computeNzbStatusDetail', () => {
    let staged;
    const detail = (nzb = {}, status = 'Complete', videos) => createNzbRoutes.computeNzbStatusDetail({
      id: 1,
      status,
      data: { nzb: { categoryName: 'TV', youtubeId: YT_ID, ...nzb }, videos: videos || [{ id: 5, filePath: '/lib/x.mp4' }] },
    });

    beforeEach(() => {
      staged = path.join(mockRoot, 'staged.mp4');
    });

    it.each([
      ['a non-NZB job', () => createNzbRoutes.computeNzbStatusDetail({ status: 'Complete', data: {} })],
      ['a pending job', () => detail({}, 'Pending')],
      ['an in-progress job', () => detail({}, 'In Progress')],
      ['an errored job', () => detail({}, 'Error')],
      ['a terminated job', () => detail({}, 'Terminated')],
      ['no job', () => createNzbRoutes.computeNzbStatusDetail(null)],
    ])('is null for %s', async (_label, run) => {
      await expect(run()).resolves.toBeNull();
    });

    it('reports a completed job with no video as failed', async () => {
      await expect(detail({}, 'Complete', [])).resolves.toBe('Failed - no video produced');
    });

    describe('hardlink strategy', () => {
      it('is awaiting import by default', async () => {
        await expect(detail()).resolves.toBe('Downloaded - awaiting Sonarr/Radarr import');
      });

      it('is imported once the staged file has gone', async () => {
        await expect(detail({ stagedPath: staged })).resolves.toBe('Imported by Sonarr/Radarr');
      });

      it('is still awaiting import while the staged file exists', async () => {
        fs.writeFileSync(staged, 'x');

        await expect(detail({ stagedPath: staged })).resolves.toBe('Downloaded - awaiting Sonarr/Radarr import');
      });

      it('includes the import time when it is known', async () => {
        await expect(detail({ importedAt: new Date(2026, 0, 1, 10, 30, 5, 123).getTime() })).resolves.toBe('Imported by Sonarr/Radarr at 10:30:05.123');
      });

      it('says the history was cleared after an import', async () => {
        await expect(detail({ importedAt: 1, historyRemoved: true })).resolves.toMatch(/^Imported by Sonarr\/Radarr \(history cleared( at [\d:.]+)?\)$/);
      });

      it('says a video removed from history but not imported is still in the library', async () => {
        await expect(detail({ historyRemoved: true })).resolves.toBe('Removed from Sonarr/Radarr history (still in Youtarr library)');
      });
    });

    describe('untracked strategy', () => {
      beforeEach(() => {
        mockCfg = baseConfig({ categories: [tvCategory({ importStrategy: 'untracked' })] });
      });

      it('is awaiting import by default', async () => {
        await expect(detail()).resolves.toBe('Downloaded - awaiting Sonarr/Radarr import');
      });

      it('is removed from the library once untracked', async () => {
        await expect(detail({ untracked: true })).resolves.toBe('Imported by Sonarr/Radarr - removed from Youtarr library');
      });

      it('includes the time it was untracked', async () => {
        await expect(detail({ untracked: true, untrackedAt: new Date(2026, 0, 1, 9, 5, 3, 7).getTime() })).resolves.toBe('Imported by Sonarr/Radarr - removed from Youtarr library at 09:05:03.007');
      });

      it('flags a failed untrack after the history was removed', async () => {
        await expect(detail({ historyRemoved: true })).resolves.toBe('Removed from Sonarr/Radarr history - untrack failed, check server logs');
      });

      it('prefers the strategy snapshotted on the job over the live category', async () => {
        mockCfg = baseConfig({ categories: [tvCategory({ importStrategy: 'hardlink' })] });

        await expect(detail({ importStrategy: 'untracked', untracked: true })).resolves.toContain('removed from Youtarr library');
      });
    });
  });

  describe('reconcileMovedUntrackedVideo', () => {
    const videoRow = { id: 5, youtubeId: YT_ID, filePath: path.join(mockRoot, 'lib', 'x.mp4') };

    beforeEach(() => {
      mockCfg = baseConfig({ categories: [tvCategory({ importStrategy: 'untracked' })] });
      JobVideo.findAll.mockResolvedValue([{ job_id: 'j1' }]);
      Job.findAll.mockResolvedValue([{ id: 'j1', aux_data: JSON.stringify({ nzb: { categoryName: 'TV' } }) }]);
      JobVideo.destroy.mockResolvedValue(1);
      VideoWatchStatus.destroy.mockResolvedValue(0);
      Video.destroy.mockResolvedValue(1);
      Video.findByPk.mockResolvedValue(null);
      jobModule.getJob.mockReturnValue(null);
    });

    it.each([[null], [{}], [{ id: 0 }]])('does nothing for %p', async (row) => {
      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(row)).resolves.toBe(false);
      expect(JobVideo.findAll).not.toHaveBeenCalled();
    });

    it('does nothing for a video with no job link', async () => {
      JobVideo.findAll.mockResolvedValue([]);

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(false);
    });

    it('leaves the video when none of its jobs came from an NZB grab', async () => {
      Job.findAll.mockResolvedValue([{ id: 'j1', aux_data: JSON.stringify({}) }]);

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(false);
      expect(Video.destroy).not.toHaveBeenCalled();
    });

    it('leaves the video when its category uses the hardlink strategy', async () => {
      mockCfg = baseConfig({ categories: [tvCategory({ importStrategy: 'hardlink' })] });

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(false);
    });

    it('removes the tracking rows and the archive entry', async () => {
      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(true);

      expect(JobVideo.destroy).toHaveBeenCalledWith({ where: { video_id: 5 } });
      expect(VideoWatchStatus.destroy).toHaveBeenCalledWith({ where: { video_id: 5 } });
      expect(Video.destroy).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(archiveModule.removeVideoFromArchive).toHaveBeenCalledWith(YT_ID);
    });

    it('looks for the matching job newest first', async () => {
      await createNzbRoutes.reconcileMovedUntrackedVideo(videoRow);

      expect(Job.findAll).toHaveBeenCalledWith({ where: { id: ['j1'] }, order: [['timeCreated', 'DESC']] });
    });

    it('warns when several job links point at one video', async () => {
      JobVideo.findAll.mockResolvedValue([{ job_id: 'j1' }, { job_id: 'j2' }]);

      await createNzbRoutes.reconcileMovedUntrackedVideo(videoRow);

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ jobIds: ['j1', 'j2'] }), expect.stringContaining('multiple JobVideo rows'));
    });

    it('cleans up empty folders left behind', async () => {
      await createNzbRoutes.reconcileMovedUntrackedVideo(videoRow);

      expect(cleanupEmptyParents).toHaveBeenCalledWith(path.dirname(videoRow.filePath), path.resolve(mockRoot));
    });

    it('does not clean up folders for a path outside the library', async () => {
      await createNzbRoutes.reconcileMovedUntrackedVideo({ ...videoRow, filePath: path.join(os.tmpdir(), 'outside', 'x.mp4') });

      expect(cleanupEmptyParents).not.toHaveBeenCalled();
    });

    it('stamps the job as untracked without resurrecting the video', async () => {
      const job = { data: { nzb: { categoryName: 'TV' } } };
      jobModule.getJob.mockReturnValue(job);

      await createNzbRoutes.reconcileMovedUntrackedVideo(videoRow);

      expect(job.data.nzb.untracked).toBe(true);
      expect(jobModule.saveJobOnly).toHaveBeenCalledWith('j1', job, { skipVideoPersistence: true });
    });

    it('still succeeds when stamping the job fails', async () => {
      jobModule.getJob.mockReturnValue({ data: { nzb: {} } });
      jobModule.saveJobOnly.mockRejectedValue(new Error('db down'));

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(true);
    });

    it('fails when removing the rows throws', async () => {
      Video.destroy.mockRejectedValue(new Error('constraint'));

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(false);
    });

    it('fails when no video row was actually removed', async () => {
      Video.destroy.mockResolvedValue(0);

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(false);
      expect(archiveModule.removeVideoFromArchive).not.toHaveBeenCalled();
    });

    it('fails when the row is still there on re-read', async () => {
      Video.findByPk.mockResolvedValue({ id: 5 });

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(false);
    });

    it('still succeeds when the archive cleanup fails', async () => {
      archiveModule.removeVideoFromArchive.mockRejectedValue(new Error('locked'));

      await expect(createNzbRoutes.reconcileMovedUntrackedVideo(videoRow)).resolves.toBe(true);
    });
  });
});
