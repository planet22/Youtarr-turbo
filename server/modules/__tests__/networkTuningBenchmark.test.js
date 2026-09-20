/* eslint-env jest */

jest.mock('../../logger');
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../configModule', () => ({ getConfig: jest.fn() }));
jest.mock('../download/ytdlpCommandBuilder', () => ({ buildCommonArgs: jest.fn() }));
jest.mock('../messageEmitter', () => ({ emitMessage: jest.fn() }));

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const configModule = require('../configModule');
const YtdlpCommandBuilder = require('../download/ytdlpCommandBuilder');
const messageEmitter = require('../messageEmitter');
const benchmark = require('../networkTuningBenchmark');

const VIDEO_ID = 'dQw4w9WgXcQ';
const MIB = 1024 * 1024;

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

describe('networkTuningBenchmark', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    configModule.getConfig.mockReturnValue({});
    YtdlpCommandBuilder.buildCommonArgs.mockReturnValue(['--common']);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('PRESETS', () => {
    it('starts with an unset baseline preset', () => {
      expect(benchmark.PRESETS[0]).toMatchObject({ id: 'off', httpChunkSizeMiB: 0, concurrentFragments: 0 });
    });

    it('has unique ids', () => {
      const ids = benchmark.PRESETS.map((p) => p.id);

      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('normalizeUrl', () => {
    it('turns a bare video id into a watch URL', () => {
      expect(benchmark.normalizeUrl(VIDEO_ID)).toBe(`https://youtube.com/watch?v=${VIDEO_ID}`);
    });

    it('trims whitespace around the input', () => {
      expect(benchmark.normalizeUrl(`  ${VIDEO_ID}\n`)).toBe(`https://youtube.com/watch?v=${VIDEO_ID}`);
    });

    it('passes a full URL through for yt-dlp to validate', () => {
      expect(benchmark.normalizeUrl('https://youtu.be/abc')).toBe('https://youtu.be/abc');
    });

    it.each([undefined, null, '', '   '])('rejects an empty input (%p)', (input) => {
      expect(() => benchmark.normalizeUrl(input)).toThrow('A YouTube URL or video ID is required');
    });
  });

  describe('runBenchmark', () => {
    // Every preset's yt-dlp "downloads" `mib` MiB over two seconds, then exits
    function respondWith({ mib = 2, code = 0, stderr = '' } = {}) {
      spawn.mockImplementation(() => {
        const proc = fakeProcess();
        setImmediate(() => {
          jest.advanceTimersByTime(2000);
          if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
          if (mib) proc.stdout.emit('data', Buffer.alloc(mib * MIB));
          proc.emit('close', code);
        });
        return proc;
      });
    }

    it('rejects without an id or URL', async () => {
      await expect(benchmark.runBenchmark('')).rejects.toThrow('A YouTube URL or video ID is required');
    });

    it('does not mark itself running when the input is invalid', async () => {
      await benchmark.runBenchmark('').catch(() => {});

      expect(benchmark.isBenchmarkRunning()).toBe(false);
    });

    it('measures every preset', async () => {
      respondWith();

      const { results, presets } = await benchmark.runBenchmark(VIDEO_ID);

      expect(Object.keys(results)).toEqual(benchmark.PRESETS.map((p) => p.id));
      expect(presets).toBe(benchmark.PRESETS);
    });

    it('reports bytes, elapsed time and throughput for a successful preset', async () => {
      respondWith({ mib: 4 });

      const { results } = await benchmark.runBenchmark(VIDEO_ID);

      expect(results.off).toMatchObject({ ok: true, bytes: 4 * MIB, elapsedSeconds: 2, throughputMBps: 2 });
    });

    it('keeps the stderr tail on a successful result', async () => {
      respondWith({ stderr: 'HTTP Error 429, retrying' });

      const { results } = await benchmark.runBenchmark(VIDEO_ID);

      expect(results.off.stderrTail).toBe('HTTP Error 429, retrying');
    });

    it('reports no stderr tail when yt-dlp was quiet', async () => {
      respondWith();

      const { results } = await benchmark.runBenchmark(VIDEO_ID);

      expect(results.off.stderrTail).toBeNull();
    });

    it('recommends the first preset when every measurement ties', async () => {
      respondWith();

      const { recommended } = await benchmark.runBenchmark(VIDEO_ID);

      expect(recommended).toBe('off');
    });

    it('recommends the fastest preset', async () => {
      let call = 0;
      spawn.mockImplementation(() => {
        const proc = fakeProcess();
        const mib = [1, 2, 8, 4][call++];
        setImmediate(() => {
          jest.advanceTimersByTime(1000);
          proc.stdout.emit('data', Buffer.alloc(mib * MIB));
          proc.emit('close', 0);
        });
        return proc;
      });

      const { recommended } = await benchmark.runBenchmark(VIDEO_ID);

      expect(recommended).toBe('aggressive');
    });

    it('recommends nothing when every preset fails', async () => {
      respondWith({ mib: 0, code: 1, stderr: 'ERROR: video unavailable' });

      const { recommended, results } = await benchmark.runBenchmark(VIDEO_ID);

      expect(recommended).toBeNull();
      expect(results.off).toEqual({ ok: false, error: 'ERROR: video unavailable' });
    });

    it('falls back to the exit code when a failing yt-dlp says nothing', async () => {
      respondWith({ mib: 0, code: 3 });

      const { results } = await benchmark.runBenchmark(VIDEO_ID);

      expect(results.off).toEqual({ ok: false, error: 'yt-dlp exited with code 3 before producing data' });
    });

    it('runs the presets one after another, never concurrently', async () => {
      let active = 0;
      let maxActive = 0;
      spawn.mockImplementation(() => {
        const proc = fakeProcess();
        active++;
        maxActive = Math.max(maxActive, active);
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.alloc(MIB));
          active--;
          proc.emit('close', 0);
        });
        return proc;
      });

      await benchmark.runBenchmark(VIDEO_ID);

      expect(maxActive).toBe(1);
    });

    it('is marked running during the run and cleared afterwards', async () => {
      let runningDuring = false;
      spawn.mockImplementation(() => {
        runningDuring = benchmark.isBenchmarkRunning();
        const proc = fakeProcess();
        setImmediate(() => { proc.stdout.emit('data', Buffer.alloc(MIB)); proc.emit('close', 0); });
        return proc;
      });

      await benchmark.runBenchmark(VIDEO_ID);

      expect(runningDuring).toBe(true);
      expect(benchmark.isBenchmarkRunning()).toBe(false);
    });

    it('refuses to start a second benchmark while one is running', async () => {
      respondWith();

      const first = benchmark.runBenchmark(VIDEO_ID);
      await expect(benchmark.runBenchmark(VIDEO_ID)).rejects.toThrow('A network tuning benchmark is already running');
      await first;
    });

    it('broadcasts progress before each preset and a final not-running message', async () => {
      respondWith();

      await benchmark.runBenchmark(VIDEO_ID);

      const payloads = messageEmitter.emitMessage.mock.calls.map((c) => c[4]);
      expect(payloads).toHaveLength(benchmark.PRESETS.length + 1);
      expect(payloads[0]).toEqual({ running: true, completed: 0, total: 4, current: { presetId: 'off' } });
      expect(payloads[payloads.length - 1]).toEqual({ running: false, completed: 4, total: 4 });
    });

    it('broadcasts on the networkTuningBenchmarkProgress channel to everyone', async () => {
      respondWith();

      await benchmark.runBenchmark(VIDEO_ID);

      expect(messageEmitter.emitMessage).toHaveBeenCalledWith('broadcast', null, 'server', 'networkTuningBenchmarkProgress', expect.any(Object));
    });

    it('clears the running flag and broadcasts completion even when a preset throws', async () => {
      spawn.mockImplementation(() => { throw new Error('spawn exploded'); });

      await expect(benchmark.runBenchmark(VIDEO_ID)).rejects.toThrow('spawn exploded');

      expect(benchmark.isBenchmarkRunning()).toBe(false);
      expect(messageEmitter.emitMessage.mock.calls.pop()[4]).toMatchObject({ running: false });
    });

    describe('yt-dlp arguments', () => {
      function firstRunArgs() {
        return spawn.mock.calls[0][1];
      }

      beforeEach(() => respondWith());

      it('spawns yt-dlp in a scratch working directory', async () => {
        await benchmark.runBenchmark(VIDEO_ID);

        expect(spawn.mock.calls[0][0]).toBe('yt-dlp');
        expect(spawn.mock.calls[0][2].cwd).toContain('ytstream-netbench-');
      });

      it('starts from the shared common args without sleep requests', async () => {
        await benchmark.runBenchmark(VIDEO_ID);

        expect(YtdlpCommandBuilder.buildCommonArgs).toHaveBeenCalledWith({}, { skipSleepRequests: true });
        expect(firstRunArgs()[0]).toBe('--common');
      });

      it('pipes a video-only stream to stdout for a single video', async () => {
        await benchmark.runBenchmark(VIDEO_ID);

        const args = firstRunArgs();
        expect(args).toEqual(expect.arrayContaining(['-f', 'bestvideo[height<=1080]', '-o', '-', '--no-playlist', '--no-warnings']));
        expect(args[args.length - 1]).toBe(`https://youtube.com/watch?v=${VIDEO_ID}`);
      });

      it('uses the default player client when none is configured', async () => {
        await benchmark.runBenchmark(VIDEO_ID);

        expect(firstRunArgs()).toEqual(expect.arrayContaining(['--extractor-args', 'youtube:player_client=default,-tv']));
      });

      it('uses the configured player client', async () => {
        configModule.getConfig.mockReturnValue({ ytstream: { playerClient: 'android' } });

        await benchmark.runBenchmark(VIDEO_ID);

        expect(firstRunArgs()).toEqual(expect.arrayContaining(['--extractor-args', 'youtube:player_client=android']));
      });

      it('caps the height at the configured stream quality', async () => {
        configModule.getConfig.mockReturnValue({ ytstream: { quality: '720' } });

        await benchmark.runBenchmark(VIDEO_ID);

        expect(firstRunArgs()).toContain('bestvideo[height<=720]');
      });

      it('treats a "best" quality as the 1080 default', async () => {
        configModule.getConfig.mockReturnValue({ ytstream: { quality: 'best' } });

        await benchmark.runBenchmark(VIDEO_ID);

        expect(firstRunArgs()).toContain('bestvideo[height<=1080]');
      });

      it('passes no tuning flags for the off preset', async () => {
        await benchmark.runBenchmark(VIDEO_ID);

        expect(firstRunArgs()).not.toContain('--http-chunk-size');
        expect(firstRunArgs()).not.toContain('--concurrent-fragments');
      });

      it('passes chunk size and fragment concurrency for a tuned preset', async () => {
        await benchmark.runBenchmark(VIDEO_ID);

        const conservative = spawn.mock.calls[1][1];
        expect(conservative).toEqual(expect.arrayContaining(['--http-chunk-size', '5M', '--concurrent-fragments', '2']));
      });

      it('scales the flags up for the max preset', async () => {
        await benchmark.runBenchmark(VIDEO_ID);

        const max = spawn.mock.calls[3][1];
        expect(max).toEqual(expect.arrayContaining(['--http-chunk-size', '20M', '--concurrent-fragments', '8']));
      });
    });

    describe('timeouts and process events', () => {
      it('ends a preset at the sample window with the bytes counted so far', async () => {
        let index = 0;
        spawn.mockImplementation(() => {
          const proc = fakeProcess();
          if (index++ === 0) {
            setImmediate(() => {
              proc.stdout.emit('data', Buffer.alloc(MIB));
              jest.advanceTimersByTime(benchmark.SAMPLE_WINDOW_MS);
            });
          } else {
            setImmediate(() => proc.emit('close', 0));
          }
          return proc;
        });

        const { results } = await benchmark.runBenchmark(VIDEO_ID);

        expect(results.off).toMatchObject({ ok: true, bytes: MIB });
        expect(results.off.elapsedSeconds).toBe(15);
      });

      it('kills yt-dlp once the window closes', async () => {
        const procs = [];
        spawn.mockImplementation(() => {
          const proc = fakeProcess();
          procs.push(proc);
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.alloc(MIB));
            jest.advanceTimersByTime(benchmark.SAMPLE_WINDOW_MS);
          });
          return proc;
        });

        await benchmark.runBenchmark(VIDEO_ID);

        expect(procs[0].kill).toHaveBeenCalledWith('SIGKILL');
      });

      it('fails a preset that produced no data by the end of the window', async () => {
        spawn.mockImplementation(() => {
          const proc = fakeProcess();
          setImmediate(() => jest.advanceTimersByTime(benchmark.SAMPLE_WINDOW_MS));
          return proc;
        });

        const { results } = await benchmark.runBenchmark(VIDEO_ID);

        expect(results.off).toEqual({ ok: false, error: 'No data received before the sample window closed' });
      });

      it('stops a preset early once the byte cap is reached', async () => {
        spawn.mockImplementation(() => {
          const proc = fakeProcess();
          setImmediate(() => {
            jest.advanceTimersByTime(1000);
            proc.stdout.emit('data', Buffer.alloc(150 * MIB));
          });
          return proc;
        });

        const { results } = await benchmark.runBenchmark(VIDEO_ID);

        expect(results.off).toMatchObject({ ok: true, bytes: 150 * MIB, elapsedSeconds: 1 });
      });

      it('fails a preset when yt-dlp cannot be started', async () => {
        spawn.mockImplementation(() => {
          const proc = fakeProcess();
          setImmediate(() => proc.emit('error', new Error('spawn yt-dlp ENOENT')));
          return proc;
        });

        const { results } = await benchmark.runBenchmark(VIDEO_ID);

        expect(results.off).toEqual({ ok: false, error: 'spawn yt-dlp ENOENT' });
      });

      it('uses a generic message for a start error with no text', async () => {
        spawn.mockImplementation(() => {
          const proc = fakeProcess();
          setImmediate(() => proc.emit('error', new Error('')));
          return proc;
        });

        const { results } = await benchmark.runBenchmark(VIDEO_ID);

        expect(results.off.error).toBe('Failed to start yt-dlp');
      });

      it('ignores an exit that arrives after the preset already finished', async () => {
        spawn.mockImplementation(() => {
          const proc = fakeProcess();
          setImmediate(() => {
            proc.stdout.emit('data', Buffer.alloc(150 * MIB));
            proc.emit('close', 1);
          });
          return proc;
        });

        const { results } = await benchmark.runBenchmark(VIDEO_ID);

        expect(results.off.ok).toBe(true);
      });
    });
  });
});
