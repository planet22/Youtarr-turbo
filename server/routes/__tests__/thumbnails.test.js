/* eslint-env jest */
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const createThumbnailRoutes = require('../thumbnails');

const ID = 'abc123DEF45';

describe('thumbnail routes', () => {
  let app;
  let cache;
  let logger;
  let tmpDir;
  let localFile;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-route-'));
    localFile = path.join(tmpDir, `videothumb-${ID}.jpg`);
    fs.writeFileSync(localFile, 'jpeg-bytes');
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cache = {
      ensureLocal: jest.fn().mockResolvedValue(localFile),
      existingLocalPath: jest.fn().mockReturnValue(null),
      youtubeUrl: jest.fn((id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
    };
    logger = { error: jest.fn() };
    app = express();
    app.use(createThumbnailRoutes({ videoThumbnailCache: cache, logger }));
  });

  it('serves the kept thumbnail, fetching it when needed', async () => {
    const res = await request(app).get(`/images/videothumb-${ID}.jpg`);

    expect(res.status).toBe(200);
    expect(cache.ensureLocal).toHaveBeenCalledWith(ID);
  });

  it('returns 404 when no thumbnail can be found', async () => {
    cache.ensureLocal.mockResolvedValue(null);

    const res = await request(app).get(`/images/videothumb-${ID}.jpg`);

    expect(res.status).toBe(404);
  });

  it('never fetches to keep a copy in no-cache mode', async () => {
    await request(app).get(`/images/videothumb-${ID}.jpg?cache=0`);

    expect(cache.ensureLocal).not.toHaveBeenCalled();
  });

  it('redirects to YouTube in no-cache mode when there is no local copy', async () => {
    const res = await request(app).get(`/images/videothumb-${ID}.jpg?cache=0`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });

  it('serves the local copy in no-cache mode when there is one', async () => {
    cache.existingLocalPath.mockReturnValue(localFile);

    const res = await request(app).get(`/images/videothumb-${ID}.jpg?cache=0`);

    expect(res.status).toBe(200);
  });

  it('does not handle paths that are not a video id', async () => {
    const res = await request(app).get('/images/videothumb-..%2Fsecret.jpg');

    expect(res.status).toBe(404);
    expect(cache.ensureLocal).not.toHaveBeenCalled();
  });

  it('returns 500 when serving fails unexpectedly', async () => {
    cache.ensureLocal.mockRejectedValue(new Error('boom'));

    const res = await request(app).get(`/images/videothumb-${ID}.jpg`);

    expect(res.status).toBe(500);
  });
});
