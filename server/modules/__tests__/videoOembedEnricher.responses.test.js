/* eslint-env jest */

jest.mock('../download/tempPathManager', () => ({ getTempBasePath: jest.fn(() => '/tmp/youtarr-downloads') }));
jest.mock('../../logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('https', () => ({ get: jest.fn() }));

const https = require('https');
const { EventEmitter } = require('events');
const logger = require('../../logger');
const { enrichByIds } = require('../videoOembedEnricher');

const ID = 'dQw4w9WgXcQ';
const noWait = { waitForSlot: () => Promise.resolve() };

// Drives one oEmbed request with a hand-scripted response so every branch of
// the response handling (status, size cap, parsing, stream errors) is reached.
function scriptResponse(script, { statusCode = 200 } = {}) {
  https.get.mockImplementation((url, options, cb) => {
    const req = new EventEmitter();
    req.destroy = jest.fn();
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.resume = jest.fn();
    res.destroy = jest.fn(() => res.emit('close'));
    setImmediate(() => {
      cb(res);
      script(res, req);
    });
    return req;
  });
}

describe('videoOembedEnricher response handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const run = () => enrichByIds([ID], { rateLimiter: noWait });
  const json = (value) => Buffer.from(JSON.stringify(value));

  describe('successful responses', () => {
    it('returns the title and channel name', async () => {
      scriptResponse((res) => { res.emit('data', json({ title: 'T', author_name: 'A' })); res.emit('end'); });

      await expect(run()).resolves.toEqual({ [ID]: { title: 'T', channelName: 'A' } });
    });

    it('accepts a body that arrives in several chunks', async () => {
      const body = json({ title: 'T', author_name: 'A' });
      scriptResponse((res) => { res.emit('data', body.subarray(0, 5)); res.emit('data', body.subarray(5)); res.emit('end'); });

      await expect(run()).resolves.toEqual({ [ID]: { title: 'T', channelName: 'A' } });
    });

    it('accepts a response with only a title', async () => {
      scriptResponse((res) => { res.emit('data', json({ title: 'Only title' })); res.emit('end'); });

      await expect(run()).resolves.toEqual({ [ID]: { title: 'Only title', channelName: '' } });
    });

    it('accepts a response with only a channel name', async () => {
      scriptResponse((res) => { res.emit('data', json({ author_name: 'Only author' })); res.emit('end'); });

      await expect(run()).resolves.toEqual({ [ID]: { title: '', channelName: 'Only author' } });
    });

    it('ignores fields that are not strings', async () => {
      scriptResponse((res) => { res.emit('data', json({ title: 5, author_name: { name: 'x' } })); res.emit('end'); });

      await expect(run()).resolves.toEqual({});
    });

    it('omits a video whose response has neither field', async () => {
      scriptResponse((res) => { res.emit('data', json({ html: '<iframe/>' })); res.emit('end'); });

      await expect(run()).resolves.toEqual({});
    });
  });

  describe('status codes', () => {
    it.each([401, 403, 404])('omits the video quietly for %i', async (statusCode) => {
      scriptResponse(() => {}, { statusCode });

      await expect(run()).resolves.toEqual({});
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it.each([429, 500, 503])('omits the video and warns for %i', async (statusCode) => {
      scriptResponse(() => {}, { statusCode });

      await expect(run()).resolves.toEqual({});
      expect(logger.warn).toHaveBeenCalledWith({ videoId: ID, statusCode }, 'videoOembedEnricher: non-200 oembed response');
    });

    it('drains a non-200 response', async () => {
      let drained;
      https.get.mockImplementation((url, options, cb) => {
        const req = new EventEmitter();
        const res = new EventEmitter();
        res.statusCode = 500;
        res.resume = jest.fn();
        drained = res;
        setImmediate(() => cb(res));
        return req;
      });

      await run();

      expect(drained.resume).toHaveBeenCalled();
    });
  });

  describe('bad responses', () => {
    it('gives up on a response over 64KB', async () => {
      scriptResponse((res) => { res.emit('data', Buffer.alloc(64 * 1024 + 1)); });

      await expect(run()).resolves.toEqual({});
    });

    it('destroys an oversized response', async () => {
      let response;
      https.get.mockImplementation((url, options, cb) => {
        const req = new EventEmitter();
        const res = new EventEmitter();
        res.statusCode = 200;
        res.destroy = jest.fn(() => res.emit('close'));
        response = res;
        setImmediate(() => { cb(res); res.emit('data', Buffer.alloc(64 * 1024 + 1)); });
        return req;
      });

      await run();

      expect(response.destroy).toHaveBeenCalled();
    });

    it('accepts a response of exactly 64KB', async () => {
      const filler = 'x'.repeat(64 * 1024 - JSON.stringify({ title: 'T', author_name: 'A', pad: '' }).length);
      const body = Buffer.from(JSON.stringify({ title: 'T', author_name: 'A', pad: filler }));
      expect(body.length).toBe(64 * 1024);
      scriptResponse((res) => { res.emit('data', body); res.emit('end'); });

      await expect(run()).resolves.toEqual({ [ID]: { title: 'T', channelName: 'A' } });
    });

    it('warns and omits the video when the body is not JSON', async () => {
      scriptResponse((res) => { res.emit('data', Buffer.from('<html>')); res.emit('end'); });

      await expect(run()).resolves.toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ videoId: ID }), 'videoOembedEnricher: failed to parse oembed JSON');
    });

    it('warns and omits the video when the response stream errors', async () => {
      scriptResponse((res) => { res.emit('error', new Error('reset')); });

      await expect(run()).resolves.toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ videoId: ID }), 'videoOembedEnricher: response stream error');
    });

    it('omits the video when the connection closes before the body ends', async () => {
      scriptResponse((res) => { res.emit('data', json({ title: 'T' }).subarray(0, 4)); res.emit('close'); });

      await expect(run()).resolves.toEqual({});
    });
  });

  describe('request failures', () => {
    it('warns and omits the video when the request errors', async () => {
      https.get.mockImplementation(() => {
        const req = new EventEmitter();
        setImmediate(() => req.emit('error', new Error('ECONNREFUSED')));
        return req;
      });

      await expect(run()).resolves.toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ videoId: ID }), 'videoOembedEnricher: request error');
    });

    it('destroys the request and omits the video on a timeout', async () => {
      let request;
      https.get.mockImplementation(() => {
        request = new EventEmitter();
        request.destroy = jest.fn();
        setImmediate(() => request.emit('timeout'));
        return request;
      });

      await expect(run()).resolves.toEqual({});
      expect(request.destroy).toHaveBeenCalled();
    });

    it('warns and omits the video when starting the request throws', async () => {
      https.get.mockImplementation(() => { throw new Error('bad url'); });

      await expect(run()).resolves.toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ videoId: ID }), 'videoOembedEnricher: unexpected error');
    });

    it('asks oEmbed for the video with the 5 second socket timeout', async () => {
      scriptResponse((res) => { res.emit('data', json({ title: 'T' })); res.emit('end'); });

      await run();

      const [url, options] = https.get.mock.calls[0];
      expect(url).toBe(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${ID}&format=json`);
      expect(options).toEqual({ timeout: 5000 });
    });
  });

  describe('hard deadline', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('gives up after seven seconds when a request never answers', async () => {
      https.get.mockImplementation(() => new EventEmitter());
      const pending = run();

      await jest.advanceTimersByTimeAsync(7000);

      await expect(pending).resolves.toEqual({});
      expect(logger.warn).toHaveBeenCalledWith({ videoId: ID }, 'videoOembedEnricher: hard deadline exceeded');
    });

    it('does not give up before seven seconds', async () => {
      https.get.mockImplementation(() => new EventEmitter());
      run();

      await jest.advanceTimersByTimeAsync(6999);

      expect(logger.warn).not.toHaveBeenCalledWith({ videoId: ID }, 'videoOembedEnricher: hard deadline exceeded');
    });
  });
});
