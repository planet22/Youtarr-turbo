/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

// Same load-time mock set as hlsEngine.bufferFinalize.test.js, plus the
// collaborators whose behavior these tests assert on. activeStreams.init is
// replaced so the test can capture the engine's private hlsSessions map and
// destroyHlsSession (the engine hands both to it from init()) - that is the
// seam that lets sessions be seeded without spawning real yt-dlp/ffmpeg.
jest.mock('child_process', () => ({ spawn: jest.fn(), spawnSync: jest.fn() }));
jest.mock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn().mockReturnValue({}),
  getCookiesPath: jest.fn().mockReturnValue(null),
  directoryPath: '',
}));
jest.mock('../../youtubeMetadataCache', () => ({
  clearCachedEntry: jest.fn(),
  countCached: jest.fn(),
  clearAll: jest.fn(),
  YOUTUBE_METADATA_CACHE_RETENTION_DAYS: 365,
}));
jest.mock('../activeStreams', () => ({
  init: jest.fn(),
  ensureHlsIdleReaper: jest.fn(),
  ensureProcessExitHandlers: jest.fn(),
  computeSegmentStatus: jest.fn(),
  trackStream: jest.fn(),
  untrackStream: jest.fn(),
  failStreamThenUntrack: jest.fn(),
  getStream: jest.fn(),
  createBytesCounter: jest.fn(() => jest.fn()),
}));
jest.mock('../processRegistry', () => ({
  registerChildProcess: jest.fn(),
  killChildProcess: jest.fn(),
  isFfmpegAvailable: jest.fn().mockReturnValue(true),
}));
jest.mock('../cacheFinalize', () => ({
  createCacheFinalize: jest.fn(() => ({
    resolveHlsBufferPromoteFn: jest.fn(),
    maybeRetroactivelyRemuxReusedCache: jest.fn(),
    maybeFinalizeTsToMp4: jest.fn(),
  })),
}));
jest.mock('../../tsRemuxCache', () => ({ findExistingSeekableMp4: jest.fn() }));

const configModule = require('../../configModule');
const activeStreams = require('../activeStreams');
const { killChildProcess } = require('../processRegistry');
const { findExistingSeekableMp4 } = require('../../tsRemuxCache');
const { createCacheFinalize } = require('../cacheFinalize');
const engine = require('../hlsEngine');

const SESSION_KEY = 'a'.repeat(20);
const YT_ID = 'dQw4w9WgXcQ';

