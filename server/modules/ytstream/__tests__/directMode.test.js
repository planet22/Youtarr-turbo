/* eslint-env jest */

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

jest.mock('../../../logger');
jest.mock('https', () => ({ get: jest.fn() }));
jest.mock('http', () => ({ get: jest.fn() }));
jest.mock('../../ytDlpRunner', () => ({ run: jest.fn() }));
jest.mock('../ytdlpArgs', () => ({
  UPSTREAM_USER_AGENT: 'TestUA/1.0',
  buildBaseArgs: jest.fn(),
}));
jest.mock('../formatSelection', () => ({ getDirectFormatSelector: jest.fn() }));
jest.mock('../activeStreams', () => ({
  persistStreamHistoryStart: jest.fn(),
  persistStreamHistoryEnd: jest.fn(),
}));
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));

const https = require('https');
const http = require('http');
const logger = require('../../../logger');
const ytDlpRunner = require('../../ytDlpRunner');
const { buildBaseArgs } = require('../ytdlpArgs');
const { getDirectFormatSelector } = require('../formatSelection');
const { persistStreamHistoryStart, persistStreamHistoryEnd } = require('../activeStreams');
const {
  isManifestUrl,
  resolveDirectUrl,
  buildFfmpegUpstreamHeaders,
  redactFfArgsForLogging,
  redactIncomingHeadersForLogging,
  redactSensitiveQueryForLogging,
  redactUrlForLogging,
  proxyDirectStream,
  redirectToDirectUrl,
} = require('../directMode');

const VIDEO_URL = 'https://rr1.googlevideo.example/videoplayback?id=1';

