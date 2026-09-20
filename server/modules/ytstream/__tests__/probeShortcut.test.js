/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const mockClipsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-shortcut-'));

jest.mock('../../../logger');
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn() }));
jest.mock('../paths', () => ({ YTSTREAM_CLIPS_DIR: mockClipsDir }));
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../videoResolution', () => ({ resolveVideoTargetResolution: jest.fn() }));
jest.mock('../hlsMasterPlaylist', () => ({ buildHlsTopLevelPlaylistResponse: jest.fn() }));
jest.mock('../../streamEncoderTuning', () => ({
  normalizeHardwareMode: (v) => v || 'none',
  normalizeTuning: (v) => v || 'balanced',
  buildVideoEncoderArgs: jest.fn(),
}));

const { spawn } = require('child_process');
const logger = require('../../../logger');
const configModule = require('../../configModule');
const { buildVideoEncoderArgs } = require('../../streamEncoderTuning');
const { buildHlsTopLevelPlaylistResponse } = require('../hlsMasterPlaylist');
const {
  isLikelyMetadataProbeRequest,
  evaluateProbeShortcut,
  shouldLogQuickServeHistory,
  hasRecentlyServedFakeProbeClip,
  ensureProbeClip,
  tryServeInstantHlsPlaylist,
} = require('../probeShortcut');

const req = (userAgent, query = {}) => ({ headers: userAgent === undefined ? {} : { 'user-agent': userAgent }, query });
const probeConfig = (ytstream = {}) => ({ ytstream: { probeShortcut: true, defaultMode: 'hls', transcode: 'h264', ...ytstream } });

