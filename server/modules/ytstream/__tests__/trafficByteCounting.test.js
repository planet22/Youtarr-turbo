/* eslint-env jest */
// Pushes real HTTP traffic through the paths that feed the Streaming page's
// "Total" and throughput, and checks the counted bytes against what a client
// actually received.
jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../../messageEmitter', () => ({ emitMessage: jest.fn() }));
jest.mock('../../youtubeMetadataCache', () => ({ getCachedTitle: jest.fn() }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { serveFileWithRangeSupport } = require('../rangeFileServe');
const { tryServeCachedVideoFile } = require('../cacheFinalize');
const { proxyDirectStream } = require('../directMode');
const { beginCacheHit, resetCacheHitRows } = require('../byteRangeCacheHitRow');
const { createBytesCounter, trackStream, getStream, listStreams, untrackStream } = require('../activeStreams');

const MB = 1024 * 1024;

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function request(port, { path: urlPath = '/', headers = {}, abortAfterBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (abortAfterBytes !== null && received >= abortAfterBytes) {
          req.destroy();
          resolve({ status: res.statusCode, received, aborted: true });
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, received, aborted: false }));
      res.on('error', () => resolve({ status: res.statusCode, received, aborted: true }));
    });
    req.on('error', (err) => { if (abortAfterBytes === null) reject(err); });
  });
}

const closeServer = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });

