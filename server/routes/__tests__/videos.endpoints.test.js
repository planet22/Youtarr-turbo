/* eslint-env jest */

jest.mock('../../models/video', () => ({ findAll: jest.fn() }));
jest.mock('../../modules/strmCacheOnPlay', () => ({ forceEnqueueCacheDownload: jest.fn() }));
jest.mock('../../modules/videoDeletionModule', () => ({
  deleteVideos: jest.fn(),
  deleteVideosByYoutubeIds: jest.fn(),
  purgeVideos: jest.fn(),
  revertToStrm: jest.fn(),
  performAutomaticCleanup: jest.fn(),
}));
jest.mock('../../modules/videoValidationModule', () => ({ validateVideo: jest.fn() }));
jest.mock('../../modules/channelSettingsModule', () => ({ validateSubFolder: jest.fn() }));
jest.mock('../../modules/subfolderModule', () => ({ register: jest.fn() }));
jest.mock('../../modules/apiKeyModule', () => ({ incrementUsageCount: jest.fn() }));
jest.mock('../../modules/jobModule', () => ({ getRunningJobs: jest.fn() }));
jest.mock('../../modules/configModule', () => ({ getConfig: jest.fn() }));

const express = require('express');
const supertest = require('supertest');

const createVideoRoutes = require('../videos');
const Video = require('../../models/video');
const strmCacheOnPlay = require('../../modules/strmCacheOnPlay');
const videoDeletionModule = require('../../modules/videoDeletionModule');
const videoValidationModule = require('../../modules/videoValidationModule');
const channelSettingsModule = require('../../modules/channelSettingsModule');
const subfolderModule = require('../../modules/subfolderModule');
const apiKeyModule = require('../../modules/apiKeyModule');
const jobModule = require('../../modules/jobModule');
const configModule = require('../../modules/configModule');

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const CHANNEL_ID = 'UC' + 'a'.repeat(22);

function makeApp() {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const videosModule = {
    getVideosPaginated: jest.fn().mockResolvedValue({ videos: [], total: 0 }),
    bulkUpdateVideoRatings: jest.fn(),
    setVideoProtection: jest.fn(),
  };
  const downloadModule = {
    doGroupedManualDownloads: jest.fn().mockResolvedValue(undefined),
    doChannelAndPlaylistDownloads: jest.fn().mockResolvedValue(undefined),
  };
  const videoOembedEnricher = { enrichByIds: jest.fn() };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = log;
    // Lets tests simulate API-key auth without a real verifyToken.
    if (req.get('x-test-api-key-id')) {
      req.authType = 'api_key';
      req.apiKeyId = req.get('x-test-api-key-id');
      req.apiKeyName = 'My Key';
    }
    next();
  });
  app.use(createVideoRoutes({ verifyToken: (_req, _res, next) => next(), videosModule, downloadModule, videoOembedEnricher }));
  return { app, log, videosModule, downloadModule, videoOembedEnricher };
}