describe('probeShortcut', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    configModule.getConfig.mockReturnValue({});
  });

  afterAll(() => {
    fs.rmSync(mockClipsDir, { recursive: true, force: true });
  });

  describe('isLikelyMetadataProbeRequest', () => {
    it.each(['Lavf/61.7.103', 'lavf/58.0', 'LAVF/1'])('flags the bare libavformat agent %s', (ua) => {
      expect(isLikelyMetadataProbeRequest(req(ua))).toBe(true);
    });

    it.each(['Jellyfin/10.9', 'Mozilla/5.0 Lavf/1', '', undefined])('does not flag %p', (ua) => {
      expect(isLikelyMetadataProbeRequest(req(ua))).toBe(false);
    });
  });

  describe('evaluateProbeShortcut', () => {
    it('would fire for a probe on a transcoding h264 mode', () => {
      const result = evaluateProbeShortcut(req('Lavf/61'), probeConfig());

      expect(result).toMatchObject({ wouldFire: true, isMetadataProbe: true, transcode: 'h264', mode: 'hls' });
    });

    it('would also fire for hls-buffer', () => {
      expect(evaluateProbeShortcut(req('Lavf/61'), probeConfig({ defaultMode: 'hls-buffer' })).wouldFire).toBe(true);
    });

    it('does not fire when probeShortcut is off', () => {
      const result = evaluateProbeShortcut(req('Lavf/61'), probeConfig({ probeShortcut: false }));

      expect(result).toMatchObject({ wouldFire: false, reason: 'probeShortcut is off' });
    });

    it('does not fire when the config has no ytstream section', () => {
      expect(evaluateProbeShortcut(req('Lavf/61'), {}).wouldFire).toBe(false);
    });

    it('does not fire for a request that is not a probe', () => {
      const result = evaluateProbeShortcut(req('Jellyfin/10.9'), probeConfig());

      expect(result.wouldFire).toBe(false);
      expect(result.reason).toContain('does not look like a metadata-probe request');
    });

    it.each(['direct', 'direct-redirect', 'hls-byterange', 'download-cache'])('does not fire for the never-transcoding mode %s', (mode) => {
      const result = evaluateProbeShortcut(req('Lavf/61'), probeConfig({ defaultMode: mode }));

      expect(result.wouldFire).toBe(false);
      expect(result.reason).toContain(`mode="${mode}" never transcodes`);
    });

    it('does not fire for a copy transcode', () => {
      const result = evaluateProbeShortcut(req('Lavf/61'), probeConfig({ transcode: 'copy' }));

      expect(result.wouldFire).toBe(false);
      expect(result.reason).toContain('transcode="copy"');
    });

    it('defaults to direct mode and copy transcode', () => {
      const result = evaluateProbeShortcut(req('Lavf/61'), { ytstream: { probeShortcut: true } });

      expect(result).toMatchObject({ mode: 'direct', transcode: 'copy' });
    });

    it('lets query params override the configured mode and transcode', () => {
      const result = evaluateProbeShortcut(req('Lavf/61', { mode: 'direct', transcode: 'copy' }), probeConfig());

      expect(result).toMatchObject({ mode: 'direct', transcode: 'copy', wouldFire: false });
    });

    it('lower-cases the requested mode', () => {
      expect(evaluateProbeShortcut(req('Lavf/61', { mode: 'HLS' }), probeConfig({ defaultMode: 'direct' })).mode).toBe('hls');
    });

    it('ignores an invalid transcode override', () => {
      expect(evaluateProbeShortcut(req('Lavf/61', { transcode: 'bogus' }), probeConfig()).transcode).toBe('h264');
    });

    it('ignores query overrides when server settings are forced', () => {
      const result = evaluateProbeShortcut(req('Lavf/61', { mode: 'direct', transcode: 'copy' }), probeConfig({ forceServerSettings: true }));

      expect(result).toMatchObject({ mode: 'hls', transcode: 'h264', wouldFire: true });
    });
  });

  describe('shouldLogQuickServeHistory', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('logs the first request for a video', () => {
      expect(shouldLogQuickServeHistory('first-video')).toBe(true);
    });

    it('suppresses a repeat within a minute', () => {
      shouldLogQuickServeHistory('burst-video');
      jest.advanceTimersByTime(30_000);

      expect(shouldLogQuickServeHistory('burst-video')).toBe(false);
    });

    it('logs again after the cooldown', () => {
      shouldLogQuickServeHistory('cooldown-video');
      jest.advanceTimersByTime(60_001);

      expect(shouldLogQuickServeHistory('cooldown-video')).toBe(true);
    });

    it('tracks each video separately', () => {
      shouldLogQuickServeHistory('video-one');

      expect(shouldLogQuickServeHistory('video-two')).toBe(true);
    });
  });

  describe('hasRecentlyServedFakeProbeClip', () => {
    it('is false, since the fake clip is no longer served', () => {
      expect(hasRecentlyServedFakeProbeClip('anything')).toBe(false);
    });
  });

  describe('ensureProbeClip', () => {
    const params = { hardwareMode: 'none', tuning: 'balanced', width: 1280, height: 720, container: 'mp4' };
    const clipPath = (signature, ext) => path.join(mockClipsDir, 'probe-shortcut', signature, `probe.${ext}`);

    beforeEach(() => {
      buildVideoEncoderArgs.mockReturnValue({
        preInputArgs: ['-hwaccel', 'x'],
        videoFilters: ['scale=1', 'format=yuv420p'],
        pixFmt: 'yuv420p',
        encoderArgs: ['-c:v', 'libx264'],
      });
      // ffmpeg "encodes" by writing its output (the last arg)
      spawn.mockImplementation((_cmd, args) => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = jest.fn();
        setImmediate(() => {
          fs.writeFileSync(args[args.length - 1], 'clip');
          proc.emit('close', 0);
        });
        return proc;
      });
    });

    afterEach(() => {
      fs.rmSync(path.join(mockClipsDir, 'probe-shortcut'), { recursive: true, force: true });
    });

    it('generates a clip named after its signature', async () => {
      const clip = await ensureProbeClip({ ...params, hardwareMode: 'vaapi', tuning: 'fast' });

      expect(clip).toEqual({ filePath: clipPath('vaapi-fast-1280x720-mp4', 'mp4'), signature: 'vaapi-fast-1280x720-mp4', container: 'mp4' });
      expect(fs.readFileSync(clip.filePath, 'utf8')).toBe('clip');
    });

    it('reuses an existing clip without running ffmpeg', async () => {
      await ensureProbeClip(params);
      spawn.mockClear();

      await ensureProbeClip(params);

      expect(spawn).not.toHaveBeenCalled();
    });

    it('shares one generation between concurrent requests', async () => {
      const [a, b] = await Promise.all([ensureProbeClip(params), ensureProbeClip(params)]);

      expect(a.filePath).toBe(b.filePath);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('builds a two second synthetic clip at the target resolution', async () => {
      await ensureProbeClip(params);

      const args = spawn.mock.calls[0][1];
      expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=2', '-t', '2', '-c:a', 'aac']));
      expect(args).toContain('anullsrc=r=48000:cl=stereo');
    });

    it('applies the encoder pre-input args, filter, pixel format and codec', async () => {
      await ensureProbeClip(params);

      const args = spawn.mock.calls[0][1];
      expect(args.slice(0, 5)).toEqual(['-y', '-loglevel', 'error', '-hwaccel', 'x']);
      expect(args).toEqual(expect.arrayContaining(['-vf', 'scale=1,format=yuv420p', '-pix_fmt', 'yuv420p', '-c:v', 'libx264']));
    });

    it('omits the filter and pixel format the encoder does not need', async () => {
      buildVideoEncoderArgs.mockReturnValue({ preInputArgs: [], videoFilters: [], pixFmt: null, encoderArgs: ['-c:v', 'libx264'] });

      await ensureProbeClip(params);

      const args = spawn.mock.calls[0][1];
      expect(args).not.toContain('-vf');
      expect(args).not.toContain('-pix_fmt');
    });

    it('passes the configured vaapi quality to the encoder builder', async () => {
      configModule.getConfig.mockReturnValue({ ytstream: { vaapiQuality: 5 } });

      await ensureProbeClip(params);

      expect(buildVideoEncoderArgs).toHaveBeenCalledWith('none', 720, 'balanced', 5);
    });

    it('muxes mp4 with faststart', async () => {
      await ensureProbeClip(params);

      const args = spawn.mock.calls[0][1];
      expect(args).toEqual(expect.arrayContaining(['-movflags', '+faststart', '-f', 'mp4']));
    });

    it.each([
      ['mkv', 'matroska'],
      ['ts', 'mpegts'],
    ])('muxes %s as %s without faststart', async (container, muxer) => {
      const clip = await ensureProbeClip({ ...params, container });

      const args = spawn.mock.calls[0][1];
      expect(args).toEqual(expect.arrayContaining(['-f', muxer]));
      expect(args).not.toContain('+faststart');
      expect(clip.filePath.endsWith(`probe.${container}`)).toBe(true);
    });

    it('falls back to mp4 for an unknown container', async () => {
      expect((await ensureProbeClip({ ...params, container: 'avi' })).container).toBe('mp4');
    });

    it('uses the debug container override when it is valid', async () => {
      configModule.getConfig.mockReturnValue({ ytstream: { probeShortcutContainerOverride: 'mkv' } });

      expect((await ensureProbeClip(params)).container).toBe('mkv');
    });

    it('ignores an invalid container override', async () => {
      configModule.getConfig.mockReturnValue({ ytstream: { probeShortcutContainerOverride: 'avi' } });

      expect((await ensureProbeClip({ ...params, container: 'ts' })).container).toBe('ts');
    });

    it('returns null and warns when ffmpeg fails', async () => {
      spawn.mockImplementation(() => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => { proc.stderr.emit('data', Buffer.from('Unknown encoder')); proc.emit('close', 1); });
        return proc;
      });

      await expect(ensureProbeClip(params)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns null when ffmpeg cannot be started', async () => {
      spawn.mockImplementation(() => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('error', new Error('spawn ffmpeg ENOENT')));
        return proc;
      });

      await expect(ensureProbeClip(params)).resolves.toBeNull();
    });

    it('returns null when ffmpeg succeeds but writes nothing', async () => {
      spawn.mockImplementation(() => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });

      await expect(ensureProbeClip(params)).resolves.toBeNull();
    });

    it('kills a hung ffmpeg and returns null after the timeout', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      const proc = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      spawn.mockReturnValue(proc);

      const pending = ensureProbeClip(params);
      while (!spawn.mock.calls.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await jest.advanceTimersByTimeAsync(30_001);

      await expect(pending).resolves.toBeNull();
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      jest.useRealTimers();
    });

    it('lets a later request retry after a failure', async () => {
      spawn.mockImplementationOnce(() => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        setImmediate(() => proc.emit('close', 1));
        return proc;
      });
      await ensureProbeClip(params);

      await expect(ensureProbeClip(params)).resolves.toMatchObject({ container: 'mp4' });
    });
  });

  describe('tryServeInstantHlsPlaylist', () => {
    let playlistPath;
    let res;
    let getOrCreateSession;
    let buildSessionKey;
    let rewritePlaylistUrls;

    const baseArgs = () => ({
      youtubeId: 'abc123DEF45',
      mode: 'hls',
      quality: '1080',
      qualityStrictness: 'fallback',
      transcode: 'h264',
      hardwareMode: 'none',
      tuning: 'balanced',
      container: 'mp4',
      playerClient: undefined,
      config: { ytstream: {} },
      models: {},
      clientIp: '10.0.0.1',
      userAgent: 'Lavf/61',
      buildSessionKey,
      getOrCreateSession,
      rewritePlaylistUrls,
    });
    const httpReq = () => ({ protocol: 'https', get: () => 'media.example.com', headers: { 'user-agent': 'Lavf/61' }, originalUrl: '/api/ytstream/x' });

    beforeEach(() => {
      playlistPath = path.join(mockClipsDir, 'playlist.m3u8');
      fs.writeFileSync(playlistPath, '#EXTM3U\nsegment00000.ts\n');
      res = { set: jest.fn(), send: jest.fn() };
      buildSessionKey = jest.fn().mockReturnValue('sessionkey');
      getOrCreateSession = jest.fn().mockResolvedValue({ playlistPath, baseUrl: 'https://media.example.com/api/ytstream/abc123DEF45/hls/sessionkey/' });
      rewritePlaylistUrls = jest.fn((content, base) => content.replace('segment', `${base}segment`));
      buildHlsTopLevelPlaylistResponse.mockResolvedValue('TOP-LEVEL');
    });

    it('serves the top-level playlist and reports it handled', async () => {
      await expect(tryServeInstantHlsPlaylist(httpReq(), res, baseArgs())).resolves.toBe(true);

      expect(res.send).toHaveBeenCalledWith('TOP-LEVEL');
      expect(res.set).toHaveBeenCalledWith({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    });

    it('builds the session key for a calculated-length, non-buffer session', async () => {
      await tryServeInstantHlsPlaylist(httpReq(), res, baseArgs());

      expect(buildSessionKey).toHaveBeenCalledWith(expect.objectContaining({ youtubeId: 'abc123DEF45', calculatedLength: true, buffer: false }));
    });

    it('marks a hls-buffer session as buffered', async () => {
      await tryServeInstantHlsPlaylist(httpReq(), res, { ...baseArgs(), mode: 'hls-buffer' });

      expect(buildSessionKey).toHaveBeenCalledWith(expect.objectContaining({ buffer: true }));
      expect(getOrCreateSession.mock.calls[0][1]).toMatchObject({ bufferEnabled: true });
    });

    it('creates the session with the public base url and probe options', async () => {
      await tryServeInstantHlsPlaylist(httpReq(), res, baseArgs());

      expect(getOrCreateSession).toHaveBeenCalledWith('sessionkey', expect.objectContaining({
        baseUrl: 'https://media.example.com/api/ytstream/abc123DEF45/hls/sessionkey/',
        calculatedLength: true,
        hotSwapToCache: false,
        seekSeconds: null,
        bufferEnabled: false,
        clientIp: '10.0.0.1',
      }));
    });

    it('rewrites the session playlist to absolute urls', async () => {
      await tryServeInstantHlsPlaylist(httpReq(), res, baseArgs());

      expect(rewritePlaylistUrls).toHaveBeenCalledWith('#EXTM3U\nsegment00000.ts\n', expect.stringContaining('/hls/sessionkey/'));
    });

    it('builds the top-level response around the media playlist', async () => {
      await tryServeInstantHlsPlaylist(httpReq(), res, baseArgs());

      expect(buildHlsTopLevelPlaylistResponse).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        youtubeId: 'abc123DEF45',
        quality: '1080',
        transcode: 'h264',
        hardwareMode: 'none',
        mediaPlaylistUrl: 'https://media.example.com/api/ytstream/abc123DEF45/hls/sessionkey/playlist.m3u8',
        rewrittenMediaPlaylist: expect.stringContaining('segment00000.ts'),
      }));
    });

    it('turns the master playlist off when configured', async () => {
      await tryServeInstantHlsPlaylist(httpReq(), res, { ...baseArgs(), config: { ytstream: { hlsMasterPlaylist: false } } });

      expect(buildHlsTopLevelPlaylistResponse.mock.calls[0][0].enabled).toBe(false);
    });

    it('tolerates a config with no ytstream section', async () => {
      await expect(tryServeInstantHlsPlaylist(httpReq(), res, { ...baseArgs(), config: {} })).resolves.toBe(true);
    });

    it('url-encodes the video id in the base url', async () => {
      await tryServeInstantHlsPlaylist(httpReq(), res, { ...baseArgs(), youtubeId: 'a b' });

      expect(getOrCreateSession.mock.calls[0][1].baseUrl).toContain('/api/ytstream/a%20b/hls/');
    });

    it.each([
      ['the session cannot be created', () => getOrCreateSession.mockRejectedValue(new Error('yt-dlp failed'))],
      ['the playlist cannot be read', () => getOrCreateSession.mockResolvedValue({ playlistPath: path.join(mockClipsDir, 'missing.m3u8'), baseUrl: 'x/' })],
      ['the top-level playlist cannot be built', () => buildHlsTopLevelPlaylistResponse.mockRejectedValue(new Error('boom'))],
    ])('falls back to normal handling when %s', async (_label, breakIt) => {
      breakIt();

      await expect(tryServeInstantHlsPlaylist(httpReq(), res, baseArgs())).resolves.toBe(false);

      expect(res.send).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
