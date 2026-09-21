/* eslint-env jest */

jest.mock('../../modules/configModule', () => ({ getConfig: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const supertest = require('supertest');

const configModule = require('../../modules/configModule');
const createVideoDetailRoutes = require('../videoDetail');

const YT_ID = 'dQw4w9WgXcQ';
const CONTENT = Buffer.from('0123456789abcdefghij'); // 20 bytes

describe('videoDetail routes: remaining endpoints', () => {
  let dir;
  let filePath;
  let videoMetadataModule;
  let log;
  let verifyToken;

  const makeApp = () => {
    const app = express();
    app.use((req, _res, next) => {
      req.log = log;
      next();
    });
    app.use(createVideoDetailRoutes({ verifyToken, videoMetadataModule, mediaServers: { watchStatusQueries: {} } }));
    return app;
  };

  const streamInfo = (overrides = {}) => ({ filePath, contentType: 'video/mp4', fileSize: CONTENT.length, ...overrides });

  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-test-'));
    filePath = path.join(dir, 'video.mp4');
    fs.writeFileSync(filePath, CONTENT);
    log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    verifyToken = jest.fn((_req, _res, next) => next());
    videoMetadataModule = {
      getVideoMetadata: jest.fn(),
      getVideoStreamInfo: jest.fn().mockResolvedValue(streamInfo()),
    };
    configModule.getConfig.mockReturnValue({});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('POST /api/videos/:youtubeId/metadata/refresh', () => {
    it('forces a fresh fetch and returns the result', async () => {
      videoMetadataModule.getVideoMetadata.mockResolvedValue({ title: 'Fresh' });

      const res = await supertest(makeApp()).post(`/api/videos/${YT_ID}/metadata/refresh`);

      expect(res.body).toEqual({ title: 'Fresh' });
      expect(videoMetadataModule.getVideoMetadata).toHaveBeenCalledWith(YT_ID, { forceRefresh: true });
    });

    it.each(['abc', 'a'.repeat(21), 'bad.id!!'])('rejects the invalid id %s', async (id) => {
      const res = await supertest(makeApp()).post(`/api/videos/${id}/metadata/refresh`);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid YouTube ID' });
      expect(videoMetadataModule.getVideoMetadata).not.toHaveBeenCalled();
    });

    it('answers 500 without leaking the reason when the fetch fails', async () => {
      videoMetadataModule.getVideoMetadata.mockRejectedValue(new Error('yt-dlp crashed'));

      const res = await supertest(makeApp()).post(`/api/videos/${YT_ID}/metadata/refresh`);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to refresh video metadata' });
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), 'Failed to refresh video metadata');
    });

    it('requires authentication', async () => {
      verifyToken.mockImplementation((_req, res) => res.status(401).json({ error: 'nope' }));

      const res = await supertest(makeApp()).post(`/api/videos/${YT_ID}/metadata/refresh`);

      expect(res.status).toBe(401);
      expect(videoMetadataModule.getVideoMetadata).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/videos/:youtubeId/stream', () => {
    const get = (query = '') => supertest(makeApp()).get(`/api/videos/${YT_ID}/stream${query}`);

    describe('lookup failures', () => {
      it.each(['not_found', 'no_file', 'file_missing'])('answers 404 with the module message for %s', async (error) => {
        videoMetadataModule.getVideoStreamInfo.mockResolvedValue({ error, message: `problem: ${error}` });

        const res = await get();

        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: `problem: ${error}` });
      });

      it('answers 500 when the lookup throws', async () => {
        videoMetadataModule.getVideoStreamInfo.mockRejectedValue(new Error('db down'));

        const res = await get();

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Failed to stream video' });
        expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), 'Failed to stream video');
      });

      it('looks up the requested type', async () => {
        await get('?type=audio');

        expect(videoMetadataModule.getVideoStreamInfo).toHaveBeenCalledWith(YT_ID, 'audio');
      });

      it('defaults to the video type', async () => {
        await get();

        expect(videoMetadataModule.getVideoStreamInfo).toHaveBeenCalledWith(YT_ID, 'video');
      });
    });

    describe('token in the query string', () => {
      it('is copied into the access token header before verifying', async () => {
        let seenToken;
        verifyToken.mockImplementation((req, _res, next) => {
          seenToken = req.headers['x-access-token'];
          next();
        });

        await get('?token=abc123');

        expect(seenToken).toBe('abc123');
      });

      it('does not replace a token that was already sent in the header', async () => {
        let seenToken;
        verifyToken.mockImplementation((req, _res, next) => {
          seenToken = req.headers['x-access-token'];
          next();
        });

        await supertest(makeApp()).get(`/api/videos/${YT_ID}/stream?token=fromquery`).set('x-access-token', 'fromheader');

        expect(seenToken).toBe('fromheader');
      });
    });

    describe('STRM videos', () => {
      const redirectTarget = async () => {
        videoMetadataModule.getVideoStreamInfo.mockResolvedValue({ isStrm: true });
        const res = await get();
        expect(res.status).toBe(302);
        const url = new URL(res.headers.location, 'http://localhost');
        return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
      };

      it('redirects to ytstream for the video', async () => {
        const { pathname } = await redirectTarget();

        expect(pathname).toBe(`/api/ytstream/${YT_ID}`);
      });

      it('uses direct mode, mp4 and 720p by default', async () => {
        const { params } = await redirectTarget();

        expect(params).toEqual({ mode: 'direct', quality: '720', container: 'mp4', transcode: 'copy' });
      });

      it('uses the configured ytstream settings', async () => {
        configModule.getConfig.mockReturnValue({ ytstream: { defaultMode: 'hls-buffer', container: 'ts', quality: '1080', transcode: 'h264' } });

        const { params } = await redirectTarget();

        expect(params).toEqual({ mode: 'hls-buffer', quality: '1080', container: 'ts', transcode: 'h264' });
      });

      it('falls back to the preferred resolution for the quality', async () => {
        configModule.getConfig.mockReturnValue({ preferredResolution: 480 });

        const { params } = await redirectTarget();

        expect(params.quality).toBe('480');
      });

      it.each([['h264', 'h264'], ['h265', 'h264'], ['av1', 'copy'], [undefined, 'copy']])('derives transcode from the %s download codec as %s', async (videoCodec, expected) => {
        configModule.getConfig.mockReturnValue({ videoCodec });

        const { params } = await redirectTarget();

        expect(params.transcode).toBe(expected);
      });

      it('does not serve any file for a STRM video', async () => {
        videoMetadataModule.getVideoStreamInfo.mockResolvedValue({ isStrm: true, filePath });

        const res = await get();

        expect(res.status).toBe(302);
        expect(res.headers['content-type']).not.toBe('video/mp4');
      });
    });

    describe('serving the whole file', () => {
      it('sends the file with its content type and length', async () => {
        const res = await get();

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('video/mp4');
        expect(res.headers['content-length']).toBe(String(CONTENT.length));
        expect(res.body.equals(CONTENT)).toBe(true);
      });

      it('advertises range support and forbids caching', async () => {
        const res = await get();

        expect(res.headers['accept-ranges']).toBe('bytes');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers.pragma).toBe('no-cache');
      });

      it('answers 500 when the file cannot be read', async () => {
        videoMetadataModule.getVideoStreamInfo.mockResolvedValue(streamInfo({ filePath: path.join(dir, 'gone.mp4') }));

        const res = await get();

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Error reading file' });
        expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), 'Stream read error');
      });

      it('labels the read error as JSON rather than as the video', async () => {
        videoMetadataModule.getVideoStreamInfo.mockResolvedValue(streamInfo({ filePath: path.join(dir, 'gone.mp4') }));

        const res = await get();

        expect(res.headers['content-type']).toMatch(/application\/json/);
      });
    });

    describe('serving a byte range', () => {
      const ranged = (range) => supertest(makeApp()).get(`/api/videos/${YT_ID}/stream`).set('Range', range).buffer(true).parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

      it('answers a read error on a range request with JSON and no content range', async () => {
        videoMetadataModule.getVideoStreamInfo.mockResolvedValue(streamInfo({ filePath: path.join(dir, 'gone.mp4') }));

        const res = await ranged('bytes=2-5');

        expect(res.status).toBe(500);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.headers['content-range']).toBeUndefined();
      });

      it('returns the requested bytes with a content range', async () => {
        const res = await ranged('bytes=2-5');

        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 2-5/20');
        expect(res.headers['content-length']).toBe('4');
        expect(res.body.toString()).toBe('2345');
      });

      it('reads to the end of the file for an open-ended range', async () => {
        const res = await ranged('bytes=15-');

        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 15-19/20');
        expect(res.body.toString()).toBe('fghij');
      });

      it('supports a single byte', async () => {
        const res = await ranged('bytes=0-0');

        expect(res.status).toBe(206);
        expect(res.body.toString()).toBe('0');
      });

      it('forbids caching of partial content too', async () => {
        const res = await ranged('bytes=0-3');

        expect(res.headers['cache-control']).toBe('no-store');
      });

      it('serves the last N bytes for a suffix range', async () => {
        const res = await ranged('bytes=-5');

        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 15-19/20');
        expect(res.body.toString()).toBe('fghij');
      });

      it('serves the whole file for a suffix range longer than the file', async () => {
        const res = await ranged('bytes=-500');

        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 0-19/20');
      });

      it.each([
        ['bytes=5-20', 'bytes 5-19/20', 15],
        ['bytes=5-999', 'bytes 5-19/20', 15],
        ['bytes=0-19', 'bytes 0-19/20', 20],
      ])('clamps %s to the end of the file', async (range, contentRange, length) => {
        const res = await ranged(range);

        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe(contentRange);
        expect(res.headers['content-length']).toBe(String(length));
      });

      it('serves only the first range of a multi-range request', async () => {
        const res = await ranged('bytes=0-3,10-12');

        expect(res.status).toBe(206);
        expect(res.headers['content-range']).toBe('bytes 0-3/20');
      });

      it.each([
        ['starts past the end of the file', 'bytes=20-25'],
        ['ends before it starts', 'bytes=10-5'],
        ['is not numeric', 'bytes=abc-def'],
        ['has two dashes', 'bytes=-5-10'],
        ['has no numbers', 'bytes=-'],
        ['asks for the last zero bytes', 'bytes=-0'],
      ])('answers 416 with the file size for a range that %s', async (_label, range) => {
        const res = await ranged(range);

        expect(res.status).toBe(416);
        expect(res.headers['content-range']).toBe('bytes */20');
      });

      it('answers 500 when the file cannot be read', async () => {
        videoMetadataModule.getVideoStreamInfo.mockResolvedValue(streamInfo({ filePath: path.join(dir, 'gone.mp4') }));

        const res = await supertest(makeApp()).get(`/api/videos/${YT_ID}/stream`).set('Range', 'bytes=0-3');

        expect(res.status).toBe(500);
        expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: YT_ID }), 'Stream read error');
      });
    });
  });
});
