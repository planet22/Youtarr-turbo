/* eslint-env jest */
const streamEncoderTuning = require('../streamEncoderTuning');

const { buildVideoEncoderArgs, normalizeHardwareMode, normalizeTuning, resolveEncoderBitrateCaps, VALID_HARDWARE, VALID_TUNING } = streamEncoderTuning;

describe('normalizeHardwareMode', () => {
  test.each(VALID_HARDWARE)('accepts %s as-is', (mode) => {
    expect(normalizeHardwareMode(mode)).toBe(mode);
  });

  test('falls back to none for unknown/missing values', () => {
    expect(normalizeHardwareMode('bogus')).toBe('none');
    expect(normalizeHardwareMode(undefined)).toBe('none');
    expect(normalizeHardwareMode(null)).toBe('none');
  });

  test('is case-insensitive and trims whitespace', () => {
    expect(normalizeHardwareMode(' QSV ')).toBe('qsv');
  });
});

describe('normalizeTuning', () => {
  test.each(VALID_TUNING)('accepts %s as-is', (tuning) => {
    expect(normalizeTuning(tuning)).toBe(tuning);
  });

  test('falls back to fast for unknown/missing values', () => {
    expect(normalizeTuning('bogus')).toBe('fast');
    expect(normalizeTuning(undefined)).toBe('fast');
  });
});

describe('resolveEncoderBitrateCaps', () => {
  test('floors maxrate at the legacy flat 12000k for low/mid resolutions', () => {
    expect(resolveEncoderBitrateCaps(720).maxrate).toBe('12000k');
    expect(resolveEncoderBitrateCaps(1080).maxrate).toBe('12000k');
  });

  test('scales above the floor for high resolutions', () => {
    const caps2160 = resolveEncoderBitrateCaps(2160);
    expect(caps2160.maxrate).toBe('30000k'); // 20000 * 1.5
    expect(caps2160.bufsize).toBe('60000k');
  });

  test('null height (uncapped "best") uses the top tier', () => {
    expect(resolveEncoderBitrateCaps(null)).toEqual(resolveEncoderBitrateCaps(2160));
  });
});

describe('buildVideoEncoderArgs — software (none)', () => {
  test('fast tier matches the original hardcoded defaults (backward compatibility)', () => {
    const result = buildVideoEncoderArgs('none', 1080, 'fast');
    expect(result.encoderArgs).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0']);
  });

  test('defaults to fast when tuning is omitted', () => {
    const withDefault = buildVideoEncoderArgs('none', 1080);
    const explicitFast = buildVideoEncoderArgs('none', 1080, 'fast');
    expect(withDefault).toEqual(explicitFast);
  });

  test('quality tier uses a lower CRF and slower preset than fast', () => {
    const fast = buildVideoEncoderArgs('none', 1080, 'fast');
    const quality = buildVideoEncoderArgs('none', 1080, 'quality');
    const fastCrf = Number(fast.encoderArgs[fast.encoderArgs.indexOf('-crf') + 1]);
    const qualityCrf = Number(quality.encoderArgs[quality.encoderArgs.indexOf('-crf') + 1]);
    expect(qualityCrf).toBeLessThan(fastCrf);
    expect(quality.encoderArgs).toContain('medium');
    expect(quality.encoderArgs).not.toContain('veryfast');
  });

  test('balanced tier sits strictly between fast and quality', () => {
    const tiers = ['fast', 'balanced', 'quality'].map((t) => {
      const args = buildVideoEncoderArgs('none', 1080, t).encoderArgs;
      return Number(args[args.indexOf('-crf') + 1]);
    });
    expect(tiers[0]).toBeGreaterThan(tiers[1]);
    expect(tiers[1]).toBeGreaterThan(tiers[2]);
  });

  test('scales resolution down (never up) via a decrease-only filter', () => {
    const capped = buildVideoEncoderArgs('none', 720, 'fast');
    expect(capped.videoFilters[0]).toContain('min(720,ih)');
    expect(capped.videoFilters[0]).toContain('force_original_aspect_ratio=decrease');
  });

  test('null height ("best") skips scaling entirely', () => {
    const uncapped = buildVideoEncoderArgs('none', null, 'fast');
    expect(uncapped.videoFilters[0]).toBe('format=yuv420p');
  });
});

