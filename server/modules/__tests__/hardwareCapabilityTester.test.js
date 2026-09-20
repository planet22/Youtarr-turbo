/* eslint-env jest */

jest.mock('../../logger');
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../configModule', () => ({ ffmpegPath: '/usr/bin/ffmpeg' }));

const { EventEmitter } = require('events');
const fs = require('fs');
const { spawn } = require('child_process');
const hardwareEncoderModule = require('../hardwareEncoderModule');
const hardwareDecodeModule = require('../hardwareDecodeModule');
const tester = require('../hardwareCapabilityTester');

function fakeFfmpeg() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

// Have the next ffmpeg run exit with `code` (optionally after printing stderr)
function exitWith(code, { stderr = '', signal = null } = {}) {
  spawn.mockImplementationOnce(() => {
    const proc = fakeFfmpeg();
    setImmediate(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('close', code, signal);
    });
    return proc;
  });
}

describe('hardwareCapabilityTester', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('summarizeStderr', () => {
    const SVT = 'Svt[warn]: Failed to set thread priority';

    it('returns ordinary stderr unchanged', () => {
      expect(tester.summarizeStderr('Unknown encoder')).toBe('Unknown encoder');
    });

    it('trims surrounding whitespace', () => {
      expect(tester.summarizeStderr('  boom \n')).toBe('boom');
    });

    it('drops the benign SVT thread priority warning and says so', () => {
      expect(tester.summarizeStderr(`${SVT}\nreal error`)).toBe('real error (suppressed 1 benign "Svt[warn]: Failed to set thread priority" line)');
    });

    it('pluralises the suppressed count', () => {
      expect(tester.summarizeStderr(`${SVT}\n${SVT}\n${SVT}`)).toBe('(suppressed 3 benign "Svt[warn]: Failed to set thread priority" lines)');
    });

    it('keeps the real error visible when warnings would otherwise fill the buffer', () => {
      const spam = Array(500).fill(SVT).join('\n');

      expect(tester.summarizeStderr(`${spam}\nOut of memory`)).toContain('Out of memory');
    });

    it('keeps only the last maxLength characters', () => {
      expect(tester.summarizeStderr('a'.repeat(1000), 10)).toBe('a'.repeat(10));
    });

    it('returns an empty string for empty stderr', () => {
      expect(tester.summarizeStderr('')).toBe('');
    });
  });

  describe('describeExitSignal', () => {
    it('is empty without a signal', () => {
      expect(tester.describeExitSignal(null)).toBe('');
    });

    it('names the signal', () => {
      expect(tester.describeExitSignal('SIGTERM')).toBe('Process was killed by signal SIGTERM. ');
    });

    it('flags SIGKILL as a likely out-of-memory kill', () => {
      expect(tester.describeExitSignal('SIGKILL')).toContain('likely killed by the OOM killer');
    });
  });

  describe('testEncoderCombo', () => {
    it('reports success when ffmpeg exits 0', async () => {
      exitWith(0);

      await expect(tester.testEncoderCombo('none', 'h264')).resolves.toEqual({ ok: true });
    });

    it('runs the configured ffmpeg without a shell', async () => {
      exitWith(0);

      await tester.testEncoderCombo('none', 'h264');

      expect(spawn).toHaveBeenCalledWith('/usr/bin/ffmpeg', expect.any(Array), { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    });

    it('encodes a one second synthetic test source to a null sink', async () => {
      exitWith(0);

      await tester.testEncoderCombo('none', 'h264');

      const args = spawn.mock.calls[0][1];
      expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=5', '-an', '-f', 'null', '-']));
    });

    it('uses the encoder for the requested backend and codec', async () => {
      exitWith(0);

      await tester.testEncoderCombo('nvenc', 'hevc');

      expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-c:v', 'hevc_nvenc']));
    });

    it('places device setup args before the input', async () => {
      exitWith(0);

      await tester.testEncoderCombo('vaapi', 'h264');

      const args = spawn.mock.calls[0][1];
      expect(args.indexOf('-vaapi_device')).toBeLessThan(args.indexOf('-i'));
    });

    it('applies the encoder video filter and pixel format', async () => {
      exitWith(0);

      await tester.testEncoderCombo('nvenc', 'h264');

      expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-vf', 'format=yuv420p', '-pix_fmt', 'yuv420p']));
    });

    it('reports the ffmpeg error output on failure', async () => {
      exitWith(1, { stderr: 'Cannot load libcuda.so.1' });

      await expect(tester.testEncoderCombo('nvenc', 'h264')).resolves.toEqual({ ok: false, error: 'Cannot load libcuda.so.1' });
    });

    it('falls back to the exit status when ffmpeg printed nothing', async () => {
      exitWith(2);

      await expect(tester.testEncoderCombo('none', 'h264')).resolves.toEqual({ ok: false, error: 'ffmpeg exited with status 2' });
    });

    it('explains a signal kill', async () => {
      exitWith(null, { signal: 'SIGKILL', stderr: 'Svt[info]: starting' });

      const result = await tester.testEncoderCombo('none', 'av1');

      expect(result.error).toContain('Process was killed by signal SIGKILL');
      expect(result.error).toContain('Svt[info]: starting');
    });

    it('reports a spawn error', async () => {
      spawn.mockImplementationOnce(() => {
        const proc = fakeFfmpeg();
        setImmediate(() => proc.emit('error', new Error('spawn ffmpeg ENOENT')));
        return proc;
      });

      await expect(tester.testEncoderCombo('none', 'h264')).resolves.toEqual({ ok: false, error: 'spawn ffmpeg ENOENT' });
    });

    it('uses a generic message for a spawn error with no text', async () => {
      spawn.mockImplementationOnce(() => {
        const proc = fakeFfmpeg();
        setImmediate(() => proc.emit('error', new Error('')));
        return proc;
      });

      await expect(tester.testEncoderCombo('none', 'h264')).resolves.toEqual({ ok: false, error: 'Failed to start ffmpeg' });
    });

    it('kills a hung ffmpeg and reports a timeout', async () => {
      jest.useFakeTimers();
      const proc = fakeFfmpeg();
      spawn.mockReturnValueOnce(proc);

      const pending = tester.testEncoderCombo('none', 'h264');
      await jest.advanceTimersByTimeAsync(8000);

      await expect(pending).resolves.toEqual({ ok: false, error: 'Timed out after 8s (likely hung)' });
      expect(proc.kill).toHaveBeenCalled();
    });

    it('still reports the timeout when killing the process throws', async () => {
      jest.useFakeTimers();
      const proc = fakeFfmpeg();
      proc.kill.mockImplementation(() => { throw new Error('ESRCH'); });
      spawn.mockReturnValueOnce(proc);

      const pending = tester.testEncoderCombo('none', 'h264');
      await jest.advanceTimersByTimeAsync(8000);

      await expect(pending).resolves.toMatchObject({ ok: false });
    });

    it('ignores an exit that arrives after the timeout already resolved', async () => {
      jest.useFakeTimers();
      const proc = fakeFfmpeg();
      spawn.mockReturnValueOnce(proc);

      const pending = tester.testEncoderCombo('none', 'h264');
      await jest.advanceTimersByTimeAsync(8000);
      proc.emit('close', 0, null);

      await expect(pending).resolves.toMatchObject({ ok: false });
    });
  });

  describe('testDecoderCombo', () => {
    it('decodes the sample into a null sink', async () => {
      exitWith(0);

      await tester.testDecoderCombo('none', 'h264', '/tmp/sample.mp4');

      expect(spawn.mock.calls[0][1]).toEqual(['-y', '-loglevel', 'error', '-i', '/tmp/sample.mp4', '-f', 'null', '-']);
    });

    it('places the hardware decode args before the input', async () => {
      exitWith(0);

      await tester.testDecoderCombo('vaapi', 'h264', '/tmp/sample.mp4');

      const args = spawn.mock.calls[0][1];
      expect(args.slice(args.indexOf('-hwaccel'), args.indexOf('-i'))).toEqual(['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128']);
    });

    it('reports success', async () => {
      exitWith(0);

      await expect(tester.testDecoderCombo('qsv', 'vp9', '/tmp/s.webm')).resolves.toEqual({ ok: true });
    });

    it('reports the decode failure', async () => {
      exitWith(1, { stderr: 'No device available for decoder' });

      await expect(tester.testDecoderCombo('qsv', 'vp9', '/tmp/s.webm')).resolves.toEqual({ ok: false, error: 'No device available for decoder' });
    });
  });

  describe('generateDecodeSample', () => {
    beforeEach(() => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    });

    it('resolves with a temp path carrying the codec-specific extension', async () => {
      exitWith(0);

      const samplePath = await tester.generateDecodeSample('vp9');

      expect(samplePath).toMatch(/youtarr-decode-sample-vp9-[0-9a-f]{12}\.webm$/);
    });

    it.each([
      ['h264', 'mp4'],
      ['vp9', 'webm'],
      ['av1', 'mkv'],
    ])('uses the .%s -> .%s container', async (codec, ext) => {
      exitWith(0);

      expect((await tester.generateDecodeSample(codec)).endsWith(`.${ext}`)).toBe(true);
    });

    it('falls back to h264 for an unknown codec', async () => {
      exitWith(0);

      expect((await tester.generateDecodeSample('mpeg2')).endsWith('.mp4')).toBe(true);
    });

    it('writes the sample to the path it returns', async () => {
      exitWith(0);

      const samplePath = await tester.generateDecodeSample('h264');

      expect(spawn.mock.calls[0][1][spawn.mock.calls[0][1].length - 1]).toBe(samplePath);
    });

    it('rejects when ffmpeg exits non-zero', async () => {
      exitWith(1, { stderr: 'Unknown encoder libvpx-vp9' });

      await expect(tester.generateDecodeSample('vp9')).rejects.toThrow('Unknown encoder libvpx-vp9');
    });

    it('rejects when ffmpeg exits 0 but produced no file', async () => {
      fs.existsSync.mockReturnValue(false);
      exitWith(0);

      await expect(tester.generateDecodeSample('h264')).rejects.toThrow('Failed to generate h264 decode-test sample (exit 0)');
    });

    it('includes the signal when ffmpeg was killed', async () => {
      exitWith(null, { signal: 'SIGKILL' });

      await expect(tester.generateDecodeSample('av1')).rejects.toThrow('Process was killed by signal SIGKILL');
    });

    it('rejects when ffmpeg cannot be spawned', async () => {
      spawn.mockImplementationOnce(() => {
        const proc = fakeFfmpeg();
        setImmediate(() => proc.emit('error', new Error('spawn ffmpeg ENOENT')));
        return proc;
      });

      await expect(tester.generateDecodeSample('h264')).rejects.toThrow('spawn ffmpeg ENOENT');
    });

    it('gives up after two minutes and kills ffmpeg', async () => {
      jest.useFakeTimers();
      const proc = fakeFfmpeg();
      spawn.mockReturnValueOnce(proc);

      const pending = tester.generateDecodeSample('vp9');
      const assertion = expect(pending).rejects.toThrow('Timed out after 120s generating a vp9 decode-test sample');
      await jest.advanceTimersByTimeAsync(120000);

      await assertion;
      expect(proc.kill).toHaveBeenCalled();
    });

    it('still times out when killing the process throws', async () => {
      jest.useFakeTimers();
      const proc = fakeFfmpeg();
      proc.kill.mockImplementation(() => { throw new Error('ESRCH'); });
      spawn.mockReturnValueOnce(proc);

      const pending = tester.generateDecodeSample('vp9');
      const assertion = expect(pending).rejects.toThrow('Timed out');
      await jest.advanceTimersByTimeAsync(120000);

      await assertion;
    });
  });

  describe('testAllCapabilities', () => {
    beforeEach(() => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);
    });

    function succeedAlways() {
      spawn.mockImplementation(() => {
        const proc = fakeFfmpeg();
        setImmediate(() => proc.emit('close', 0, null));
        return proc;
      });
    }

    it('builds a full encode matrix of every backend against every codec', async () => {
      succeedAlways();

      const { matrix } = await tester.testAllCapabilities();

      expect(Object.keys(matrix)).toEqual(hardwareEncoderModule.VALID_HARDWARE);
      for (const backend of hardwareEncoderModule.VALID_HARDWARE) {
        expect(Object.keys(matrix[backend])).toEqual(hardwareEncoderModule.VALID_VIDEO_CODECS);
      }
    });

    it('builds a full decode matrix of every decode backend against every source codec', async () => {
      succeedAlways();

      const { decodeMatrix } = await tester.testAllCapabilities();

      expect(Object.keys(decodeMatrix)).toEqual(hardwareDecodeModule.VALID_DECODE_HARDWARE);
      for (const backend of hardwareDecodeModule.VALID_DECODE_HARDWARE) {
        expect(Object.keys(decodeMatrix[backend])).toEqual(hardwareDecodeModule.VALID_SOURCE_CODECS);
      }
    });

    it('records each individual failure without stopping the run', async () => {
      let call = 0;
      spawn.mockImplementation(() => {
        const proc = fakeFfmpeg();
        const failThisOne = call++ === 1;
        setImmediate(() => {
          if (failThisOne) proc.stderr.emit('data', Buffer.from('no such device'));
          proc.emit('close', failThisOne ? 1 : 0, null);
        });
        return proc;
      });

      const { matrix } = await tester.testAllCapabilities();

      expect(matrix.none.h264.ok).toBe(true);
      expect(matrix.none.hevc).toEqual({ ok: false, error: 'no such device' });
      expect(matrix.none.av1.ok).toBe(true);
    });

    it('marks every decode backend untestable when a sample cannot be generated', async () => {
      const encodeRuns = hardwareEncoderModule.VALID_HARDWARE.length * hardwareEncoderModule.VALID_VIDEO_CODECS.length;
      let call = 0;
      spawn.mockImplementation(() => {
        const proc = fakeFfmpeg();
        // each source codec runs one sample generation, then one decode test per backend
        const runsPerCodec = 1 + hardwareDecodeModule.VALID_DECODE_HARDWARE.length;
        const vp9SampleIndex = encodeRuns + hardwareDecodeModule.VALID_SOURCE_CODECS.indexOf('vp9') * runsPerCodec;
        const isVp9Sample = call === vp9SampleIndex;
        call++;
        setImmediate(() => {
          if (isVp9Sample) proc.stderr.emit('data', Buffer.from('Unknown encoder libvpx-vp9'));
          proc.emit('close', isVp9Sample ? 1 : 0, null);
        });
        return proc;
      });

      const { decodeMatrix } = await tester.testAllCapabilities();

      for (const backend of hardwareDecodeModule.VALID_DECODE_HARDWARE) {
        expect(decodeMatrix[backend].vp9).toEqual({ ok: false, error: 'Could not generate a vp9 test sample: Unknown encoder libvpx-vp9' });
      }
    });

    it('deletes each generated sample when done with it', async () => {
      succeedAlways();

      await tester.testAllCapabilities();

      expect(fs.promises.unlink).toHaveBeenCalledTimes(hardwareDecodeModule.VALID_SOURCE_CODECS.length);
    });

    it('tolerates a failure deleting a sample', async () => {
      succeedAlways();
      fs.promises.unlink.mockRejectedValue(new Error('EBUSY'));

      await expect(tester.testAllCapabilities()).resolves.toHaveProperty('matrix');
    });
  });
});