describe('videos routes: remaining endpoints', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    channelSettingsModule.validateSubFolder.mockReturnValue({ valid: true });
    subfolderModule.register.mockResolvedValue(undefined);
    apiKeyModule.incrementUsageCount.mockResolvedValue(undefined);
    videoValidationModule.validateVideo.mockResolvedValue({ isValidUrl: true, title: 'T', thumbnail: 'th', duration: 42, metadata: {} });
    configModule.getConfig.mockReturnValue({});
    jobModule.getRunningJobs.mockReturnValue([]);
  });

  describe('GET /getVideos', () => {
    it('applies defaults when there is no query', async () => {
      const { app, videosModule } = makeApp();

      await supertest(app).get('/getVideos');

      expect(videosModule.getVideosPaginated).toHaveBeenCalledWith({
        page: 1,
        limit: 12,
        search: '',
        dateFrom: null,
        dateTo: null,
        addedDateFrom: null,
        addedDateTo: null,
        sortBy: 'added',
        sortOrder: 'desc',
        channelFilter: '',
        protectedFilter: 'off',
        missingFilter: 'off',
        watchedFilter: 'off',
        strmFilter: 'off',
        metadataCacheFilter: 'off',
        cachedVideoFilter: 'off',
        metadataOnlyFilter: 'off',
        showUntracked: false,
      });
    });

    it('passes the query parameters through', async () => {
      const { app, videosModule } = makeApp();

      await supertest(app).get('/getVideos').query({
        page: '3', limit: '24', search: 'cats', dateFrom: '2024-01-01', dateTo: '2024-02-01',
        addedDateFrom: '2024-03-01', addedDateTo: '2024-04-01', sortBy: 'title', sortOrder: 'asc', channelFilter: 'UC1',
      });

      expect(videosModule.getVideosPaginated).toHaveBeenCalledWith(expect.objectContaining({
        page: 3, limit: 24, search: 'cats', dateFrom: '2024-01-01', dateTo: '2024-02-01',
        addedDateFrom: '2024-03-01', addedDateTo: '2024-04-01', sortBy: 'title', sortOrder: 'asc', channelFilter: 'UC1',
      }));
    });

    it.each([
      'protectedFilter', 'missingFilter', 'watchedFilter', 'strmFilter', 'metadataCacheFilter', 'cachedVideoFilter', 'metadataOnlyFilter',
    ])('accepts only/exclude and rejects other values for %s', async (name) => {
      const { app, videosModule } = makeApp();

      await supertest(app).get('/getVideos').query({ [name]: 'only' });
      await supertest(app).get('/getVideos').query({ [name]: 'exclude' });
      await supertest(app).get('/getVideos').query({ [name]: 'bogus' });

      const modes = videosModule.getVideosPaginated.mock.calls.map(([options]) => options[name]);
      expect(modes).toEqual(['only', 'exclude', 'off']);
    });

    it('falls back to page 1 and limit 12 for non-numeric values', async () => {
      const { app, videosModule } = makeApp();

      await supertest(app).get('/getVideos').query({ page: 'x', limit: 'y' });

      expect(videosModule.getVideosPaginated).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 12 }));
    });

    it('enables showUntracked only for the string "true"', async () => {
      const { app, videosModule } = makeApp();

      await supertest(app).get('/getVideos').query({ showUntracked: 'true' });
      await supertest(app).get('/getVideos').query({ showUntracked: '1' });

      expect(videosModule.getVideosPaginated.mock.calls.map(([o]) => o.showUntracked)).toEqual([true, false]);
    });

    it('returns the module result', async () => {
      const { app, videosModule } = makeApp();
      videosModule.getVideosPaginated.mockResolvedValue({ videos: [{ id: 1 }], total: 1 });

      const res = await supertest(app).get('/getVideos');

      expect(res.body).toEqual({ videos: [{ id: 1 }], total: 1 });
    });

    it('answers 500 with the reason when listing fails', async () => {
      const { app, videosModule, log } = makeApp();
      videosModule.getVideosPaginated.mockRejectedValue(new Error('db down'));

      const res = await supertest(app).get('/getVideos');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'db down' });
      expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Failed to get videos');
    });
  });

  describe('POST /api/videos/rating', () => {
    it.each([
      ['no body', {}, 'videoIds array is required'],
      ['an empty list', { videoIds: [], rating: 'PG' }, 'videoIds array is required'],
      ['videoIds that is not an array', { videoIds: 5, rating: 'PG' }, 'videoIds array is required'],
      ['no rating', { videoIds: [1] }, 'rating is required'],
    ])('rejects %s with 400', async (_label, body, error) => {
      const { app, videosModule } = makeApp();

      const res = await supertest(app).post('/api/videos/rating').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error });
      expect(videosModule.bulkUpdateVideoRatings).not.toHaveBeenCalled();
    });

    it('answers 500 with the reason when the update fails', async () => {
      const { app, videosModule, log } = makeApp();
      videosModule.bulkUpdateVideoRatings.mockRejectedValue(new Error('db down'));

      const res = await supertest(app).post('/api/videos/rating').send({ videoIds: [1], rating: 'PG' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'db down' });
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/videos/:id/protected', () => {
    it('sets protection using the numeric id', async () => {
      const { app, videosModule } = makeApp();
      videosModule.setVideoProtection.mockResolvedValue({ success: true });

      const res = await supertest(app).patch('/api/videos/7/protected').send({ protected: true });

      expect(res.body).toEqual({ success: true });
      expect(videosModule.setVideoProtection).toHaveBeenCalledWith(7, true);
    });

    it('can turn protection off', async () => {
      const { app, videosModule } = makeApp();
      videosModule.setVideoProtection.mockResolvedValue({ success: true });

      await supertest(app).patch('/api/videos/7/protected').send({ protected: false });

      expect(videosModule.setVideoProtection).toHaveBeenCalledWith(7, false);
    });

    it.each([['a string', 'true'], ['a number', 1], ['missing', undefined]])('rejects a protected value that is %s', async (_label, value) => {
      const { app, videosModule } = makeApp();

      const res = await supertest(app).patch('/api/videos/7/protected').send({ protected: value });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'protected field (boolean) is required' });
      expect(videosModule.setVideoProtection).not.toHaveBeenCalled();
    });

    it('answers 404 when the video does not exist', async () => {
      const { app, videosModule } = makeApp();
      videosModule.setVideoProtection.mockRejectedValue(new Error('Video not found'));

      const res = await supertest(app).patch('/api/videos/7/protected').send({ protected: true });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Video not found' });
    });

    it('answers 500 without leaking the reason for other failures', async () => {
      const { app, videosModule, log } = makeApp();
      videosModule.setVideoProtection.mockRejectedValue(new Error('db down'));

      const res = await supertest(app).patch('/api/videos/7/protected').send({ protected: true });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to update protection status' });
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('DELETE /api/videos', () => {
    it.each([
      ['no ids at all', {}],
      ['videoIds that is not an array', { videoIds: 'a' }],
      ['youtubeIds that is not an array', { youtubeIds: 'a' }],
      ['an empty videoIds list', { videoIds: [] }],
      ['an empty youtubeIds list', { youtubeIds: [] }],
      ['both lists empty', { videoIds: [], youtubeIds: [] }],
    ])('rejects %s with 400', async (_label, body) => {
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'videoIds or youtubeIds array is required' });
      expect(videoDeletionModule.deleteVideos).not.toHaveBeenCalled();
    });

    it('deletes by database id', async () => {
      videoDeletionModule.deleteVideos.mockResolvedValue({ success: true, deleted: [1, 2] });
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos').send({ videoIds: [1, 2] });

      expect(res.body).toEqual({ success: true, deleted: [1, 2] });
      expect(videoDeletionModule.deleteVideos).toHaveBeenCalledWith([1, 2]);
    });

    it('deletes by YouTube id', async () => {
      videoDeletionModule.deleteVideosByYoutubeIds.mockResolvedValue({ success: true });
      const { app } = makeApp();

      await supertest(app).delete('/api/videos').send({ youtubeIds: ['abc'] });

      expect(videoDeletionModule.deleteVideosByYoutubeIds).toHaveBeenCalledWith(['abc']);
    });

    it('prefers YouTube ids when both lists are given', async () => {
      videoDeletionModule.deleteVideosByYoutubeIds.mockResolvedValue({ success: true });
      const { app } = makeApp();

      await supertest(app).delete('/api/videos').send({ videoIds: [1], youtubeIds: ['abc'] });

      expect(videoDeletionModule.deleteVideos).not.toHaveBeenCalled();
    });

    it('falls back to database ids when the YouTube id list is empty but videoIds is not', async () => {
      videoDeletionModule.deleteVideos.mockResolvedValue({ success: true });
      const { app } = makeApp();

      await supertest(app).delete('/api/videos').send({ videoIds: [3], youtubeIds: [] });

      expect(videoDeletionModule.deleteVideos).toHaveBeenCalledWith([3]);
    });

    it('answers 500 with the reason when deletion fails', async () => {
      videoDeletionModule.deleteVideos.mockRejectedValue(new Error('locked'));
      const { app, log } = makeApp();

      const res = await supertest(app).delete('/api/videos').send({ videoIds: [1] });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'locked' });
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('bulk delete and purge size limit', () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);

    it.each([
      ['videoIds', { videoIds: ids(501) }],
      ['youtubeIds', { youtubeIds: ids(501).map(String) }],
    ])('rejects a delete with more than 500 %s', async (_label, body) => {
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'ids array exceeds maximum of 500' });
      expect(videoDeletionModule.deleteVideos).not.toHaveBeenCalled();
    });

    it('accepts a delete of exactly 500 ids', async () => {
      videoDeletionModule.deleteVideos.mockResolvedValue({ success: true });
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos').send({ videoIds: ids(500) });

      expect(res.status).toBe(200);
    });

    it('rejects a purge of more than 500 ids', async () => {
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos/purge').send({ videoIds: ids(501) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'videoIds array exceeds maximum of 500' });
      expect(videoDeletionModule.purgeVideos).not.toHaveBeenCalled();
    });

    it('accepts a purge of exactly 500 ids', async () => {
      videoDeletionModule.purgeVideos.mockResolvedValue({ success: true });
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos/purge').send({ videoIds: ids(500) });

      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /api/videos/purge', () => {
    it.each([['missing', {}], ['empty', { videoIds: [] }], ['not an array', { videoIds: 4 }]])('rejects videoIds that are %s', async (_label, body) => {
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos/purge').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'videoIds array is required' });
    });

    it('purges the given videos', async () => {
      videoDeletionModule.purgeVideos.mockResolvedValue({ success: true, purged: 2 });
      const { app } = makeApp();

      const res = await supertest(app).delete('/api/videos/purge').send({ videoIds: [1, 2] });

      expect(res.body).toEqual({ success: true, purged: 2 });
      expect(videoDeletionModule.purgeVideos).toHaveBeenCalledWith([1, 2]);
    });

    it('answers 500 with the reason when purging fails', async () => {
      videoDeletionModule.purgeVideos.mockRejectedValue(new Error('db down'));
      const { app, log } = makeApp();

      const res = await supertest(app).delete('/api/videos/purge').send({ videoIds: [1] });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'db down' });
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('POST /api/videos/strm/download', () => {
    it.each([['missing', {}], ['empty', { videoIds: [] }], ['not an array', { videoIds: 'a' }]])('rejects videoIds that are %s', async (_label, body) => {
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'videoIds array is required' });
    });

    it('rejects more than 500 ids', async () => {
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: Array.from({ length: 501 }, (_, i) => i + 1) });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('videoIds array exceeds maximum of 500');
      expect(Video.findAll).not.toHaveBeenCalled();
    });

    it('accepts exactly 500 ids', async () => {
      Video.findAll.mockResolvedValue([]);
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: Array.from({ length: 500 }, (_, i) => i + 1) });

      expect(res.status).toBe(200);
    });

    it('queues every found video by its YouTube id', async () => {
      Video.findAll.mockResolvedValue([{ id: 1, youtubeId: 'yt1' }, { id: 2, youtubeId: 'yt2' }]);
      strmCacheOnPlay.forceEnqueueCacheDownload.mockResolvedValue({ queued: true });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: [1, 2] });

      expect(res.body).toEqual({ success: true, processed: [1, 2], failed: [] });
      expect(strmCacheOnPlay.forceEnqueueCacheDownload.mock.calls.map(([id]) => id)).toEqual(['yt1', 'yt2']);
    });

    it('looks the videos up in one query', async () => {
      Video.findAll.mockResolvedValue([]);
      const { app } = makeApp();

      await supertest(app).post('/api/videos/strm/download').send({ videoIds: [1, 2] });

      expect(Video.findAll).toHaveBeenCalledWith({ where: { id: [1, 2] } });
    });

    it('reports ids that are not in the database', async () => {
      Video.findAll.mockResolvedValue([]);
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: [9] });

      expect(res.body).toEqual({ success: false, processed: [], failed: [{ videoId: 9, error: 'Video not found in database' }] });
    });

    it('matches string ids to numeric database ids', async () => {
      Video.findAll.mockResolvedValue([{ id: 5, youtubeId: 'yt5' }]);
      strmCacheOnPlay.forceEnqueueCacheDownload.mockResolvedValue({ queued: true });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: ['5'] });

      expect(res.body.processed).toEqual(['5']);
    });

    it('reports the reason a download could not be queued', async () => {
      Video.findAll.mockResolvedValue([{ id: 1, youtubeId: 'yt1' }]);
      strmCacheOnPlay.forceEnqueueCacheDownload.mockResolvedValue({ queued: false, reason: 'already downloaded' });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: [1] });

      expect(res.body.failed).toEqual([{ videoId: 1, error: 'already downloaded' }]);
    });

    it('uses a generic message when no reason is given', async () => {
      Video.findAll.mockResolvedValue([{ id: 1, youtubeId: 'yt1' }]);
      strmCacheOnPlay.forceEnqueueCacheDownload.mockResolvedValue({ queued: false });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: [1] });

      expect(res.body.failed).toEqual([{ videoId: 1, error: 'Could not queue download' }]);
    });

    it('keeps going when one video throws', async () => {
      Video.findAll.mockResolvedValue([{ id: 1, youtubeId: 'yt1' }, { id: 2, youtubeId: 'yt2' }]);
      strmCacheOnPlay.forceEnqueueCacheDownload
        .mockRejectedValueOnce(new Error('queue full'))
        .mockResolvedValueOnce({ queued: true });
      const { app, log } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: [1, 2] });

      expect(res.body).toEqual({ success: false, processed: [2], failed: [{ videoId: 1, error: 'queue full' }] });
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ videoId: 1 }), 'Failed to force-download STRM video');
    });

    it('uses an unknown-error message when the thrown error has none', async () => {
      Video.findAll.mockResolvedValue([{ id: 1, youtubeId: 'yt1' }]);
      strmCacheOnPlay.forceEnqueueCacheDownload.mockRejectedValue(new Error(''));
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: [1] });

      expect(res.body.failed).toEqual([{ videoId: 1, error: 'Unknown error' }]);
    });

    it('answers 500 when the database lookup fails', async () => {
      Video.findAll.mockRejectedValue(new Error('db down'));
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/download').send({ videoIds: [1] });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'db down' });
    });
  });

  describe('POST /api/videos/strm/revert', () => {
    it.each([['missing', {}], ['empty', { videoIds: [] }], ['not an array', { videoIds: 'a' }]])('rejects videoIds that are %s', async (_label, body) => {
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/revert').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'videoIds array is required' });
    });

    it('reverts every video', async () => {
      videoDeletionModule.revertToStrm.mockResolvedValue({ success: true });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/revert').send({ videoIds: [1, 2] });

      expect(res.body).toEqual({ success: true, processed: [1, 2], failed: [] });
    });

    it('reports videos that could not be reverted', async () => {
      videoDeletionModule.revertToStrm
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'no backup' })
        .mockResolvedValueOnce({ success: false });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/revert').send({ videoIds: [1, 2, 3] });

      expect(res.body).toEqual({
        success: false,
        processed: [1],
        failed: [{ videoId: 2, error: 'no backup' }, { videoId: 3, error: 'Could not revert to STRM' }],
      });
    });

    it('records a video whose revert throws as failed and carries on with the rest', async () => {
      videoDeletionModule.revertToStrm
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error('io'))
        .mockResolvedValueOnce({ success: true });
      const { app, log } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/revert').send({ videoIds: [1, 2, 3] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: false, processed: [1, 3], failed: [{ videoId: 2, error: 'io' }] });
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ videoId: 2 }), 'Failed to revert video to STRM');
    });

    it('rejects more than 500 ids', async () => {
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/revert').send({ videoIds: Array.from({ length: 501 }, (_, i) => i + 1) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'videoIds array exceeds maximum of 500' });
      expect(videoDeletionModule.revertToStrm).not.toHaveBeenCalled();
    });

    it('accepts exactly 500 ids', async () => {
      videoDeletionModule.revertToStrm.mockResolvedValue({ success: true });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/videos/strm/revert').send({ videoIds: Array.from({ length: 500 }, (_, i) => i + 1) });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/auto-removal/dry-run', () => {
    beforeEach(() => {
      videoDeletionModule.performAutomaticCleanup.mockResolvedValue({ success: true, dryRun: true });
    });

    it('runs with no overrides when the body is empty', async () => {
      const { app } = makeApp();

      await supertest(app).post('/api/auto-removal/dry-run').send({});

      expect(videoDeletionModule.performAutomaticCleanup).toHaveBeenCalledWith({ dryRun: true, overrides: {} });
    });

    it('forwards every override', async () => {
      const { app } = makeApp();

      await supertest(app).post('/api/auto-removal/dry-run').send({
        autoRemovalEnabled: true,
        autoRemovalVideoAgeThreshold: 30,
        autoRemovalFreeSpaceThreshold: 5,
        autoRemovalWatchedEnabled: false,
        autoRemovalWatchedMinDaysSinceWatched: 7,
        autoRemovalWatchedMinVideoAgeDays: 14,
        autoRemovalKeepRecentCount: 3,
      });

      expect(videoDeletionModule.performAutomaticCleanup).toHaveBeenCalledWith({
        dryRun: true,
        overrides: {
          autoRemovalEnabled: true,
          autoRemovalVideoAgeThreshold: 30,
          autoRemovalFreeSpaceThreshold: 5,
          autoRemovalWatchedEnabled: false,
          autoRemovalWatchedMinDaysSinceWatched: 7,
          autoRemovalWatchedMinVideoAgeDays: 14,
          autoRemovalKeepRecentCount: 3,
        },
      });
    });

    it.each([
      ['the string "true"', 'true', true],
      ['the string "FALSE"', 'FALSE', false],
      ['the number 1', 1, true],
      ['the number 0', 0, false],
    ])('coerces the boolean overrides from %s', async (_label, value, expected) => {
      const { app } = makeApp();

      await supertest(app).post('/api/auto-removal/dry-run').send({ autoRemovalEnabled: value, autoRemovalWatchedEnabled: value });

      expect(videoDeletionModule.performAutomaticCleanup.mock.calls[0][0].overrides).toEqual({
        autoRemovalEnabled: expected,
        autoRemovalWatchedEnabled: expected,
      });
    });

    it('returns the cleanup result', async () => {
      videoDeletionModule.performAutomaticCleanup.mockResolvedValue({ success: true, plan: { totalMarkedForDeletion: 2 } });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/auto-removal/dry-run').send({});

      expect(res.body).toEqual({ success: true, plan: { totalMarkedForDeletion: 2 } });
    });

    it('answers 500 with the reason when the dry run fails', async () => {
      videoDeletionModule.performAutomaticCleanup.mockRejectedValue(new Error('scan failed'));
      const { app, log } = makeApp();

      const res = await supertest(app).post('/api/auto-removal/dry-run').send({});

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'scan failed' });
      expect(log.error).toHaveBeenCalled();
    });

    it('uses a generic message when the error has none', async () => {
      videoDeletionModule.performAutomaticCleanup.mockRejectedValue(new Error(''));
      const { app } = makeApp();

      const res = await supertest(app).post('/api/auto-removal/dry-run').send({});

      expect(res.body.error).toBe('Failed to run auto-removal dry run');
    });
  });

  describe('POST /api/checkYoutubeVideoURL', () => {
    it('rejects a missing url', async () => {
      const { app } = makeApp();

      const res = await supertest(app).post('/api/checkYoutubeVideoURL').send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ isValidUrl: false, error: 'URL is required' });
    });

    it('returns the validation result', async () => {
      videoValidationModule.validateVideo.mockResolvedValue({ isValidUrl: true, title: 'Vid' });
      const { app } = makeApp();

      const res = await supertest(app).post('/api/checkYoutubeVideoURL').send({ url: VIDEO_URL });

      expect(res.body).toEqual({ isValidUrl: true, title: 'Vid' });
      expect(videoValidationModule.validateVideo).toHaveBeenCalledWith(VIDEO_URL);
    });

    it('answers 500 without leaking the reason when validation throws', async () => {
      videoValidationModule.validateVideo.mockRejectedValue(new Error('yt-dlp crashed'));
      const { app, log } = makeApp();

      const res = await supertest(app).post('/api/checkYoutubeVideoURL').send({ url: VIDEO_URL });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ isValidUrl: false, error: 'Internal server error' });
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('POST /api/bulkEnrichVideos', () => {
    it('rejects a body without an ids array', async () => {
      const { app } = makeApp();

      const res = await supertest(app).post('/api/bulkEnrichVideos').send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'ids must be an array' });
    });

    it('returns the enriched map', async () => {
      const { app, videoOembedEnricher } = makeApp();
      videoOembedEnricher.enrichByIds.mockResolvedValue({ abc: { title: 'T' } });

      const res = await supertest(app).post('/api/bulkEnrichVideos').send({ ids: ['abc'] });

      expect(res.body).toEqual({ enriched: { abc: { title: 'T' } } });
    });

    it('answers 500 when enrichment throws', async () => {
      const { app, videoOembedEnricher, log } = makeApp();
      videoOembedEnricher.enrichByIds.mockRejectedValue(new Error('boom'));

      const res = await supertest(app).post('/api/bulkEnrichVideos').send({ ids: ['abc'] });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('OPTIONS /api/videos/download', () => {
    it('answers the CORS preflight with 204', async () => {
      const { app } = makeApp();

      const res = await supertest(app).options('/api/videos/download');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toBe('POST, OPTIONS');
      expect(res.headers['access-control-allow-headers']).toBe('Content-Type, x-api-key, x-access-token');
      expect(res.headers['access-control-max-age']).toBe('86400');
    });
  });

  describe('POST /api/videos/download', () => {
    const post = (app, body, headers = {}) => {
      let req = supertest(app).post('/api/videos/download');
      Object.entries(headers).forEach(([k, v]) => { req = req.set(k, v); });
      return req.send(body);
    };

    it('sets the CORS origin header', async () => {
      const { app } = makeApp();

      const res = await post(app, { url: VIDEO_URL });

      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('queues a valid video and returns its details', async () => {
      const { app, downloadModule } = makeApp();

      const res = await post(app, { url: VIDEO_URL });

      expect(res.body).toEqual({ success: true, message: 'Video queued for download', video: { title: 'T', thumbnail: 'th', duration: 42 } });
      expect(downloadModule.doGroupedManualDownloads).toHaveBeenCalledWith({
        body: { urls: [VIDEO_URL], overrideSettings: undefined, videoChannelMap: undefined, initiatedBy: { type: 'web_ui' } },
      });
    });

    it('rejects a missing url', async () => {
      const { app } = makeApp();

      const res = await post(app, {});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'URL is required' });
    });

    it('rejects a url over 2048 characters', async () => {
      const { app } = makeApp();

      const res = await post(app, { url: `${VIDEO_URL}&x=${'a'.repeat(2048)}` });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('URL too long (max 2048 characters)');
    });

    it.each([
      ['a non-YouTube url', 'https://example.com/watch?v=dQw4w9WgXcQ'],
      ['a video id that is too short', 'https://www.youtube.com/watch?v=short'],
      ['a bare channel url', 'https://www.youtube.com/channel/UCabc'],
    ])('rejects %s', async (_label, url) => {
      const { app, downloadModule } = makeApp();

      const res = await post(app, { url });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid YouTube URL format');
      expect(downloadModule.doGroupedManualDownloads).not.toHaveBeenCalled();
    });

    it.each([
      ['a playlist parameter', `${VIDEO_URL}&list=PL123`],
      ['a channel path', `${VIDEO_URL}/channel/UC1`],
      ['a handle path', `${VIDEO_URL}/@someone`],
      ['a playlist path', `${VIDEO_URL}/playlist`],
    ])('rejects a video url with %s', async (_label, url) => {
      const { app } = makeApp();

      const res = await post(app, { url });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('API keys only support single video downloads. Playlists and channels require the web UI.');
    });

    it.each(['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube.com/watch?v=dQw4w9WgXcQ'])('accepts the url form %s', async (url) => {
      const { app } = makeApp();

      const res = await post(app, { url });

      expect(res.status).toBe(200);
    });

    it('rejects an unsupported resolution', async () => {
      const { app } = makeApp();

      const res = await post(app, { url: VIDEO_URL, resolution: '999' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid resolution. Valid values: 360, 480, 720, 1080, 1440, 2160');
    });

    it('passes a valid resolution as an override', async () => {
      const { app, downloadModule } = makeApp();

      await post(app, { url: VIDEO_URL, resolution: '720' });

      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body.overrideSettings).toEqual({ resolution: '720' });
    });

    it('rejects an invalid subfolder with the validator message', async () => {
      channelSettingsModule.validateSubFolder.mockReturnValue({ valid: false, error: 'bad subfolder' });
      const { app, downloadModule } = makeApp();

      const res = await post(app, { url: VIDEO_URL, subfolder: '../x' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'bad subfolder' });
      expect(downloadModule.doGroupedManualDownloads).not.toHaveBeenCalled();
    });

    it('registers and passes through a real subfolder override', async () => {
      const { app, downloadModule } = makeApp();

      await post(app, { url: VIDEO_URL, subfolder: 'Music' });

      expect(subfolderModule.register).toHaveBeenCalledWith('Music');
      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body.overrideSettings).toEqual({ subfolder: 'Music' });
    });

    it.each(['##ROOT##', '##USE_GLOBAL_DEFAULT##'])('does not register the sentinel subfolder %s', async (sentinel) => {
      const { ROOT_SENTINEL, GLOBAL_DEFAULT_SENTINEL } = require('../../modules/filesystem/constants');
      const value = sentinel === '##ROOT##' ? ROOT_SENTINEL : GLOBAL_DEFAULT_SENTINEL;
      const { app } = makeApp();

      await post(app, { url: VIDEO_URL, subfolder: value });

      expect(subfolderModule.register).not.toHaveBeenCalled();
    });

    it('still queues the download when registering the subfolder fails', async () => {
      subfolderModule.register.mockRejectedValue(new Error('db down'));
      const { app, log } = makeApp();

      const res = await post(app, { url: VIDEO_URL, subfolder: 'Music' });

      expect(res.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(log.warn).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Failed to register download subfolder');
    });

    it('rejects a url that fails metadata validation with its reason', async () => {
      videoValidationModule.validateVideo.mockResolvedValue({ isValidUrl: false, error: 'Video unavailable' });
      const { app, downloadModule } = makeApp();

      const res = await post(app, { url: VIDEO_URL });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Video unavailable' });
      expect(downloadModule.doGroupedManualDownloads).not.toHaveBeenCalled();
    });

    it('uses a generic message when validation gives no reason', async () => {
      videoValidationModule.validateVideo.mockResolvedValue({ isValidUrl: false });
      const { app } = makeApp();

      const res = await post(app, { url: VIDEO_URL });

      expect(res.body.error).toBe('Could not validate video URL');
    });

    it('attributes the video to its channel from the validation metadata', async () => {
      videoValidationModule.validateVideo.mockResolvedValue({ isValidUrl: true, metadata: { youtubeId: 'dQw4w9WgXcQ', channelId: CHANNEL_ID } });
      const { app, downloadModule } = makeApp();

      await post(app, { url: VIDEO_URL });

      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body.videoChannelMap).toEqual({ dQw4w9WgXcQ: CHANNEL_ID });
    });

    it('skips channel attribution when the metadata has no channel', async () => {
      videoValidationModule.validateVideo.mockResolvedValue({ isValidUrl: true, metadata: { youtubeId: 'dQw4w9WgXcQ' } });
      const { app, downloadModule } = makeApp();

      await post(app, { url: VIDEO_URL });

      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body.videoChannelMap).toBeUndefined();
    });

    it('records the API key as the download source and counts its usage', async () => {
      const { app, downloadModule } = makeApp();

      await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-usage' });

      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body.initiatedBy).toEqual({ type: 'api_key', name: 'My Key' });
      expect(apiKeyModule.incrementUsageCount).toHaveBeenCalledWith('key-usage');
    });

    it('does not count usage for session-authenticated requests', async () => {
      const { app } = makeApp();

      await post(app, { url: VIDEO_URL });

      expect(apiKeyModule.incrementUsageCount).not.toHaveBeenCalled();
    });

    it('still answers when counting API key usage fails', async () => {
      apiKeyModule.incrementUsageCount.mockRejectedValue(new Error('db down'));
      const { app, log } = makeApp();

      const res = await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-usage-fail' });

      expect(res.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ keyId: 'key-usage-fail' }), 'Failed to increment API key usage count');
    });

    it('still answers when starting the download fails asynchronously', async () => {
      const { app, downloadModule, log } = makeApp();
      downloadModule.doGroupedManualDownloads.mockRejectedValue(new Error('queue full'));

      const res = await post(app, { url: VIDEO_URL });

      expect(res.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Failed to start API download');
    });

    it('answers 500 without leaking the reason when validation throws', async () => {
      videoValidationModule.validateVideo.mockRejectedValue(new Error('yt-dlp crashed'));
      const { app, log } = makeApp();

      const res = await post(app, { url: VIDEO_URL });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'Failed to queue video for download' });
      expect(log.error).toHaveBeenCalled();
    });

    describe('API key rate limiting', () => {
      it('limits an API key to the configured requests per minute', async () => {
        configModule.getConfig.mockReturnValue({ apiKeyRateLimit: 2 });
        const { app } = makeApp();

        const statuses = [];
        for (let i = 0; i < 3; i += 1) {
          const res = await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-limited' });
          statuses.push(res.status);
        }

        expect(statuses).toEqual([200, 200, 429]);
      });

      it('answers a limited request with the rate limit message', async () => {
        configModule.getConfig.mockReturnValue({ apiKeyRateLimit: 1 });
        const { app } = makeApp();
        await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-message' });

        const res = await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-message' });

        expect(res.body).toEqual({ success: false, error: 'Rate limit exceeded. Try again later.' });
      });

      it('defaults to 10 requests per minute when none is configured', async () => {
        configModule.getConfig.mockReturnValue({});
        const { app } = makeApp();

        const statuses = [];
        for (let i = 0; i < 11; i += 1) {
          const res = await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-default' });
          statuses.push(res.status);
        }

        expect(statuses.filter((s) => s === 429)).toHaveLength(1);
      });

      it('counts each API key separately', async () => {
        configModule.getConfig.mockReturnValue({ apiKeyRateLimit: 1 });
        const { app } = makeApp();
        await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-a' });

        const res = await post(app, { url: VIDEO_URL }, { 'x-test-api-key-id': 'key-b' });

        expect(res.status).toBe(200);
      });

      it('does not limit session-authenticated requests', async () => {
        configModule.getConfig.mockReturnValue({ apiKeyRateLimit: 1 });
        const { app } = makeApp();

        const statuses = [];
        for (let i = 0; i < 4; i += 1) {
          const res = await post(app, { url: VIDEO_URL });
          statuses.push(res.status);
        }

        expect(statuses).toEqual([200, 200, 200, 200]);
      });
    });
  });

  describe('POST /triggerspecificdownloads', () => {
    const post = (app, body) => supertest(app).post('/triggerspecificdownloads').send(body);

    it('starts the manual downloads', async () => {
      const { app, downloadModule } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL] });

      expect(res.body).toEqual({ status: 'success' });
      expect(downloadModule.doGroupedManualDownloads).toHaveBeenCalledTimes(1);
      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body).toEqual({ urls: [VIDEO_URL] });
    });

    it('still answers when the download fails asynchronously', async () => {
      const { app, downloadModule, log } = makeApp();
      downloadModule.doGroupedManualDownloads.mockRejectedValue(new Error('queue full'));

      const res = await post(app, { urls: [VIDEO_URL] });

      expect(res.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Failed to start manual downloads');
    });

    it('rejects an unsupported resolution override', async () => {
      const { app, downloadModule } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { resolution: '999' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid resolution. Valid values: 360, 480, 720, 1080, 1440, 2160');
      expect(downloadModule.doGroupedManualDownloads).not.toHaveBeenCalled();
    });

    it('accepts a valid resolution override', async () => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { resolution: '1080' } });

      expect(res.status).toBe(200);
    });

    it.each(['subfolder', 'subfolderFallback'])('rejects an invalid %s with the validator message', async (field) => {
      channelSettingsModule.validateSubFolder.mockReturnValue({ valid: false, error: 'bad subfolder' });
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { [field]: '../x' } });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'bad subfolder' });
    });

    it.each(['subfolder', 'subfolderFallback'])('does not validate a null %s', async (field) => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { [field]: null } });

      expect(res.status).toBe(200);
      expect(channelSettingsModule.validateSubFolder).not.toHaveBeenCalled();
    });

    it.each(['yes', 1, null])('rejects skipVideoFolder %p that is not a boolean', async (value) => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { skipVideoFolder: value } });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'skipVideoFolder must be a boolean' });
    });

    it('accepts a boolean skipVideoFolder', async () => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { skipVideoFolder: true } });

      expect(res.status).toBe(200);
    });

    it('normalizes the rating override before starting the download', async () => {
      const { app, downloadModule } = makeApp();

      await post(app, { urls: [VIDEO_URL], overrideSettings: { rating: ' nr ' } });

      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body.overrideSettings.rating).toBeNull();
    });

    it('rejects an invalid rating override', async () => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { rating: 'bogus' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid rating');
    });

    it('normalizes the rating fallback before starting the download', async () => {
      const { app, downloadModule } = makeApp();

      await post(app, { urls: [VIDEO_URL], overrideSettings: { ratingFallback: 'nr' } });

      expect(downloadModule.doGroupedManualDownloads.mock.calls[0][0].body.overrideSettings.ratingFallback).toBeNull();
    });

    it('rejects an invalid rating fallback', async () => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { ratingFallback: 'bogus' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid rating');
    });

    it('accepts a null rating fallback without validating it', async () => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], overrideSettings: { ratingFallback: null } });

      expect(res.status).toBe(200);
    });

    it('accepts a valid videoChannelMap', async () => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], videoChannelMap: { dQw4w9WgXcQ: CHANNEL_ID } });

      expect(res.status).toBe(200);
    });

    it('accepts a null videoChannelMap', async () => {
      const { app } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], videoChannelMap: null });

      expect(res.status).toBe(200);
    });

    it.each([
      ['an array', [CHANNEL_ID]],
      ['a string', 'x'],
      ['a video id of the wrong length', { short: CHANNEL_ID }],
      ['a channel id without the UC prefix', { dQw4w9WgXcQ: 'XX' + 'a'.repeat(22) }],
      ['a channel id of the wrong length', { dQw4w9WgXcQ: 'UCshort' }],
      ['a channel id that is not a string', { dQw4w9WgXcQ: 5 }],
    ])('rejects a videoChannelMap that is %s', async (_label, videoChannelMap) => {
      const { app, downloadModule } = makeApp();

      const res = await post(app, { urls: [VIDEO_URL], videoChannelMap });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('videoChannelMap must map 11-character YouTube video IDs to UC-format channel IDs');
      expect(downloadModule.doGroupedManualDownloads).not.toHaveBeenCalled();
    });
  });

  describe('POST /triggerchanneldownloads', () => {
    const post = (app, body) => supertest(app).post('/triggerchanneldownloads').send(body);

    it('starts the channel and playlist downloads', async () => {
      const { app, downloadModule } = makeApp();

      const res = await post(app, {});

      expect(res.body).toEqual({ status: 'success' });
      expect(downloadModule.doChannelAndPlaylistDownloads).toHaveBeenCalledWith({});
    });

    it('passes the request body through', async () => {
      const { app, downloadModule } = makeApp();

      await post(app, { overrideSettings: { resolution: '720', videoCount: 5 } });

      expect(downloadModule.doChannelAndPlaylistDownloads).toHaveBeenCalledWith({ overrideSettings: { resolution: '720', videoCount: 5 } });
    });

    it('refuses while a channel download is in progress', async () => {
      jobModule.getRunningJobs.mockReturnValue([{ jobType: 'Channel Downloads', status: 'In Progress' }]);
      const { app, downloadModule } = makeApp();

      const res = await post(app, {});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Job Already Running' });
      expect(downloadModule.doChannelAndPlaylistDownloads).not.toHaveBeenCalled();
    });

    it('ignores running jobs of other types', async () => {
      jobModule.getRunningJobs.mockReturnValue([{ jobType: 'Manually Added Urls', status: 'In Progress' }]);
      const { app } = makeApp();

      const res = await post(app, {});

      expect(res.status).toBe(200);
    });

    it('ignores channel jobs that are not in progress', async () => {
      jobModule.getRunningJobs.mockReturnValue([{ jobType: 'Channel Downloads', status: 'Pending' }]);
      const { app } = makeApp();

      const res = await post(app, {});

      expect(res.status).toBe(200);
    });

    it('rejects an unsupported resolution override', async () => {
      const { app, downloadModule } = makeApp();

      const res = await post(app, { overrideSettings: { resolution: '999' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid resolution. Valid values: 360, 480, 720, 1080, 1440, 2160');
      expect(downloadModule.doChannelAndPlaylistDownloads).not.toHaveBeenCalled();
    });

    it.each([0, 51, 'abc', -1])('rejects the video count %p', async (videoCount) => {
      const { app } = makeApp();

      const res = await post(app, { overrideSettings: { videoCount } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid video count. Must be between 1 and 50');
    });

    it.each([1, 50, '25'])('accepts the video count %p', async (videoCount) => {
      const { app } = makeApp();

      const res = await post(app, { overrideSettings: { videoCount } });

      expect(res.status).toBe(200);
    });

    it('still answers when the download fails asynchronously', async () => {
      const { app, downloadModule, log } = makeApp();
      downloadModule.doChannelAndPlaylistDownloads.mockRejectedValue(new Error('boom'));

      const res = await post(app, {});

      expect(res.status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Manual channel + playlist downloads failed');
    });
  });
});