describe('buildVideoEncoderArgs — qsv', () => {
  test('fast tier matches original defaults: global_quality 21, look_ahead 0', () => {
    const result = buildVideoEncoderArgs('qsv', 1080, 'fast');
    expect(result.encoderArgs).toEqual(
      expect.arrayContaining(['-global_quality', '21', '-look_ahead', '0'])
    );
  });

  test('fast tier only forces -preset veryfast at 1440p+, matching original height rule', () => {
    expect(buildVideoEncoderArgs('qsv', 1080, 'fast').encoderArgs).not.toContain('-preset');
    expect(buildVideoEncoderArgs('qsv', 1440, 'fast').encoderArgs).toContain('-preset');
    expect(buildVideoEncoderArgs('qsv', null, 'fast').encoderArgs).toContain('-preset');
  });

  test('quality tier enables look-ahead and lowers global_quality', () => {
    const result = buildVideoEncoderArgs('qsv', 1080, 'quality');
    expect(result.encoderArgs).toEqual(
      expect.arrayContaining(['-global_quality', '17', '-look_ahead', '1'])
    );
  });
});

describe('buildVideoEncoderArgs — nvenc', () => {
  test('fast tier matches original defaults: preset p5, cq 21', () => {
    const result = buildVideoEncoderArgs('nvenc', 1080, 'fast');
    expect(result.encoderArgs).toEqual(
      expect.arrayContaining(['-preset', 'p5', '-cq', '21', '-rc', 'vbr'])
    );
  });

  test('quality tier uses the slowest/highest-quality preset p7', () => {
    const result = buildVideoEncoderArgs('nvenc', 1080, 'quality');
    expect(result.encoderArgs).toEqual(expect.arrayContaining(['-preset', 'p7', '-cq', '17']));
  });
});

describe('buildVideoEncoderArgs — vaapi', () => {
  test('fast tier matches original default qp 21, defaults -quality to its own compressionLevel (7), and never sets maxrate/bufsize', () => {
    const result = buildVideoEncoderArgs('vaapi', 1080, 'fast');
    expect(result.encoderArgs).toEqual(['-c:v', 'h264_vaapi', '-qp', '21', '-quality', '7', '-g', '120', '-keyint_min', '120', '-sc_threshold', '0']);
  });

  test('quality tier uses a lower (higher-quality) qp and compressionLevel (1)', () => {
    const result = buildVideoEncoderArgs('vaapi', 1080, 'quality');
    expect(result.encoderArgs).toEqual(expect.arrayContaining(['-qp', '15', '-quality', '1']));
  });

  test('balanced tier defaults to compressionLevel 4', () => {
    const result = buildVideoEncoderArgs('vaapi', 1080, 'balanced');
    expect(result.encoderArgs).toEqual(expect.arrayContaining(['-quality', '4']));
  });

  test('an explicit vaapiQuality override wins over the tuning tier default', () => {
    const result = buildVideoEncoderArgs('vaapi', 1080, 'fast', 3);
    expect(result.encoderArgs).toEqual(expect.arrayContaining(['-quality', '3']));
  });

  test('clamps an explicit vaapiQuality override to the 1-7 range', () => {
    expect(buildVideoEncoderArgs('vaapi', 1080, 'fast', 0).encoderArgs).toEqual(expect.arrayContaining(['-quality', '1']));
    expect(buildVideoEncoderArgs('vaapi', 1080, 'fast', 99).encoderArgs).toEqual(expect.arrayContaining(['-quality', '7']));
  });

  test('ignores vaapiQuality for every other hardwareMode', () => {
    expect(buildVideoEncoderArgs('none', 1080, 'fast', 3).encoderArgs).not.toContain('-quality');
    expect(buildVideoEncoderArgs('nvenc', 1080, 'fast', 3).encoderArgs).not.toContain('-quality');
  });
});

describe('buildVideoEncoderArgs — amf', () => {
  test('fast tier matches original defaults: quality speed, qvbr 21', () => {
    const result = buildVideoEncoderArgs('amf', 1080, 'fast');
    expect(result.encoderArgs).toEqual(
      expect.arrayContaining(['-quality', 'speed', '-rc', 'qvbr', '-qvbr_quality_level', '21'])
    );
  });

  test('quality tier uses AMF\'s slowest/highest-quality preset', () => {
    const result = buildVideoEncoderArgs('amf', 1080, 'quality');
    expect(result.encoderArgs).toEqual(
      expect.arrayContaining(['-quality', 'quality', '-qvbr_quality_level', '17'])
    );
  });
});
