/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const baseParams = {
  youtubeId: 'dQw4w9WgXcQ',
  quality: '1080',
  qualityStrictness: 'fallback',
  transcode: 'copy',
  hardwareMode: 'none',
  tuning: 'balanced',
  config: {},
  playerClient: undefined,
  clientIp: '10.0.0.5',
  userAgent: 'TestAgent/1.0',
};

describe('downloadCacheMode request flow', () => {
  let cacheRoot;
  let cacheDir;
  let mod;
  let mocks;

  function fakeFfmpegProcess() {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.pid = 4242;
    proc.kill = jest.fn();
    return proc;
  }

  function loadModule() {
    jest.resetModules();
    mocks = {
      spawn: jest.fn(),
      run: jest.fn(),
      isFfmpegAvailable: jest.fn().mockReturnValue(true),
      registerChildProcess: jest.fn(),
      serveFileWithRangeSupport: jest.fn(),
      trackStream: jest.fn(),
      untrackStream: jest.fn(),
      failStreamThenUntrack: jest.fn(),
      getStream: jest.fn().mockReturnValue(undefined),
      createBytesCounter: jest.fn().mockReturnValue(jest.fn()),
      buildVideoEncoderArgs: jest.fn().mockReturnValue({
        preInputArgs: ['-hwaccel', 'x'],
        videoFilters: ['scale=1', 'format=yuv420p'],
        pixFmt: 'yuv420p',
        encoderArgs: ['-c:v', 'libx264'],
      }),
    };

    jest.doMock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('child_process', () => ({ spawn: mocks.spawn }));
    jest.doMock('../../ytDlpRunner', () => ({ run: mocks.run }));
    jest.doMock('../../streamEncoderTuning', () => ({
      normalizeHardwareMode: (v) => v || 'none',
      normalizeTuning: (v) => v || 'balanced',
      buildVideoEncoderArgs: mocks.buildVideoEncoderArgs,
    }));
    jest.doMock('../formatSelection', () => ({
      getDashFormatSelectors: jest.fn().mockReturnValue({ videoFormat: 'bv*', audioFormat: 'ba' }),
      resolveQualityHeight: jest.fn().mockReturnValue(1080),
    }));
    jest.doMock('../ytdlpArgs', () => ({ buildBaseArgs: jest.fn().mockReturnValue(['--base']) }));
    jest.doMock('../processRegistry', () => ({
      isFfmpegAvailable: mocks.isFfmpegAvailable,
      registerChildProcess: mocks.registerChildProcess,
    }));
    jest.doMock('../rangeFileServe', () => ({ serveFileWithRangeSupport: mocks.serveFileWithRangeSupport }));
    jest.doMock('../streamDebug', () => ({ streamDebug: jest.fn() }));
    jest.doMock('../activeStreams', () => ({
      trackStream: mocks.trackStream,
      untrackStream: mocks.untrackStream,
      failStreamThenUntrack: mocks.failStreamThenUntrack,
      getStream: mocks.getStream,
      createBytesCounter: mocks.createBytesCounter,
    }));
    jest.doMock('../paths', () => ({ YTSTREAM_CACHE_DIR: cacheRoot }));

    mod = require('../downloadCacheMode');
  }

  // yt-dlp "downloads" by writing a file to whatever -o points at
  function yieldDownloadedFile(contents = 'merged-video-bytes') {
    mocks.run.mockImplementation(async (args) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], contents);
    });
  }

  function makeResponse() {
    return { status: jest.fn().mockReturnThis(), send: jest.fn() };
  }

  beforeEach(() => {
    cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-cache-mode-'));
    cacheDir = path.join(cacheRoot, '.download-cache');
    loadModule();
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  describe('ensureCachedFile', () => {
    it('returns an existing cached file without downloading', async () => {
      const key = mod.buildCacheKey(baseParams);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, `${key}.mp4`), 'cached');

      const result = await mod.ensureCachedFile(baseParams);

      expect(result).toBe(path.join(cacheDir, `${key}.mp4`));
      expect(mocks.run).not.toHaveBeenCalled();
    });

    it('downloads and stores a copy-mode file under the cache key', async () => {
      yieldDownloadedFile();

      const result = await mod.ensureCachedFile(baseParams);

      expect(result).toBe(path.join(cacheDir, `${mod.buildCacheKey(baseParams)}.mp4`));
      expect(fs.readFileSync(result, 'utf8')).toBe('merged-video-bytes');
    });

    it('asks yt-dlp to merge video and audio into mp4 for a single video', async () => {
      yieldDownloadedFile();

      await mod.ensureCachedFile(baseParams);

      const args = mocks.run.mock.calls[0][0];
      expect(args).toEqual(expect.arrayContaining(['--base', '-f', 'bv*+ba', '--merge-output-format', 'mp4', '--no-playlist']));
      expect(args[args.length - 1]).toBe('https://youtube.com/watch?v=dQw4w9WgXcQ');
    });

    it('gives yt-dlp a 30 minute timeout', async () => {
      yieldDownloadedFile();

      await mod.ensureCachedFile(baseParams);

      expect(mocks.run.mock.calls[0][1]).toEqual({ timeoutMs: 30 * 60 * 1000 });
    });

    it('does not leave the temporary download behind in copy mode', async () => {
      yieldDownloadedFile();

      await mod.ensureCachedFile(baseParams);

      expect(fs.readdirSync(cacheDir).filter((f) => f.startsWith('tmp-'))).toEqual([]);
    });

    it('does not run ffmpeg in copy mode', async () => {
      yieldDownloadedFile();

      await mod.ensureCachedFile(baseParams);

      expect(mocks.spawn).not.toHaveBeenCalled();
    });

    it('tracks the download then untracks it as completed', async () => {
      yieldDownloadedFile();

      await mod.ensureCachedFile(baseParams);

      expect(mocks.trackStream).toHaveBeenCalledWith(expect.objectContaining({ mode: 'download-cache', state: 'downloading', youtubeId: 'dQw4w9WgXcQ' }));
      expect(mocks.untrackStream).toHaveBeenCalledWith(mod.buildCacheKey(baseParams), 'completed', null);
    });

    it('shares one download between concurrent requests for the same video', async () => {
      let release;
      mocks.run.mockImplementation((args) => new Promise((resolve) => {
        release = () => { fs.writeFileSync(args[args.indexOf('-o') + 1], 'x'); resolve(); };
      }));

      const first = mod.ensureCachedFile(baseParams);
      const second = mod.ensureCachedFile(baseParams);
      await new Promise((resolve) => setImmediate(resolve));
      release();
      const [pathA, pathB] = await Promise.all([first, second]);

      expect(pathA).toBe(pathB);
      expect(mocks.run).toHaveBeenCalledTimes(1);
    });

    it('starts a fresh download after an in-flight one has failed', async () => {
      mocks.run.mockRejectedValueOnce(new Error('network'));
      await mod.ensureCachedFile(baseParams).catch(() => {});
      yieldDownloadedFile();

      await expect(mod.ensureCachedFile(baseParams)).resolves.toEqual(expect.stringContaining('.mp4'));
    });

    it('rejects when yt-dlp succeeds but the merged file is missing', async () => {
      mocks.run.mockResolvedValue(undefined);

      await expect(mod.ensureCachedFile(baseParams)).rejects.toThrow('yt-dlp reported success but the merged file is missing');
    });

    it('marks the stream failed when the download fails', async () => {
      mocks.run.mockRejectedValue(new Error('403 forbidden'));

      await mod.ensureCachedFile(baseParams).catch(() => {});

      expect(mocks.failStreamThenUntrack).toHaveBeenCalledWith(mod.buildCacheKey(baseParams), 'failed', '403 forbidden');
    });

    it('propagates the download error', async () => {
      mocks.run.mockRejectedValue(new Error('403 forbidden'));

      await expect(mod.ensureCachedFile(baseParams)).rejects.toThrow('403 forbidden');
    });

    describe('with h264 transcode', () => {
      const h264Params = { ...baseParams, transcode: 'h264' };
      let ffmpeg;

      beforeEach(() => {
        yieldDownloadedFile();
        ffmpeg = fakeFfmpegProcess();
        mocks.spawn.mockImplementation((cmd, args) => {
          // ffmpeg "encodes" by writing the output file (the last arg), then exits
          setImmediate(() => {
            fs.writeFileSync(args[args.length - 1], 'reencoded');
            ffmpeg.emit('close', 0, null);
          });
          return ffmpeg;
        });
      });

      it('re-encodes the merged download into the cache file', async () => {
        const result = await mod.ensureCachedFile(h264Params);

        expect(fs.readFileSync(result, 'utf8')).toBe('reencoded');
      });

      it('removes the temporary merged download after encoding', async () => {
        await mod.ensureCachedFile(h264Params);
        // the source is removed with a fire-and-forget async unlink
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(fs.readdirSync(cacheDir).filter((f) => f.startsWith('tmp-'))).toEqual([]);
      });

      it('builds ffmpeg args from the encoder settings and faststart mp4 output', async () => {
        const result = await mod.ensureCachedFile(h264Params);

        const args = mocks.spawn.mock.calls[0][1];
        expect(args).toEqual(expect.arrayContaining([
          '-y', '-hwaccel', 'x', '-vf', 'scale=1,format=yuv420p', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
          '-c:a', 'aac', '-movflags', '+faststart',
        ]));
        expect(args[args.length - 1]).toBe(result);
      });

      it('maps only the first video and (optional) audio stream and drops subtitles/data', async () => {
        await mod.ensureCachedFile(h264Params);

        expect(mocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-map', '0:v:0', '0:a:0?', '-sn', '-dn']));
      });

      it('omits the video filter and pixel format when the encoder does not need them', async () => {
        mocks.buildVideoEncoderArgs.mockReturnValue({ preInputArgs: [], videoFilters: [], pixFmt: null, encoderArgs: ['-c:v', 'libx264'] });

        await mod.ensureCachedFile(h264Params);

        const args = mocks.spawn.mock.calls[0][1];
        expect(args).not.toContain('-vf');
        expect(args).not.toContain('-pix_fmt');
      });

      it('registers the ffmpeg child process', async () => {
        await mod.ensureCachedFile(h264Params);

        expect(mocks.registerChildProcess).toHaveBeenCalledWith(ffmpeg);
      });

      it('rejects with the ffmpeg stderr when ffmpeg exits non-zero', async () => {
        mocks.spawn.mockImplementation(() => {
          setImmediate(() => {
            ffmpeg.stderr.emit('data', Buffer.from('Unknown encoder libx264'));
            ffmpeg.emit('close', 1, null);
          });
          return ffmpeg;
        });

        await expect(mod.ensureCachedFile(h264Params)).rejects.toThrow('ffmpeg exited with code 1: Unknown encoder libx264');
      });

      it('rejects when ffmpeg cannot be spawned', async () => {
        mocks.spawn.mockImplementation(() => {
          setImmediate(() => ffmpeg.emit('error', new Error('spawn ENOENT')));
          return ffmpeg;
        });

        await expect(mod.ensureCachedFile(h264Params)).rejects.toThrow('spawn ENOENT');
      });

      it('marks the stream failed when ffmpeg fails', async () => {
        mocks.spawn.mockImplementation(() => {
          setImmediate(() => ffmpeg.emit('close', 1, null));
          return ffmpeg;
        });

        await mod.ensureCachedFile(h264Params).catch(() => {});

        expect(mocks.failStreamThenUntrack).toHaveBeenCalledWith(mod.buildCacheKey(h264Params), 'failed', expect.stringContaining('ffmpeg exited'));
      });

      it('kills ffmpeg and rejects when the encode times out', async () => {
        jest.useFakeTimers();
        mocks.spawn.mockImplementation(() => ffmpeg);

        const promise = mod.ensureCachedFile(h264Params);
        const assertion = expect(promise).rejects.toThrow('ffmpeg encode timed out');
        await jest.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
        await assertion;

        expect(ffmpeg.kill).toHaveBeenCalledWith('SIGKILL');
      });
    });
  });

  describe('handleDownloadCacheRequest', () => {
    const req = { headers: {} };

    it('responds 502 when ffmpeg is unavailable', async () => {
      mocks.isFfmpegAvailable.mockReturnValue(false);
      const res = makeResponse();

      await mod.handleDownloadCacheRequest(req, res, baseParams);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('requires ffmpeg'));
    });

    it('does not download anything when ffmpeg is unavailable', async () => {
      mocks.isFfmpegAvailable.mockReturnValue(false);

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);

      expect(mocks.run).not.toHaveBeenCalled();
    });

    it('responds 502 when the download fails', async () => {
      mocks.run.mockRejectedValue(new Error('boom'));
      const res = makeResponse();

      await mod.handleDownloadCacheRequest(req, res, baseParams);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('failed to download/encode'));
    });

    it('does not serve a file when the download fails', async () => {
      mocks.run.mockRejectedValue(new Error('boom'));

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);

      expect(mocks.serveFileWithRangeSupport).not.toHaveBeenCalled();
    });

    it('serves the freshly downloaded file as video/mp4', async () => {
      yieldDownloadedFile();
      const res = makeResponse();

      await mod.handleDownloadCacheRequest(req, res, baseParams);

      const [filePath, passedReq, passedRes, contentType] = mocks.serveFileWithRangeSupport.mock.calls[0];
      expect([filePath, passedReq, passedRes, contentType]).toEqual([
        path.join(cacheDir, `${mod.buildCacheKey(baseParams)}.mp4`), req, res, 'video/mp4',
      ]);
    });

    it('serves an already-cached file without downloading', async () => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, `${mod.buildCacheKey(baseParams)}.mp4`), 'cached');

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);

      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.serveFileWithRangeSupport).toHaveBeenCalledTimes(1);
    });

    it('starts a serving row for the cached video', async () => {
      yieldDownloadedFile();

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);

      expect(mocks.trackStream).toHaveBeenCalledWith(expect.objectContaining({ state: 'serving', streamId: mod.buildCacheKey(baseParams) }));
    });

    it('shares one serving row across repeat requests for the same video', async () => {
      yieldDownloadedFile();

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);
      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);

      const servingRows = mocks.trackStream.mock.calls.filter(([entry]) => entry.state === 'serving');
      expect(servingRows).toHaveLength(1);
    });

    it('refreshes the stream entry activity when the file is served', async () => {
      yieldDownloadedFile();
      const entry = { lastActivityAt: 0, state: 'downloading' };
      mocks.getStream.mockReturnValue(entry);

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);
      const onServe = mocks.serveFileWithRangeSupport.mock.calls[0][4];
      onServe();

      expect(entry.state).toBe('serving');
      expect(entry.lastActivityAt).toBeGreaterThan(0);
    });

    it('counts served bytes against the stream entry', async () => {
      yieldDownloadedFile();
      const entry = {};
      mocks.getStream.mockReturnValue(entry);

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);

      expect(mocks.createBytesCounter).toHaveBeenCalledWith(entry);
    });

    it('untracks an idle serving row after the idle timeout', async () => {
      jest.useFakeTimers();
      yieldDownloadedFile();

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);
      mocks.untrackStream.mockClear();
      await jest.advanceTimersByTimeAsync(3 * 60 * 1000);

      expect(mocks.untrackStream).toHaveBeenCalledWith(mod.buildCacheKey(baseParams), 'completed', null);
    });

    it('keeps a serving row that was accessed recently', async () => {
      jest.useFakeTimers();
      yieldDownloadedFile();

      await mod.handleDownloadCacheRequest(req, makeResponse(), baseParams);
      mocks.untrackStream.mockClear();
      await jest.advanceTimersByTimeAsync(60 * 1000);

      expect(mocks.untrackStream).not.toHaveBeenCalled();
    });
  });
});
