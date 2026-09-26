/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const mockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-remux-cache-'));

jest.mock('../../logger');
jest.mock('../configModule', () => ({ directoryPath: mockRoot }));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { spawn } = require('child_process');
const jobEventLog = require('../jobEventLog');
const { ensureSeekableMp4, findExistingSeekableMp4 } = require('../tsRemuxCache');

const CACHE_DIR = path.join(mockRoot, '.youtarr_ytstream_cache', 'ts-remux');

function fakeFfmpeg() {
  const ff = new EventEmitter();
  ff.stderr = new EventEmitter();
  ff.kill = jest.fn();
  return ff;
}

describe('tsRemuxCache', () => {
  let sourceDir;
  let sourcePath;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    sourceDir = fs.mkdtempSync(path.join(mockRoot, 'src-'));
    sourcePath = path.join(sourceDir, 'video.ts');
    fs.writeFileSync(sourcePath, 'mpegts-bytes');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    fs.rmSync(mockRoot, { recursive: true, force: true });
  });

  // ffmpeg "remuxes" by writing its output file (the last arg) and exiting 0
  function succeedWith(contents = 'mp4-bytes') {
    spawn.mockImplementation((_cmd, args) => {
      const ff = fakeFfmpeg();
      setImmediate(() => {
        fs.writeFileSync(args[args.length - 1], contents);
        ff.emit('close', 0);
      });
      return ff;
    });
  }

  describe('findExistingSeekableMp4', () => {
    it('returns null when no remux exists yet', () => {
      expect(findExistingSeekableMp4(sourcePath)).toBeNull();
    });

    it('returns null when the source file does not exist', () => {
      expect(findExistingSeekableMp4(path.join(sourceDir, 'missing.ts'))).toBeNull();
    });

    it('returns the remux once ensureSeekableMp4 has produced it', async () => {
      succeedWith();
      const produced = await ensureSeekableMp4(sourcePath);

      expect(findExistingSeekableMp4(sourcePath)).toBe(produced);
    });

    it('never spawns ffmpeg', () => {
      findExistingSeekableMp4(sourcePath);

      expect(spawn).not.toHaveBeenCalled();
    });

    it('stops matching once the source file changes', async () => {
      succeedWith();
      await ensureSeekableMp4(sourcePath);

      fs.writeFileSync(sourcePath, 'a different and longer set of bytes');

      expect(findExistingSeekableMp4(sourcePath)).toBeNull();
    });
  });

  describe('ensureSeekableMp4 events', () => {
    it('records the remux against the video named in the file name', async () => {
      const namedPath = path.join(sourceDir, 'Channel - Title  [abcDEF12345].ts');
      fs.writeFileSync(namedPath, 'mpegts-bytes');
      succeedWith('remuxed');

      const cachePath = await ensureSeekableMp4(namedPath);

      expect(jobEventLog.record).toHaveBeenCalledWith('cache.remuxed_for_playback', {
        youtubeId: 'abcDEF12345',
        detail: { filePath: namedPath, cachePath, size: 'remuxed'.length },
      });
    });

    it('still records the remux, without a video, when the file name has no video id', async () => {
      succeedWith();

      await ensureSeekableMp4(sourcePath);

      expect(jobEventLog.record).toHaveBeenCalledWith('cache.remuxed_for_playback', expect.objectContaining({ youtubeId: undefined }));
    });

    it('does not record again when the remux was already cached', async () => {
      succeedWith();
      await ensureSeekableMp4(sourcePath);
      jobEventLog.record.mockClear();

      await ensureSeekableMp4(sourcePath);

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records nothing when ffmpeg fails', async () => {
      spawn.mockImplementation(() => {
        const ff = fakeFfmpeg();
        setImmediate(() => ff.emit('close', 1));
        return ff;
      });

      await ensureSeekableMp4(sourcePath);

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });

  describe('ensureSeekableMp4', () => {
    it('remuxes into the cache directory as an mp4', async () => {
      succeedWith('remuxed');

      const result = await ensureSeekableMp4(sourcePath);

      expect(path.dirname(result)).toBe(CACHE_DIR);
      expect(result.endsWith('.mp4')).toBe(true);
      expect(fs.readFileSync(result, 'utf8')).toBe('remuxed');
    });

    it('copies streams without re-encoding, keeping the first video and optional audio', async () => {
      succeedWith();

      await ensureSeekableMp4(sourcePath);

      const args = spawn.mock.calls[0][1];
      expect(spawn.mock.calls[0][0]).toBe('ffmpeg');
      expect(args).toEqual(expect.arrayContaining(['-i', sourcePath, '-map', '0:v:0', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4']));
    });

    it('returns a cached remux without running ffmpeg again', async () => {
      succeedWith();
      const first = await ensureSeekableMp4(sourcePath);

      const second = await ensureSeekableMp4(sourcePath);

      expect(second).toBe(first);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('re-remuxes after the source file changes', async () => {
      succeedWith();
      const first = await ensureSeekableMp4(sourcePath);
      fs.writeFileSync(sourcePath, 'replacement content that is longer');

      const second = await ensureSeekableMp4(sourcePath);

      expect(second).not.toBe(first);
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('shares one ffmpeg run between concurrent requests for the same file', async () => {
      succeedWith();

      const [a, b] = await Promise.all([ensureSeekableMp4(sourcePath), ensureSeekableMp4(sourcePath)]);

      expect(a).toBe(b);
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('leaves no temporary file behind after success', async () => {
      succeedWith();

      await ensureSeekableMp4(sourcePath);

      expect(fs.readdirSync(CACHE_DIR).filter((f) => f.includes('.tmp-'))).toEqual([]);
    });

    it('rejects when the source file does not exist', async () => {
      await expect(ensureSeekableMp4(path.join(sourceDir, 'missing.ts'))).rejects.toThrow();
    });

    describe('failures', () => {
      it('returns null when ffmpeg exits non-zero', async () => {
        spawn.mockImplementation(() => {
          const ff = fakeFfmpeg();
          setImmediate(() => {
            ff.stderr.emit('data', 'Invalid data found');
            ff.emit('close', 1);
          });
          return ff;
        });

        await expect(ensureSeekableMp4(sourcePath)).resolves.toBeNull();
      });

      it('returns null when ffmpeg cannot be spawned', async () => {
        spawn.mockImplementation(() => {
          const ff = fakeFfmpeg();
          setImmediate(() => ff.emit('error', new Error('spawn ffmpeg ENOENT')));
          return ff;
        });

        await expect(ensureSeekableMp4(sourcePath)).resolves.toBeNull();
      });

      it('removes a partial temporary file after a failure', async () => {
        spawn.mockImplementation((_cmd, args) => {
          const ff = fakeFfmpeg();
          setImmediate(() => {
            fs.writeFileSync(args[args.length - 1], 'partial');
            ff.emit('close', 1);
          });
          return ff;
        });

        await ensureSeekableMp4(sourcePath);

        expect(fs.readdirSync(CACHE_DIR)).toEqual([]);
      });

      it('does not cache a failure, so the next request tries again', async () => {
        spawn.mockImplementationOnce(() => {
          const ff = fakeFfmpeg();
          setImmediate(() => ff.emit('close', 1));
          return ff;
        });
        await ensureSeekableMp4(sourcePath);
        succeedWith();

        await expect(ensureSeekableMp4(sourcePath)).resolves.toEqual(expect.stringContaining('.mp4'));
      });

      it('kills ffmpeg and returns null when the remux times out', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
        const ff = fakeFfmpeg();
        spawn.mockReturnValue(ff);

        const pending = ensureSeekableMp4(sourcePath);
        // let the async mkdir finish and ffmpeg get spawned before the clock moves
        while (!spawn.mock.calls.length) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

        await expect(pending).resolves.toBeNull();
        expect(ff.kill).toHaveBeenCalledWith('SIGKILL');
      });
    });
  });
});
