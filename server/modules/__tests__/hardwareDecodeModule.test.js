/* eslint-env jest */
const hardwareDecodeModule = require('../hardwareDecodeModule');

describe('normalizeDecodeHardwareMode', () => {
  test('accepts every valid mode', () => {
    for (const mode of hardwareDecodeModule.VALID_DECODE_HARDWARE) {
      expect(hardwareDecodeModule.normalizeDecodeHardwareMode(mode)).toBe(mode);
    }
  });

  test('falls back to none for an invalid/unknown mode (e.g. amf - not a valid decode backend)', () => {
    expect(hardwareDecodeModule.normalizeDecodeHardwareMode('amf')).toBe('none');
    expect(hardwareDecodeModule.normalizeDecodeHardwareMode('bogus')).toBe('none');
    expect(hardwareDecodeModule.normalizeDecodeHardwareMode(undefined)).toBe('none');
  });

  test('is case-insensitive and trims whitespace', () => {
    expect(hardwareDecodeModule.normalizeDecodeHardwareMode(' VAAPI ')).toBe('vaapi');
  });
});

describe('normalizeSourceCodec', () => {
  test('accepts every valid source codec', () => {
    for (const codec of hardwareDecodeModule.VALID_SOURCE_CODECS) {
      expect(hardwareDecodeModule.normalizeSourceCodec(codec)).toBe(codec);
    }
  });

  test('falls back to h264 for an invalid/unknown codec (e.g. hevc - not a real YouTube DASH source)', () => {
    expect(hardwareDecodeModule.normalizeSourceCodec('hevc')).toBe('h264');
    expect(hardwareDecodeModule.normalizeSourceCodec(undefined)).toBe('h264');
  });
});

describe('buildDecodeArgs', () => {
  test('none produces no preInputArgs at all', () => {
    expect(hardwareDecodeModule.buildDecodeArgs('none')).toEqual({ preInputArgs: [] });
  });

  test('vaapi sets -hwaccel vaapi with an explicit device', () => {
    expect(hardwareDecodeModule.buildDecodeArgs('vaapi')).toEqual({
      preInputArgs: ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128'],
    });
  });

  test('qsv sets -hwaccel qsv with no explicit device', () => {
    expect(hardwareDecodeModule.buildDecodeArgs('qsv')).toEqual({ preInputArgs: ['-hwaccel', 'qsv'] });
  });

  test('nvenc maps to ffmpeg\'s cuda (NVDEC) hwaccel, not the literal string "nvenc"', () => {
    expect(hardwareDecodeModule.buildDecodeArgs('nvenc')).toEqual({ preInputArgs: ['-hwaccel', 'cuda'] });
  });

  test('an invalid mode normalizes to none (no preInputArgs)', () => {
    expect(hardwareDecodeModule.buildDecodeArgs('amf')).toEqual({ preInputArgs: [] });
  });
});

describe('buildSampleGeneratorArgs', () => {
  test('h264 uses libx264 and ends with the given output path', () => {
    const args = hardwareDecodeModule.buildSampleGeneratorArgs('h264', {}, '/tmp/sample.mp4');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264']));
    expect(args[args.length - 1]).toBe('/tmp/sample.mp4');
  });

  test('vp9 uses libvpx-vp9', () => {
    const args = hardwareDecodeModule.buildSampleGeneratorArgs('vp9', {}, '/tmp/sample.webm');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libvpx-vp9']));
  });

  test('av1 uses libsvtav1 with a numeric preset', () => {
    const args = hardwareDecodeModule.buildSampleGeneratorArgs('av1', {}, '/tmp/sample.mkv');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libsvtav1', '-preset', '10']));
  });

  test('feeds a synthetic lavfi source - no bundled asset needed', () => {
    const args = hardwareDecodeModule.buildSampleGeneratorArgs('h264', { width: 640, height: 360, durationSeconds: 2 }, '/tmp/x.mp4');
    expect(args).toEqual(expect.arrayContaining(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2']));
  });

  test('an invalid source codec normalizes to h264', () => {
    const args = hardwareDecodeModule.buildSampleGeneratorArgs('hevc', {}, '/tmp/x.mp4');
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'libx264']));
  });
});
