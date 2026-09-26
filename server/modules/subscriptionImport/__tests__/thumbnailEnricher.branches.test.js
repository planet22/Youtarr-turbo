/* eslint-env jest */

jest.mock('https', () => ({ get: jest.fn() }));
jest.mock('../../../logger');

const https = require('https');
const { EventEmitter } = require('events');
const logger = require('../../../logger');
const { THUMBNAIL_MAX_BYTES, THUMBNAIL_FETCH_TIMEOUT_MS } = require('../constants');
const { enrichWithThumbnails } = require('../thumbnailEnricher');

const CHANNEL = { channelId: 'UC123', title: 'Chan', url: 'https://www.youtube.com/channel/UC123' };
const META = (url) => `<html><head><meta property="og:image" content="${url}"></head></html>`;

// Each request gets a scripted response: script(res, req) runs after the
// response callback so listeners are attached.
function respondWith(script, { statusCode = 200, headers = {} } = {}) {
  https.get.mockImplementation((url, options, cb) => {
    const req = new EventEmitter();
    req.destroy = jest.fn();
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers;
    res.destroy = jest.fn(() => setImmediate(() => res.emit('close')));
    setImmediate(() => {
      cb(res);
      script(res, req);
    });
    return req;
  });
}

const run = async () => (await enrichWithThumbnails([CHANNEL]))[0];