describe('directMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buildBaseArgs.mockReturnValue(['--base']);
    getDirectFormatSelector.mockReturnValue('best[height<=1080]');
  });

  describe('isManifestUrl', () => {
    it.each([
      ['https://manifest.googlevideo.com/api/manifest/hls_playlist/x', true],
      ['https://x.example/video.m3u8', true],
      ['https://x.example/api/manifest/dash', true],
      ['https://x.example/videoplayback?id=1', false],
      ['', false],
      [null, false],
      [undefined, false],
    ])('classifies %p as manifest=%s', (url, expected) => {
      expect(isManifestUrl(url)).toBe(expected);
    });

    it('is case-insensitive', () => {
      expect(isManifestUrl('HTTPS://X.EXAMPLE/VIDEO.M3U8')).toBe(true);
    });
  });

  describe('resolveDirectUrl', () => {
    it('resolves the url with the format selector for the quality', async () => {
      ytDlpRunner.run.mockResolvedValue(`${VIDEO_URL}\n`);

      await expect(resolveDirectUrl('abc123DEF45', {}, '1080', undefined, 'fallback')).resolves.toBe(VIDEO_URL);

      expect(getDirectFormatSelector).toHaveBeenCalledWith('1080', 'fallback');
    });

    it('asks yt-dlp for just the url of the single video', async () => {
      ytDlpRunner.run.mockResolvedValue(VIDEO_URL);

      await resolveDirectUrl('abc123DEF45', { cfg: true }, '1080', 'tv', undefined);

      expect(buildBaseArgs).toHaveBeenCalledWith({ cfg: true }, { playerClient: 'tv' });
      expect(ytDlpRunner.run).toHaveBeenCalledWith(
        ['--base', '-f', 'best[height<=1080]', '-g', '--no-playlist', '--no-warnings', 'https://youtube.com/watch?v=abc123DEF45'],
        { timeoutMs: 90000 }
      );
    });

    it('prefers a manifest url when several urls come back', async () => {
      ytDlpRunner.run.mockResolvedValue(`${VIDEO_URL}\nhttps://x.example/stream.m3u8\nhttps://other.example/a`);

      await expect(resolveDirectUrl('abc123DEF45', {}, '1080')).resolves.toBe('https://x.example/stream.m3u8');
    });

    it('uses the first plain url when there is no manifest and warns about the rest', async () => {
      ytDlpRunner.run.mockResolvedValue(`${VIDEO_URL}\nhttps://other.example/audio`);

      await expect(resolveDirectUrl('abc123DEF45', {}, '1080')).resolves.toBe(VIDEO_URL);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }), expect.stringContaining('multiple URLs'));
    });

    it('ignores output lines that are not urls', async () => {
      ytDlpRunner.run.mockResolvedValue(`WARNING: something\r\n${VIDEO_URL}\r\n`);

      await expect(resolveDirectUrl('abc123DEF45', {}, '1080')).resolves.toBe(VIDEO_URL);
    });

    it('throws when yt-dlp returns no url', async () => {
      ytDlpRunner.run.mockResolvedValue('ERROR: nothing here');

      await expect(resolveDirectUrl('abc123DEF45', {}, '1080')).rejects.toThrow('yt-dlp -g returned no URL: ERROR: nothing here');
    });

    describe('retrying with the fallback player client', () => {
      it('retries once after a client/session error', async () => {
        ytDlpRunner.run
          .mockRejectedValueOnce(new Error('Sign in to confirm you are not a bot'))
          .mockResolvedValueOnce(VIDEO_URL);

        await expect(resolveDirectUrl('abc123DEF45', {}, '1080')).resolves.toBe(VIDEO_URL);

        expect(buildBaseArgs.mock.calls[0][1]).toEqual({ playerClient: undefined });
        expect(buildBaseArgs.mock.calls[1][1]).toEqual({ playerClient: 'android' });
      });

      it('does not retry when a player client was forced', async () => {
        ytDlpRunner.run.mockRejectedValue(new Error('Sign in to confirm you are not a bot'));

        await expect(resolveDirectUrl('abc123DEF45', {}, '1080', 'tv')).rejects.toThrow('not a bot');

        expect(ytDlpRunner.run).toHaveBeenCalledTimes(1);
      });

      it('does not retry an unrelated failure', async () => {
        ytDlpRunner.run.mockRejectedValue(new Error('Video unavailable'));

        await expect(resolveDirectUrl('abc123DEF45', {}, '1080')).rejects.toThrow('Video unavailable');

        expect(ytDlpRunner.run).toHaveBeenCalledTimes(1);
      });

      it('gives up if the retry also fails', async () => {
        ytDlpRunner.run.mockRejectedValue(new Error('page needs to be reloaded'));

        await expect(resolveDirectUrl('abc123DEF45', {}, '1080')).rejects.toThrow('page needs to be reloaded');

        expect(ytDlpRunner.run).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('buildFfmpegUpstreamHeaders', () => {
    it('sends the browser-like headers', () => {
      expect(buildFfmpegUpstreamHeaders()).toBe('User-Agent: TestUA/1.0\r\nReferer: https://youtube.com\r\nOrigin: https://youtube.com\r\n');
    });

    it('appends the cookie when given', () => {
      expect(buildFfmpegUpstreamHeaders('SID=abc')).toContain('Cookie: SID=abc\r\n');
    });
  });

  describe('redactFfArgsForLogging', () => {
    it('hides the cookie inside a headers blob', () => {
      const [redacted] = redactFfArgsForLogging(['User-Agent: x\r\nCookie: SID=secret; LOGIN=more\r\nOrigin: y\r\n']);

      expect(redacted).toContain('Cookie: [REDACTED]');
      expect(redacted).not.toContain('secret');
      expect(redacted).toContain('Origin: y');
    });

    it('leaves other args untouched', () => {
      expect(redactFfArgsForLogging(['-i', 'in.mp4', 42])).toEqual(['-i', 'in.mp4', 42]);
    });

    it('does not mutate the original args', () => {
      const args = ['Cookie: SID=secret'];

      redactFfArgsForLogging(args);

      expect(args[0]).toBe('Cookie: SID=secret');
    });
  });

  describe('redactIncomingHeadersForLogging', () => {
    it.each(['cookie', 'Authorization', 'proxy-authorization', 'X-Access-Token'])('redacts %s', (name) => {
      expect(redactIncomingHeadersForLogging({ [name]: 'secret' })[name]).toBe('[REDACTED]');
    });

    it('keeps ordinary headers', () => {
      expect(redactIncomingHeadersForLogging({ 'user-agent': 'Jellyfin', range: 'bytes=0-' })).toEqual({ 'user-agent': 'Jellyfin', range: 'bytes=0-' });
    });

    it.each([undefined, null])('returns an empty object for %p', (headers) => {
      expect(redactIncomingHeadersForLogging(headers)).toEqual({});
    });
  });

  describe('redactSensitiveQueryForLogging', () => {
    it.each(['key', 'token'])('redacts %s', (name) => {
      expect(redactSensitiveQueryForLogging({ [name]: 'secret-value', mode: 'direct' })).toEqual({
        [name]: '[REDACTED]',
        mode: 'direct',
      });
    });

    it('leaves an ordinary query untouched', () => {
      const query = { mode: 'direct', quality: '1080' };
      expect(redactSensitiveQueryForLogging(query)).toEqual(query);
    });

    it.each([undefined, null])('returns %p as-is', (query) => {
      expect(redactSensitiveQueryForLogging(query)).toBe(query);
    });
  });

  describe('redactUrlForLogging', () => {
    it('redacts a key query param, including a trailing .strm pipe-syntax User-Agent suffix', () => {
      const url = '/api/ytstream/abc123?mode=direct&key=secretkeyvalue%7CUser-Agent=Youtarr-Playback%2F1.0';
      const redacted = redactUrlForLogging(url);

      expect(redacted).toBe('/api/ytstream/abc123?mode=direct&key=[REDACTED]');
      expect(redacted).not.toContain('secretkeyvalue');
    });

    it('redacts a token query param', () => {
      expect(redactUrlForLogging('/api/ytstream/abc123?token=secrettoken&mode=direct')).toBe(
        '/api/ytstream/abc123?token=[REDACTED]&mode=direct'
      );
    });

    it('leaves a URL with neither param untouched', () => {
      const url = '/api/ytstream/abc123?mode=direct&quality=1080';
      expect(redactUrlForLogging(url)).toBe(url);
    });
  });

  describe('proxyDirectStream', () => {
    let upstreamReq;

    function makeRes() {
      const res = new PassThrough();
      res.status = jest.fn(() => res);
      res.set = jest.fn(() => res);
      res.headers = {};
      res.set.mockImplementation((k, v) => { res.headers[k] = v; return res; });
      res.chunks = [];
      res.on('data', (c) => res.chunks.push(c));
      return res;
    }

    function makeUpstream(statusCode, headers = {}, body = 'video-bytes') {
      const up = new PassThrough();
      up.statusCode = statusCode;
      up.headers = headers;
      jest.spyOn(up, 'resume');
      setImmediate(() => up.end(body));
      return up;
    }

    // mod.get(parsed, options, cb): answer with the given upstream response
    function respond(mod, ...upstreams) {
      let call = 0;
      mod.get.mockImplementation((_url, _opts, cb) => {
        upstreamReq = new EventEmitter();
        upstreamReq.destroy = jest.fn();
        const up = upstreams[Math.min(call++, upstreams.length - 1)];
        setImmediate(() => cb(up));
        return upstreamReq;
      });
    }

    it('streams the upstream body to the client and resolves when done', async () => {
      respond(https, makeUpstream(200, { 'content-type': 'video/mp4', 'content-length': '11' }));
      const res = makeRes();

      await proxyDirectStream(VIDEO_URL, { headers: {} }, res, null);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(Buffer.concat(res.chunks).toString()).toBe('video-bytes');
    });

    it('copies the relevant upstream headers only', async () => {
      respond(https, makeUpstream(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'x-secret': 'no', etag: '"1"' }));
      const res = makeRes();

      await proxyDirectStream(VIDEO_URL, { headers: {} }, res, null);

      expect(res.headers).toEqual({ 'content-type': 'video/mp4', 'accept-ranges': 'bytes', etag: '"1"' });
    });

    it('relays a partial content response', async () => {
      respond(https, makeUpstream(206, { 'content-range': 'bytes 0-3/10' }, 'abcd'));
      const res = makeRes();

      await proxyDirectStream(VIDEO_URL, { headers: { range: 'bytes=0-3' } }, res, null);

      expect(res.status).toHaveBeenCalledWith(206);
      expect(res.headers['content-range']).toBe('bytes 0-3/10');
    });

    it('sends browser-like headers and the cookie upstream', async () => {
      respond(https, makeUpstream(200));

      await proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), 'SID=abc');

      expect(https.get.mock.calls[0][1].headers).toEqual({
        'User-Agent': 'TestUA/1.0',
        Referer: 'https://youtube.com',
        Origin: 'https://youtube.com',
        Cookie: 'SID=abc',
      });
    });

    it('forwards the players range request', async () => {
      respond(https, makeUpstream(200));

      await proxyDirectStream(VIDEO_URL, { headers: { range: 'bytes=100-' } }, makeRes(), null);

      expect(https.get.mock.calls[0][1].headers.Range).toBe('bytes=100-');
    });

    it('omits the cookie and range when there are none', async () => {
      respond(https, makeUpstream(200));

      await proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null);

      expect(https.get.mock.calls[0][1].headers).not.toHaveProperty('Cookie');
      expect(https.get.mock.calls[0][1].headers).not.toHaveProperty('Range');
    });

    it('uses a 25 second timeout', async () => {
      respond(https, makeUpstream(200));

      await proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null);

      expect(https.get.mock.calls[0][1].timeout).toBe(25000);
    });

    it('uses plain http for an http url', async () => {
      respond(http, makeUpstream(200));

      await proxyDirectStream('http://cdn.example/video', { headers: {} }, makeRes(), null);

      expect(http.get).toHaveBeenCalled();
      expect(https.get).not.toHaveBeenCalled();
    });

    it('reports every byte relayed', async () => {
      respond(https, makeUpstream(200, {}, 'twelve-bytes'));
      const onBytesSent = jest.fn();

      await proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null, 5, onBytesSent);

      expect(onBytesSent.mock.calls.reduce((sum, [n]) => sum + n, 0)).toBe(12);
    });

    describe('redirects', () => {
      it('follows an upstream redirect, resolving a relative location', async () => {
        respond(https, makeUpstream(302, { location: '/final?x=1' }, ''), makeUpstream(200, {}, 'final-bytes'));
        const res = makeRes();

        await proxyDirectStream(VIDEO_URL, { headers: {} }, res, null);

        expect(https.get.mock.calls[1][0].href).toBe('https://rr1.googlevideo.example/final?x=1');
        expect(Buffer.concat(res.chunks).toString()).toBe('final-bytes');
      });

      it.each([301, 303, 307, 308])('follows a %i redirect', async (status) => {
        respond(https, makeUpstream(status, { location: 'https://cdn.example/x' }, ''), makeUpstream(200));

        await proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null);

        expect(https.get).toHaveBeenCalledTimes(2);
      });

      it('gives up following redirects after five hops', async () => {
        respond(https, ...Array.from({ length: 7 }, () => makeUpstream(302, { location: 'https://cdn.example/again' }, '')));
        const res = makeRes();

        const outcome = proxyDirectStream(VIDEO_URL, { headers: {} }, res, null);
        outcome.catch(() => {});
        await Promise.race([outcome, new Promise((resolve) => setTimeout(resolve, 100))]);

        // 1 original + 5 followed; the sixth 302 is relayed instead of followed
        expect(https.get).toHaveBeenCalledTimes(6);
      });
    });

    describe('failures', () => {
      it.each([403, 404, 500])('rejects an upstream %i with its status', async (status) => {
        respond(https, makeUpstream(status, {}, ''));

        const error = await proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null).catch((e) => e);

        expect(error.message).toBe(`Upstream returned HTTP ${status}`);
        expect(error.status).toBe(status);
      });

      it('rejects an invalid url', async () => {
        await expect(proxyDirectStream('not a url', { headers: {} }, makeRes(), null)).rejects.toThrow('Invalid upstream URL');
      });

      it('rejects on a request error', async () => {
        https.get.mockImplementation(() => {
          upstreamReq = new EventEmitter();
          upstreamReq.destroy = jest.fn();
          setImmediate(() => upstreamReq.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })));
          return upstreamReq;
        });

        await expect(proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null)).rejects.toThrow('ENOTFOUND');
      });

      it.each([
        [{ code: 'ECONNRESET', message: 'reset' }],
        [{ message: 'aborted' }],
      ])('resolves quietly when the connection is dropped (%j)', async (errorProps) => {
        https.get.mockImplementation(() => {
          upstreamReq = new EventEmitter();
          upstreamReq.destroy = jest.fn();
          setImmediate(() => upstreamReq.emit('error', Object.assign(new Error(errorProps.message), errorProps)));
          return upstreamReq;
        });

        await expect(proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null)).resolves.toBeUndefined();
      });

      it('destroys the request and rejects on timeout', async () => {
        https.get.mockImplementation(() => {
          upstreamReq = new EventEmitter();
          upstreamReq.destroy = jest.fn();
          setImmediate(() => upstreamReq.emit('timeout'));
          return upstreamReq;
        });

        await expect(proxyDirectStream(VIDEO_URL, { headers: {} }, makeRes(), null)).rejects.toThrow('Upstream request timed out');
        expect(upstreamReq.destroy).toHaveBeenCalled();
      });

      it('resolves quietly when the upstream body errors with a reset', async () => {
        const up = new PassThrough();
        up.statusCode = 200;
        up.headers = {};
        respond(https, up);
        const res = makeRes();

        const outcome = proxyDirectStream(VIDEO_URL, { headers: {} }, res, null);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        up.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }));

        await expect(outcome).resolves.toBeUndefined();
      });

      it('rejects when the upstream body fails for another reason', async () => {
        const up = new PassThrough();
        up.statusCode = 200;
        up.headers = {};
        respond(https, up);
        const res = makeRes();

        const outcome = proxyDirectStream(VIDEO_URL, { headers: {} }, res, null);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        up.emit('error', new Error('bad chunk'));

        await expect(outcome).rejects.toThrow('bad chunk');
      });

      it('stops the upstream request when the client disconnects early', async () => {
        const up = new PassThrough();
        up.statusCode = 200;
        up.headers = {};
        respond(https, up);
        const res = makeRes();

        const outcome = proxyDirectStream(VIDEO_URL, { headers: {} }, res, null);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        res.emit('close');

        await expect(outcome).resolves.toBeUndefined();
        expect(upstreamReq.destroy).toHaveBeenCalled();
      });
    });
  });

  describe('redirectToDirectUrl', () => {
    const req = { headers: { 'user-agent': 'Jellyfin' } };
    const resolveClientIp = jest.fn().mockReturnValue('10.0.0.9');
    let res;

    beforeEach(() => {
      res = { redirect: jest.fn() };
      ytDlpRunner.run.mockResolvedValue(VIDEO_URL);
    });

    it('redirects the player straight to the resolved url', async () => {
      await redirectToDirectUrl('abc123DEF45', {}, '1080', 'fallback', undefined, req, res, resolveClientIp);

      expect(res.redirect).toHaveBeenCalledWith(302, VIDEO_URL);
    });

    it('records a history row for the request', async () => {
      await redirectToDirectUrl('abc123DEF45', {}, '1080', 'fallback', undefined, req, res, resolveClientIp);

      expect(persistStreamHistoryStart).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'direct-redirect',
        youtubeId: 'abc123DEF45',
        quality: '1080',
        clientIp: '10.0.0.9',
        userAgent: 'Jellyfin',
        streamId: expect.any(String),
      }));
    });

    it('marks the history row redirected on success', async () => {
      await redirectToDirectUrl('abc123DEF45', {}, '1080', 'fallback', undefined, req, res, resolveClientIp);

      expect(persistStreamHistoryEnd).toHaveBeenCalledWith(persistStreamHistoryStart.mock.calls[0][0], 'redirected', null);
    });

    it('records the user agent as null when the client sent none', async () => {
      await redirectToDirectUrl('abc123DEF45', {}, '1080', 'fallback', undefined, { headers: {} }, res, resolveClientIp);

      expect(persistStreamHistoryStart.mock.calls[0][0].userAgent).toBeNull();
    });

    it('marks the history row as an error and rethrows when resolving fails', async () => {
      ytDlpRunner.run.mockRejectedValue(new Error('Video unavailable'));

      await expect(redirectToDirectUrl('abc123DEF45', {}, '1080', 'fallback', undefined, req, res, resolveClientIp)).rejects.toThrow('Video unavailable');

      expect(persistStreamHistoryEnd).toHaveBeenCalledWith(expect.anything(), 'error', 'Video unavailable');
      expect(res.redirect).not.toHaveBeenCalled();
    });
  });
});