describe('byte counting against real traffic', () => {
  let dir;
  let filePath;
  const FILE_BYTES = 8 * MB + 12345;
  const servers = [];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-count-'));
    filePath = path.join(dir, 'video.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(FILE_BYTES, 7));
  });

  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  afterEach(async () => {
    while (servers.length) await closeServer(servers.pop());
    resetCacheHitRows();
    listStreams().forEach((entry) => untrackStream(entry.streamId, 'promoted'));
  });

  async function serve(app) {
    const { server, port } = await listen(app);
    servers.push(server);
    return port;
  }

  describe('serveFileWithRangeSupport (byte-range, download-cache)', () => {
    const appWith = (counter) => {
      const app = express();
      app.get('/f', (req, res) => serveFileWithRangeSupport(filePath, req, res, 'video/mp4', undefined, counter));
      return app;
    };

    it('counts a whole-file response exactly', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      const result = await request(port, { path: '/f' });
      expect(entry.bytesTransferred).toBe(result.received);
    });

    it('counts a ranged response by what it sent, not by the file size', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      const result = await request(port, { path: '/f', headers: { Range: 'bytes=1000-1999' } });
      expect([result.received, entry.bytesTransferred]).toEqual([1000, 1000]);
    });

    it('counts an open-ended range from the middle of the file', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      const result = await request(port, { path: '/f', headers: { Range: `bytes=${4 * MB}-` } });
      expect(entry.bytesTransferred).toBe(result.received);
    });

    it('adds up several requests on one row', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      await request(port, { path: '/f', headers: { Range: 'bytes=0-999' } });
      await request(port, { path: '/f', headers: { Range: 'bytes=5000-5999' } });
      expect(entry.bytesTransferred).toBe(2000);
    });

    it('for a client that aborts, counts no more than the file and at least what arrived', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      const result = await request(port, { path: '/f', abortAfterBytes: 256 * 1024 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(entry.bytesTransferred).toBeGreaterThanOrEqual(result.received);
      expect(entry.bytesTransferred).toBeLessThan(FILE_BYTES);
    });
  });

  describe('tryServeCachedVideoFile (cached-file, probe cache hit)', () => {
    const appWith = (counter) => {
      const app = express();
      app.get('/f', async (req, res) => { await tryServeCachedVideoFile(req, res, filePath, counter); });
      return app;
    };

    it('counts a whole-file response exactly', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      const result = await request(port, { path: '/f' });
      expect(entry.bytesTransferred).toBe(result.received);
    });

    it('counts a ranged response exactly', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      const result = await request(port, { path: '/f', headers: { Range: 'bytes=100-4195' } });
      expect([result.received, entry.bytesTransferred]).toEqual([4096, 4096]);
    });

    it('counts nothing for a range that cannot be satisfied', async () => {
      const entry = { bytesTransferred: 0 };
      const port = await serve(appWith(createBytesCounter(entry)));
      await request(port, { path: '/f', headers: { Range: `bytes=${FILE_BYTES + 10}-` } });
      expect(entry.bytesTransferred).toBe(0);
    });

    it('still serves when no counter is given', async () => {
      const port = await serve(appWith(undefined));
      expect((await request(port, { path: '/f' })).received).toBe(FILE_BYTES);
    });
  });

  describe('proxyDirectStream (direct)', () => {
    function upstreamApp() {
      const app = express();
      app.get('/media', (req, res) => {
        const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        if (!match) {
          res.set({ 'Content-Type': 'video/mp4', 'Content-Length': String(FILE_BYTES) }).status(200);
          fs.createReadStream(filePath).pipe(res);
          return;
        }
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : FILE_BYTES - 1;
        res.set({ 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${FILE_BYTES}` }).status(206);
        fs.createReadStream(filePath, { start, end }).pipe(res);
      });
      app.get('/hop', (req, res) => res.redirect(302, '/media'));
      app.get('/gone', (req, res) => res.status(404).end('nope'));
      return app;
    }

    async function proxyOf(upstreamPort, upstreamPath, counter) {
      const app = express();
      app.get('/p', async (req, res) => {
        try {
          await proxyDirectStream(`http://127.0.0.1:${upstreamPort}${upstreamPath}`, req, res, null, undefined, counter);
        } catch (err) {
          if (!res.headersSent) res.status(502).end();
        }
      });
      return serve(app);
    }

    it('counts the relayed body exactly', async () => {
      const upstream = await serve(upstreamApp());
      const entry = { bytesTransferred: 0 };
      const port = await proxyOf(upstream, '/media', createBytesCounter(entry));
      const result = await request(port, { path: '/p' });
      expect([result.received, entry.bytesTransferred]).toEqual([FILE_BYTES, FILE_BYTES]);
    });

    it('counts a forwarded Range by what the upstream sent', async () => {
      const upstream = await serve(upstreamApp());
      const entry = { bytesTransferred: 0 };
      const port = await proxyOf(upstream, '/media', createBytesCounter(entry));
      const result = await request(port, { path: '/p', headers: { Range: 'bytes=2000-2999' } });
      expect([result.received, entry.bytesTransferred]).toEqual([1000, 1000]);
    });

    it('counts the body once when the upstream redirects first', async () => {
      const upstream = await serve(upstreamApp());
      const entry = { bytesTransferred: 0 };
      const port = await proxyOf(upstream, '/hop', createBytesCounter(entry));
      const result = await request(port, { path: '/p' });
      expect([result.received, entry.bytesTransferred]).toEqual([FILE_BYTES, FILE_BYTES]);
    });

    it('counts nothing when the upstream refuses', async () => {
      const upstream = await serve(upstreamApp());
      const entry = { bytesTransferred: 0 };
      const port = await proxyOf(upstream, '/gone', createBytesCounter(entry));
      await request(port, { path: '/p' });
      expect(entry.bytesTransferred).toBe(0);
    });
  });

  describe('byte-range cache-hit row', () => {
    it('shows on the row exactly what the player received, across several requests', async () => {
      const app = express();
      app.get('/f', (req, res) => {
        const hit = beginCacheHit({ streamId: 'cachehit-x', youtubeId: 'vid00000001', quality: '1080', transcode: 'copy', container: 'mkv', clientIp: '1.2.3.4', userAgent: 'Lavf/62' }, res);
        serveFileWithRangeSupport(filePath, req, res, 'video/x-matroska', hit.onServed, hit.onBytesSent);
      });
      const port = await serve(app);
      const first = await request(port, { path: '/f', headers: { Range: 'bytes=0-1048575' } });
      const second = await request(port, { path: '/f', headers: { Range: `bytes=${2 * MB}-` } });
      expect(getStream('cachehit-x').bytesTransferred).toBe(first.received + second.received);
    });
  });

  describe('throughput', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const TICK_MS = 1500;

    function newRow() {
      const entry = {
        streamId: 'rate-1', mode: 'hls-byterange', youtubeId: 'vid00000001', state: 'active', startedAt: Date.now(),
        bytesTransferred: 0, bytesPerSecond: 0, lastActivityAt: Date.now(),
      };
      trackStream(entry);
      return entry;
    }

    it('reports the rate of a steady transfer over its sliding window', () => {
      const entry = newRow();
      const count = createBytesCounter(entry);
      for (let i = 0; i < 12; i += 1) {
        count(3 * MB);
        jest.advanceTimersByTime(TICK_MS);
      }
      expect(entry.bytesPerSecond).toBeCloseTo(2 * MB, -4);
    });

    it('decays to zero once the transfer stops', () => {
      const entry = newRow();
      const count = createBytesCounter(entry);
      for (let i = 0; i < 6; i += 1) {
        count(3 * MB);
        jest.advanceTimersByTime(TICK_MS);
      }
      jest.advanceTimersByTime(20 * 1000);
      expect(entry.bytesPerSecond).toBe(0);
    });

    it('smooths a burst instead of showing a spike then zero', () => {
      const entry = newRow();
      createBytesCounter(entry)(20 * MB);
      jest.advanceTimersByTime(TICK_MS);
      jest.advanceTimersByTime(TICK_MS);
      expect(entry.bytesPerSecond).toBeGreaterThan(0);
    });

    it('keeps a row at zero while nothing is sent', () => {
      const entry = newRow();
      jest.advanceTimersByTime(TICK_MS * 4);
      expect(entry.bytesPerSecond).toBe(0);
    });
  });
});