describe('thumbnailEnricher fetch branches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('asks for the channel page with the fetch timeout', async () => {
    respondWith((res) => { res.emit('data', Buffer.from(META('https://img/a.jpg'))); res.emit('end'); });

    await run();

    const [url, options] = https.get.mock.calls[0];
    expect(url).toBe('https://www.youtube.com/channel/UC123');
    expect(options).toEqual({ timeout: THUMBNAIL_FETCH_TIMEOUT_MS });
  });

  it('extracts the og:image from a body split across chunks', async () => {
    const body = Buffer.from(META('https://img/split.jpg'));
    respondWith((res) => { res.emit('data', body.subarray(0, 20)); res.emit('data', body.subarray(20)); res.emit('end'); });

    await expect(run()).resolves.toMatchObject({ thumbnailUrl: 'https://img/split.jpg' });
  });

  describe('the byte limit', () => {
    it('stops reading and uses the og:image found before the limit', async () => {
      const head = Buffer.from(META('https://img/early.jpg'));
      const padding = Buffer.alloc(THUMBNAIL_MAX_BYTES, 'x');
      respondWith((res) => { res.emit('data', Buffer.concat([head, padding.subarray(0, THUMBNAIL_MAX_BYTES - head.length)])); res.emit('data', Buffer.alloc(10)); });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: 'https://img/early.jpg' });
    });

    it('destroys the response once the limit is passed', async () => {
      let response;
      https.get.mockImplementation((url, options, cb) => {
        const req = new EventEmitter();
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.destroy = jest.fn(() => setImmediate(() => res.emit('close')));
        response = res;
        setImmediate(() => { cb(res); res.emit('data', Buffer.alloc(THUMBNAIL_MAX_BYTES + 1)); });
        return req;
      });

      await run();

      expect(response.destroy).toHaveBeenCalled();
    });

    it('warns and gives up when there is no og:image within the limit', async () => {
      respondWith((res) => { res.emit('data', Buffer.alloc(THUMBNAIL_MAX_BYTES + 1, 'x')); });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'UC123' }), 'thumbnailEnricher: og:image not found in response (byte limit reached)');
    });
  });

  describe('redirects', () => {
    it('follows one redirect to the new location', async () => {
      let call = 0;
      https.get.mockImplementation((url, options, cb) => {
        const req = new EventEmitter();
        req.destroy = jest.fn();
        const res = new EventEmitter();
        res.destroy = jest.fn(() => setImmediate(() => res.emit('close')));
        call += 1;
        if (call === 1) {
          res.statusCode = 301;
          res.headers = { location: 'https://www.youtube.com/channel/UC123?moved=1' };
          setImmediate(() => cb(res));
        } else {
          res.statusCode = 200;
          res.headers = {};
          setImmediate(() => { cb(res); res.emit('data', Buffer.from(META('https://img/redirected.jpg'))); res.emit('end'); });
        }
        return req;
      });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: 'https://img/redirected.jpg' });
      expect(https.get.mock.calls[1][0]).toBe('https://www.youtube.com/channel/UC123?moved=1');
    });

    it('does not follow a second redirect', async () => {
      respondWith(() => {}, { statusCode: 302, headers: { location: 'https://elsewhere/' } });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(https.get).toHaveBeenCalledTimes(2);
    });

    it('treats a redirect with no location as a failure', async () => {
      respondWith(() => {}, { statusCode: 301, headers: {} });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(https.get).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith({ channelId: 'UC123', statusCode: 301 }, 'thumbnailEnricher: non-200 response');
    });
  });

  describe('failures', () => {
    it('warns and returns null for a non-200 status', async () => {
      respondWith(() => {}, { statusCode: 500 });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(logger.warn).toHaveBeenCalledWith({ channelId: 'UC123', statusCode: 500 }, 'thumbnailEnricher: non-200 response');
    });

    it('warns with a snippet when the page has no og:image', async () => {
      respondWith((res) => { res.emit('data', Buffer.from('<html>\nno image here</html>')); res.emit('end'); });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      const [context] = logger.warn.mock.calls.find(([, msg]) => msg === 'thumbnailEnricher: og:image not found in response');
      expect(context.snippet).toBe('<html> no image here</html>');
    });

    it('warns and returns null when the response stream errors', async () => {
      respondWith((res) => { res.emit('error', new Error('reset')); });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'UC123' }), 'thumbnailEnricher: response stream error');
    });

    it('returns null when the connection closes early', async () => {
      respondWith((res) => { res.emit('close'); });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
    });

    it('destroys the request and returns null on a socket timeout', async () => {
      let request;
      https.get.mockImplementation(() => {
        request = new EventEmitter();
        request.destroy = jest.fn();
        setImmediate(() => request.emit('timeout'));
        return request;
      });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(request.destroy).toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith({ channelId: 'UC123' }, 'thumbnailEnricher: socket timeout');
    });

    it('warns and returns null when the request itself errors', async () => {
      https.get.mockImplementation(() => {
        const req = new EventEmitter();
        setImmediate(() => req.emit('error', new Error('ECONNRESET')));
        return req;
      });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'UC123' }), 'thumbnailEnricher: request error');
    });

    it('warns and returns null when starting the request throws', async () => {
      https.get.mockImplementation(() => { throw new Error('bad url'); });

      await expect(run()).resolves.toMatchObject({ thumbnailUrl: null });
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'UC123' }), 'thumbnailEnricher: unexpected error in fetchOgImage');
    });
  });

  describe('hard deadline', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('gives up when a request never answers', async () => {
      https.get.mockImplementation(() => new EventEmitter());
      const pending = enrichWithThumbnails([CHANNEL]);

      await jest.advanceTimersByTimeAsync(THUMBNAIL_FETCH_TIMEOUT_MS + 2000);

      await expect(pending).resolves.toEqual([{ ...CHANNEL, thumbnailUrl: null }]);
      expect(logger.warn).toHaveBeenCalledWith({ channelId: 'UC123' }, 'thumbnailEnricher: hard deadline exceeded');
    });
  });

  describe('summary logging', () => {
    it('logs the first failure once and the totals at the end', async () => {
      respondWith(() => {}, { statusCode: 404 });

      await enrichWithThumbnails([CHANNEL, { ...CHANNEL, channelId: 'UC456' }]);

      const firstFailureLogs = logger.info.mock.calls.filter(([, msg]) => String(msg).includes('first thumbnail failure'));
      expect(firstFailureLogs).toHaveLength(1);
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ channelCount: 2, successCount: 0, failCount: 2 }), 'thumbnailEnricher: enrichment complete');
    });

    it('keeps the other fields of each channel', async () => {
      respondWith((res) => { res.emit('data', Buffer.from(META('https://img/a.jpg'))); res.emit('end'); });

      await expect(enrichWithThumbnails([CHANNEL])).resolves.toEqual([{ ...CHANNEL, thumbnailUrl: 'https://img/a.jpg' }]);
    });

    it('returns an empty list for missing input', async () => {
      await expect(enrichWithThumbnails(null)).resolves.toEqual([]);
      expect(https.get).not.toHaveBeenCalled();
    });
  });
});