// activeStreams.init receives { models, hlsSessions, destroyHlsSession }
engine.init({ models: {} });
const { hlsSessions, destroyHlsSession } = activeStreams.init.mock.calls[0][0];
const { resolveHlsBufferPromoteFn } = createCacheFinalize.mock.results[0].value;

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('hlsEngine sessions', () => {
  let workDir;

  function buildSession(overrides = {}) {
    return {
      key: SESSION_KEY,
      sessionKey: SESSION_KEY,
      dir: workDir,
      playlistPath: path.join(workDir, 'playlist.m3u8'),
      segmentExt: 'ts',
      segmentDurationSeconds: 4,
      youtubeId: YT_ID,
      state: 'ready',
      error: null,
      destroying: false,
      calculatedLength: false,
      hotSwapToCache: false,
      usingCachedSource: false,
      passGeneration: 0,
      lastAccess: 0,
      ytVideo: { id: 'v' },
      ytAudio: { id: 'a' },
      ff: { id: 'f' },
      infoJsonProc: { id: 'i' },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    hlsSessions.clear();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-engine-sessions-'));
    configModule.getConfig.mockReturnValue({});
    activeStreams.getStream.mockReturnValue(undefined);
    activeStreams.createBytesCounter.mockImplementation(() => jest.fn());
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('buildHlsSessionKey', () => {
    const base = { youtubeId: YT_ID, quality: '1080', transcode: 'copy', hardwareMode: 'none', tuning: 'balanced', container: 'mp4' };

    it('returns a 20 character hex key', () => {
      expect(engine.buildHlsSessionKey(base)).toMatch(/^[a-f0-9]{20}$/);
    });

    it('is deterministic for identical params', () => {
      expect(engine.buildHlsSessionKey({ ...base })).toBe(engine.buildHlsSessionKey({ ...base }));
    });

    it.each([
      ['youtubeId', { youtubeId: 'otherVideo12' }],
      ['quality', { quality: '720' }],
      ['transcode', { transcode: 'h264' }],
      ['hardwareMode', { hardwareMode: 'qsv' }],
      ['tuning', { tuning: 'fast' }],
      ['container', { container: 'ts' }],
      ['playerClient', { playerClient: 'android' }],
      ['calculatedLength', { calculatedLength: true }],
      ['buffer', { buffer: true }],
      ['qualityStrictness', { qualityStrictness: 'strict' }],
    ])('changes when %s changes', (_field, change) => {
      expect(engine.buildHlsSessionKey({ ...base, ...change })).not.toBe(engine.buildHlsSessionKey(base));
    });

    it('treats an omitted qualityStrictness as fallback', () => {
      expect(engine.buildHlsSessionKey({ ...base, qualityStrictness: 'fallback' })).toBe(engine.buildHlsSessionKey(base));
    });

    it('treats falsy calculatedLength/buffer values the same as omitted', () => {
      expect(engine.buildHlsSessionKey({ ...base, calculatedLength: 0, buffer: null })).toBe(engine.buildHlsSessionKey(base));
    });
  });

  describe('rewriteHlsPlaylistUrls', () => {
    const baseUrl = 'https://host/api/ytstream/id/hls/key/';

    it('prefixes relative segment lines with the base URL', () => {
      expect(engine.rewriteHlsPlaylistUrls('#EXTINF:4.0,\nsegment00000.ts\n', baseUrl)).toBe(`#EXTINF:4.0,\n${baseUrl}segment00000.ts\n`);
    });

    it('rewrites the URI of an EXT-X-MAP init segment', () => {
      expect(engine.rewriteHlsPlaylistUrls('#EXT-X-MAP:URI="init.mp4"', baseUrl)).toBe(`#EXT-X-MAP:URI="${baseUrl}init.mp4"`);
    });

    it('leaves an already-absolute EXT-X-MAP URI alone', () => {
      const line = '#EXT-X-MAP:URI="https://cdn.example/init.mp4"';

      expect(engine.rewriteHlsPlaylistUrls(line, baseUrl)).toBe(line);
    });

    it('leaves an already-absolute segment URL alone', () => {
      const line = 'http://cdn.example/segment00000.ts';

      expect(engine.rewriteHlsPlaylistUrls(line, baseUrl)).toBe(line);
    });

    it('leaves other tag lines and blank lines untouched', () => {
      const content = '#EXTM3U\n#EXT-X-VERSION:7\n\n#EXT-X-ENDLIST';

      expect(engine.rewriteHlsPlaylistUrls(content, baseUrl)).toBe(content);
    });

    it('rewrites every segment in a full playlist', () => {
      const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment00000.m4s\n#EXTINF:4,\nsegment00001.m4s\n#EXT-X-ENDLIST\n';

      const rewritten = engine.rewriteHlsPlaylistUrls(playlist, baseUrl);

      expect(rewritten.match(new RegExp(`${baseUrl}`, 'g'))).toHaveLength(3);
    });
  });

  describe('session lookup', () => {
    it('reports no active session for an unknown key', () => {
      expect(engine.isHlsSessionActive(SESSION_KEY)).toBe(false);
    });

    it('reports an active session in any state', () => {
      hlsSessions.set(SESSION_KEY, buildSession({ state: 'failed' }));

      expect(engine.isHlsSessionActive(SESSION_KEY)).toBe(true);
    });

    it('finds a live session for a video', () => {
      hlsSessions.set(SESSION_KEY, buildSession());

      expect(engine.hasActiveHlsSessionForVideo(YT_ID)).toBe(true);
    });

    it('ignores sessions for other videos', () => {
      hlsSessions.set(SESSION_KEY, buildSession({ youtubeId: 'otherVideo12' }));

      expect(engine.hasActiveHlsSessionForVideo(YT_ID)).toBe(false);
    });

    it('ignores sessions that are being torn down', () => {
      hlsSessions.set(SESSION_KEY, buildSession({ destroying: true }));

      expect(engine.hasActiveHlsSessionForVideo(YT_ID)).toBe(false);
    });
  });

  describe('getOrCreateHlsSession with an existing session', () => {
    it('returns a ready session', async () => {
      const session = buildSession();
      hlsSessions.set(SESSION_KEY, session);

      await expect(engine.getOrCreateHlsSession(SESSION_KEY, {})).resolves.toBe(session);
    });

    it('refreshes its last access time', async () => {
      const session = buildSession({ lastAccess: 0 });
      hlsSessions.set(SESSION_KEY, session);

      await engine.getOrCreateHlsSession(SESSION_KEY, {});

      expect(session.lastAccess).toBeGreaterThan(0);
    });

    it('records a joining client as a viewer of the active stream', async () => {
      const viewers = new Map();
      activeStreams.getStream.mockReturnValue({ viewers });
      hlsSessions.set(SESSION_KEY, buildSession());

      await engine.getOrCreateHlsSession(SESSION_KEY, { clientIp: '10.0.0.9', userAgent: 'Jellyfin' });

      expect(viewers.get('10.0.0.9')).toMatchObject({ userAgent: 'Jellyfin' });
    });

    it('does not record a viewer when the client ip is unknown', async () => {
      const viewers = new Map();
      activeStreams.getStream.mockReturnValue({ viewers });
      hlsSessions.set(SESSION_KEY, buildSession());

      await engine.getOrCreateHlsSession(SESSION_KEY, {});

      expect(viewers.size).toBe(0);
    });

    it('waits for a starting session until its first segment exists', async () => {
      const session = buildSession({ state: 'starting' });
      fs.writeFileSync(session.playlistPath, '#EXTM3U');
      fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'x');
      hlsSessions.set(SESSION_KEY, session);

      await engine.getOrCreateHlsSession(SESSION_KEY, {});

      expect(session.state).toBe('ready');
    });

    it('does not treat a segment with the wrong extension as ready', async () => {
      jest.useFakeTimers();
      const session = buildSession({ state: 'starting', segmentExt: 'm4s' });
      fs.writeFileSync(session.playlistPath, '#EXTM3U');
      fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'x');
      hlsSessions.set(SESSION_KEY, session);

      const assertion = expect(engine.getOrCreateHlsSession(SESSION_KEY, {})).rejects.toThrow('did not produce a segment within 45000ms');
      await jest.advanceTimersByTimeAsync(46000);

      await assertion;
    });

    it('rejects with the session error when a starting session fails', async () => {
      const session = buildSession({ state: 'starting' });
      hlsSessions.set(SESSION_KEY, session);

      const promise = engine.getOrCreateHlsSession(SESSION_KEY, {});
      session.state = 'failed';
      session.error = 'ffmpeg exploded';

      await expect(promise).rejects.toThrow('ffmpeg exploded');
    });

    it('rejects with a generic message when a failing session has no error text', async () => {
      const session = buildSession({ state: 'starting' });
      hlsSessions.set(SESSION_KEY, session);

      const promise = engine.getOrCreateHlsSession(SESSION_KEY, {});
      session.state = 'failed';

      await expect(promise).rejects.toThrow('HLS session failed to start');
    });

    it('times out a starting session that never produces a segment', async () => {
      jest.useFakeTimers();
      hlsSessions.set(SESSION_KEY, buildSession({ state: 'starting' }));

      const assertion = expect(engine.getOrCreateHlsSession(SESSION_KEY, {})).rejects.toThrow('did not produce a segment within 45000ms');
      await jest.advanceTimersByTimeAsync(46000);

      await assertion;
    });
  });

  describe('getOrCreateHlsSessionForProbe with an existing session', () => {
    it('reuses a starting session immediately without waiting for a segment', async () => {
      const session = buildSession({ state: 'starting' });
      hlsSessions.set(SESSION_KEY, session);

      await expect(engine.getOrCreateHlsSessionForProbe(SESSION_KEY, { youtubeId: YT_ID })).resolves.toBe(session);
    });

    it('refreshes the last access time of the reused session', async () => {
      const session = buildSession({ lastAccess: 0 });
      hlsSessions.set(SESSION_KEY, session);

      await engine.getOrCreateHlsSessionForProbe(SESSION_KEY, { youtubeId: YT_ID });

      expect(session.lastAccess).toBeGreaterThan(0);
    });
  });

  describe('destroyHlsSession', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(fs, 'rm').mockImplementation((_p, _o, cb) => cb());
    });

    it('removes the session from the live map', () => {
      const session = buildSession();
      hlsSessions.set(SESSION_KEY, session);

      destroyHlsSession(session, 'idle');

      expect(hlsSessions.has(SESSION_KEY)).toBe(false);
    });

    it('flags the session as destroying so exit handlers do not report a crash', () => {
      const session = buildSession();

      destroyHlsSession(session, 'idle');

      expect(session.destroying).toBe(true);
    });

    it('kills the video, audio, ffmpeg and info-json processes with the reason', () => {
      const session = buildSession();

      destroyHlsSession(session, 'idle');

      expect(killChildProcess.mock.calls.map(([, label]) => label)).toEqual([
        'hls-ytdlp-video:idle',
        'hls-ytdlp-audio:idle',
        'hls-ffmpeg:idle',
        'hls-ytdlp-infojson:idle',
      ]);
    });

    it('untracks the stream with the reason and session error', () => {
      const session = buildSession({ error: 'boom' });

      destroyHlsSession(session, 'idle');

      expect(activeStreams.untrackStream).toHaveBeenCalledWith(SESSION_KEY, 'idle', 'boom');
    });

    it('untracks with a null error when the session has none', () => {
      destroyHlsSession(buildSession(), 'idle');

      expect(activeStreams.untrackStream).toHaveBeenCalledWith(SESSION_KEY, 'idle', null);
    });

    it('shows a lingering failed row for ready-failed instead of untracking immediately', () => {
      destroyHlsSession(buildSession({ error: 'no segment' }), 'ready-failed');

      expect(activeStreams.failStreamThenUntrack).toHaveBeenCalledWith(SESSION_KEY, 'ready-failed', 'no segment');
      expect(activeStreams.untrackStream).not.toHaveBeenCalled();
    });

    it('keeps the session directory until the process kill grace period has passed', () => {
      destroyHlsSession(buildSession(), 'idle');
      jest.advanceTimersByTime(3000);

      expect(fs.rm).not.toHaveBeenCalled();
    });

    it('removes the session directory after the grace period', () => {
      destroyHlsSession(buildSession(), 'idle');
      jest.advanceTimersByTime(3500);

      expect(fs.rm).toHaveBeenCalledWith(workDir, { recursive: true, force: true }, expect.any(Function));
    });

    it('marks the session torn down after the grace period', () => {
      const session = buildSession();

      destroyHlsSession(session, 'idle');
      jest.advanceTimersByTime(3500);

      expect(session.hlsTornDown).toBe(true);
    });

    it('also removes the buffer scratch dir once the buffer fetch has settled', () => {
      const bufferDir = path.join(workDir, 'buffer');
      const session = buildSession({ bufferDir, bufferFetchSettled: true });

      destroyHlsSession(session, 'idle');
      jest.advanceTimersByTime(3500);

      expect(fs.rm).toHaveBeenCalledWith(bufferDir, { recursive: true, force: true }, expect.any(Function));
    });

    it('keeps the buffer scratch dir while its fetch is still running', () => {
      const bufferDir = path.join(workDir, 'buffer');
      const session = buildSession({ bufferDir, bufferFetchSettled: false });

      destroyHlsSession(session, 'idle');
      jest.advanceTimersByTime(3500);

      expect(fs.rm).not.toHaveBeenCalledWith(bufferDir, expect.anything(), expect.anything());
    });

    describe('teardown promotion retry', () => {
      const cachedFilePath = '/cache/dQw4w9WgXcQ.ts';
      let promoteFn;

      beforeEach(() => {
        promoteFn = jest.fn().mockResolvedValue(undefined);
        resolveHlsBufferPromoteFn.mockReturnValue(promoteFn);
        configModule.getConfig.mockReturnValue({ ytstream: { finalizeToMp4: true } });
      });

      it('promotes the cached .ts once an mp4 already exists and the session is gone', () => {
        findExistingSeekableMp4.mockReturnValue('/cache/dQw4w9WgXcQ.mp4');

        destroyHlsSession(buildSession({ cachedFilePath }), 'idle');

        expect(promoteFn).toHaveBeenCalledWith(YT_ID, cachedFilePath, '/cache/dQw4w9WgXcQ.mp4', { youtubeId: YT_ID, sourceLabel: 'session-teardown' });
      });

      it('does nothing when no mp4 has been produced yet', () => {
        findExistingSeekableMp4.mockReturnValue(null);

        destroyHlsSession(buildSession({ cachedFilePath }), 'idle');

        expect(promoteFn).not.toHaveBeenCalled();
      });

      it('does nothing when finalizeToMp4 is off', () => {
        configModule.getConfig.mockReturnValue({ ytstream: { finalizeToMp4: false } });
        findExistingSeekableMp4.mockReturnValue('/cache/dQw4w9WgXcQ.mp4');

        destroyHlsSession(buildSession({ cachedFilePath }), 'idle');

        expect(promoteFn).not.toHaveBeenCalled();
      });

      it('does nothing for a cached source that is not a .ts', () => {
        findExistingSeekableMp4.mockReturnValue('/cache/dQw4w9WgXcQ.mp4');

        destroyHlsSession(buildSession({ cachedFilePath: '/cache/video.mp4' }), 'idle');

        expect(promoteFn).not.toHaveBeenCalled();
      });

      it('does not let a rejected promotion escape teardown', async () => {
        promoteFn.mockRejectedValue(new Error('rename failed'));
        findExistingSeekableMp4.mockReturnValue('/cache/dQw4w9WgXcQ.mp4');

        expect(() => destroyHlsSession(buildSession({ cachedFilePath }), 'idle')).not.toThrow();
        await jest.advanceTimersByTimeAsync(0);
      });
    });
  });

  describe('HLS asset route handler', () => {
    const resolveClientIp = jest.fn().mockReturnValue('10.0.0.7');
    let handler;

    function makeReq(filename, overrides = {}) {
      return { params: { sessionKey: SESSION_KEY, filename }, headers: {}, ...overrides };
    }

    // A writable response that records status/headers/body, ending when the
    // handler pipes a file through it or calls send/end.
    function makeRes() {
      const res = new PassThrough();
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.headersSent = false;
      res.finished = false;
      res.status = jest.fn(() => res);
      res.send = jest.fn(() => { res.finished = true; return res; });
      res.set = jest.fn(() => res);
      res.on('end', () => { res.finished = true; });
      res.body = () => Buffer.concat(chunks).toString('utf8');
      return res;
    }

    async function run(req, res = makeRes()) {
      await handler(req, res);
      await waitFor(() => res.finished || res.status.mock.calls.length > 0);
      return res;
    }

    beforeEach(() => {
      handler = engine.createHlsAssetRouteHandler({ resolveClientIp });
    });

    describe('request validation', () => {
      it('rejects a malformed session key with 400', async () => {
        const res = await run(makeReq('playlist.m3u8', { params: { sessionKey: '../etc', filename: 'playlist.m3u8' } }));

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.send).toHaveBeenCalledWith('Invalid session key');
      });

      it.each(['../../etc/passwd', 'segment1.ts', 'segment00001.mp4', 'playlist.m3u8.bak', 'init.mp3', 'other.ts'])(
        'rejects the filename %s with 400',
        async (filename) => {
          const res = await run(makeReq(filename));

          expect(res.status).toHaveBeenCalledWith(400);
          expect(res.send).toHaveBeenCalledWith('Invalid filename');
        }
      );

      it('responds 404 for a session that does not exist', async () => {
        const res = await run(makeReq('playlist.m3u8'));

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.send).toHaveBeenCalledWith('HLS session not found or expired');
      });
    });

    describe('serving files', () => {
      beforeEach(() => {
        hlsSessions.set(SESSION_KEY, buildSession());
      });

      it('serves the playlist body', async () => {
        fs.writeFileSync(path.join(workDir, 'playlist.m3u8'), '#EXTM3U\n');

        const res = await run(makeReq('playlist.m3u8'));
        await waitFor(() => res.body().length > 0);

        expect(res.body()).toBe('#EXTM3U\n');
      });

      it('serves the playlist as non-cacheable HLS', async () => {
        fs.writeFileSync(path.join(workDir, 'playlist.m3u8'), '#EXTM3U\n');

        const res = await run(makeReq('playlist.m3u8'));

        expect(res.set).toHaveBeenCalledWith({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': '8',
          'Cache-Control': 'no-store',
        });
      });

      it('serves a .ts segment as immutable video/mp2t', async () => {
        fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'segment-bytes');

        const res = await run(makeReq('segment00000.ts'));

        expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
          'Content-Type': 'video/mp2t',
          'Cache-Control': 'public, max-age=31536000, immutable',
        }));
      });

      it('serves an .m4s segment as immutable video/mp4', async () => {
        fs.writeFileSync(path.join(workDir, 'segment00003.m4s'), 'fmp4-bytes');

        const res = await run(makeReq('segment00003.m4s'));

        expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'video/mp4', 'Content-Length': '10' }));
      });

      it('serves a non-empty init segment as video/mp4', async () => {
        fs.writeFileSync(path.join(workDir, 'init.mp4'), 'init-bytes');

        const res = await run(makeReq('init.mp4'));

        expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'video/mp4' }));
      });

      it('responds 404 when the segment is not on disk', async () => {
        const res = await run(makeReq('segment00009.ts'));

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.send).toHaveBeenCalledWith('Segment not found');
      });

      it('gives up waiting for the init segment straight away when the session is being destroyed', async () => {
        hlsSessions.set(SESSION_KEY, buildSession({ destroying: true }));

        const res = await run(makeReq('init.mp4'));

        expect(res.status).toHaveBeenCalledWith(404);
      });

      it('refreshes the session last access time', async () => {
        const session = hlsSessions.get(SESSION_KEY);
        fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'x');

        await run(makeReq('segment00000.ts'));

        expect(session.lastAccess).toBeGreaterThan(0);
      });

      it('remembers the last served segment index', async () => {
        const session = hlsSessions.get(SESSION_KEY);
        fs.writeFileSync(path.join(workDir, 'segment00004.ts'), 'x');

        await run(makeReq('segment00004.ts'));

        expect(session.lastServedSegmentIndex).toBe(4);
      });

      it('does not record a segment index when serving the playlist', async () => {
        const session = hlsSessions.get(SESSION_KEY);
        fs.writeFileSync(path.join(workDir, 'playlist.m3u8'), '#EXTM3U\n');

        await run(makeReq('playlist.m3u8'));

        expect(session.lastServedSegmentIndex).toBeUndefined();
      });

      it('marks the stream active and records the viewer', async () => {
        const viewers = new Map();
        const entry = { viewers, state: 'idle', lastActivityAt: 0 };
        activeStreams.getStream.mockReturnValue(entry);
        fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'x');

        await run(makeReq('segment00000.ts', { headers: { 'user-agent': 'Jellyfin/10.9' } }));

        expect(entry.state).toBe('active');
        expect(viewers.get('10.0.0.7')).toMatchObject({ userAgent: 'Jellyfin/10.9' });
      });

      it('counts the bytes streamed against the stream entry', async () => {
        const entry = { viewers: new Map() };
        const countBytes = jest.fn();
        activeStreams.getStream.mockReturnValue(entry);
        activeStreams.createBytesCounter.mockReturnValue(countBytes);
        fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'twelve-bytes');

        const res = await run(makeReq('segment00000.ts'));
        await waitFor(() => countBytes.mock.calls.length > 0 && res.body().length > 0);

        expect(countBytes).toHaveBeenCalledWith(12);
      });
    });

    describe('calculatedLength sessions', () => {
      it('serves a segment that already exists without restarting the encode', async () => {
        hlsSessions.set(SESSION_KEY, buildSession({ calculatedLength: true }));
        fs.writeFileSync(path.join(workDir, 'segment00002.ts'), 'x');

        const res = await run(makeReq('segment00002.ts'));

        expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'video/mp2t' }));
      });

      it('counts distinct requested segments toward a deferred buffer fetch without starting it early', async () => {
        const session = buildSession({ calculatedLength: true, bufferFetchPending: true, bufferStartAfterSegments: 3 });
        hlsSessions.set(SESSION_KEY, session);
        fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'x');
        fs.writeFileSync(path.join(workDir, 'segment00001.ts'), 'x');

        await run(makeReq('segment00000.ts'));
        await run(makeReq('segment00001.ts'));

        expect(session.requestedSegmentIndexes.size).toBe(2);
        expect(session.bufferFetchPending).toBe(true);
      });

      it('does not count a repeated request for the same segment twice', async () => {
        const session = buildSession({ calculatedLength: true, bufferFetchPending: true, bufferStartAfterSegments: 3 });
        hlsSessions.set(SESSION_KEY, session);
        fs.writeFileSync(path.join(workDir, 'segment00000.ts'), 'x');

        await run(makeReq('segment00000.ts'));
        await run(makeReq('segment00000.ts'));

        expect(session.requestedSegmentIndexes.size).toBe(1);
      });

      it('responds 404 once the wait for the pass already targeting that segment is abandoned', async () => {
        jest.useFakeTimers();
        hlsSessions.set(SESSION_KEY, buildSession({ calculatedLength: true, destroying: true, activePassStartIndex: 5 }));
        const res = makeRes();

        const pending = handler(makeReq('segment00005.ts'), res);
        await jest.advanceTimersByTimeAsync(3000);
        await pending;

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.send).toHaveBeenCalledWith('Segment not found');
      });
    });
  });
});
