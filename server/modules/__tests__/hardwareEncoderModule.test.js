/* eslint-env jest */

const {
  VALID_HARDWARE,
  VALID_VIDEO_CODECS,
  VALID_AUDIO_CODECS,
  ENCODER_NAME,
  normalizeHardwareMode,
  normalizeVideoCodec,
  normalizeAudioCodec,
  buildVideoEncoderArgs,
  buildSoftwareVideoEncoderArgs,
  buildAudioEncoderArgs,
} = require('../hardwareEncoderModule');

// The value following a flag in an ffmpeg arg list
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

describe('hardwareEncoderModule', () => {
  describe('normalizeHardwareMode', () => {
    it.each(VALID_HARDWARE)('keeps the valid mode %s', (mode) => {
      expect(normalizeHardwareMode(mode)).toBe(mode);
    });

    it('lowercases and trims', () => {
      expect(normalizeHardwareMode('  NVENC ')).toBe('nvenc');
    });

    it.each([undefined, null, '', 'cuda'])('falls back to none for %p', (mode) => {
      expect(normalizeHardwareMode(mode)).toBe('none');
    });
  });

  describe('normalizeVideoCodec', () => {
    it.each(VALID_VIDEO_CODECS)('keeps the valid codec %s', (codec) => {
      expect(normalizeVideoCodec(codec)).toBe(codec);
    });

    it('lowercases and trims', () => {
      expect(normalizeVideoCodec(' HEVC ')).toBe('hevc');
    });

    it.each([undefined, null, '', 'vp9'])('falls back to h264 for %p', (codec) => {
      expect(normalizeVideoCodec(codec)).toBe('h264');
    });
  });

  describe('normalizeAudioCodec', () => {
    it.each(VALID_AUDIO_CODECS)('keeps the valid codec %s', (codec) => {
      expect(normalizeAudioCodec(codec)).toBe(codec);
    });

    it('lowercases and trims', () => {
      expect(normalizeAudioCodec(' Opus ')).toBe('opus');
    });

    it.each([undefined, null, '', 'flac'])('falls back to copy for %p', (codec) => {
      expect(normalizeAudioCodec(codec)).toBe('copy');
    });
  });

  describe('buildAudioEncoderArgs', () => {
    it('passes audio through untouched for copy', () => {
      expect(buildAudioEncoderArgs('copy')).toEqual(['-c:a', 'copy']);
    });

    it('encodes AAC at 192k / 48kHz', () => {
      expect(buildAudioEncoderArgs('aac')).toEqual(['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']);
    });

    it('encodes Opus at 160k / 48kHz', () => {
      expect(buildAudioEncoderArgs('opus')).toEqual(['-c:a', 'libopus', '-b:a', '160k', '-ar', '48000']);
    });

    it('defaults an unknown codec to copy', () => {
      expect(buildAudioEncoderArgs('flac')).toEqual(['-c:a', 'copy']);
    });
  });

  describe('buildVideoEncoderArgs', () => {
    describe('encoder selection', () => {
      const codecs = ['h264', 'hevc', 'av1'];
      const backends = ['qsv', 'nvenc', 'vaapi', 'amf', 'none'];

      it.each(codecs.flatMap((codec) => backends.map((backend) => [codec, backend])))(
        'uses the matching encoder for %s on %s',
        (codec, backend) => {
          const { encoderArgs } = buildVideoEncoderArgs(backend, codec);
          const expected = backend === 'none' ? ENCODER_NAME[codec].software : ENCODER_NAME[codec][backend];

          expect(argAfter(encoderArgs, '-c:v')).toBe(expected);
        }
      );

      it('defaults to software h264 when called with no arguments beyond the mode', () => {
        expect(argAfter(buildVideoEncoderArgs('none').encoderArgs, '-c:v')).toBe('libx264');
      });

      it('treats an unrecognised hardware mode as software', () => {
        expect(argAfter(buildVideoEncoderArgs('bogus', 'h264').encoderArgs, '-c:v')).toBe('libx264');
      });

      it('treats an unrecognised codec as h264', () => {
        expect(argAfter(buildVideoEncoderArgs('none', 'vp9').encoderArgs, '-c:v')).toBe('libx264');
      });
    });

    describe('vaapi', () => {
      it('points ffmpeg at the render node before the input', () => {
        expect(buildVideoEncoderArgs('vaapi').preInputArgs).toEqual(['-vaapi_device', '/dev/dri/renderD128']);
      });

      it('uploads frames to the GPU without scaling when uncapped', () => {
        expect(buildVideoEncoderArgs('vaapi').videoFilters).toEqual(['format=nv12,hwupload']);
      });

      it('scales down to the width cap before upload', () => {
        const { videoFilters } = buildVideoEncoderArgs('vaapi', 'h264', { maxWidth: 1920 });

        expect(videoFilters[0]).toBe('scale=\'min(1920,iw)\':-2:force_original_aspect_ratio=decrease,format=nv12,hwupload');
      });

      it('sets no pixel format', () => {
        expect(buildVideoEncoderArgs('vaapi').pixFmt).toBeNull();
      });

      it('uses constant-QP quality', () => {
        expect(argAfter(buildVideoEncoderArgs('vaapi').encoderArgs, '-qp')).toBe('21');
      });
    });

    describe('qsv', () => {
      it('initialises the vaapi and qsv devices before the input', () => {
        expect(buildVideoEncoderArgs('qsv').preInputArgs).toEqual([
          '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
          '-init_hw_device', 'qsv=qsv@va',
          '-filter_hw_device', 'qsv',
        ]);
      });

      it('scales in hardware without a cap', () => {
        expect(buildVideoEncoderArgs('qsv').videoFilters).toEqual(['hwupload=extra_hw_frames=64', 'format=qsv', 'scale_qsv=format=nv12']);
      });

      it('caps the width in the qsv scaler when maxWidth is set', () => {
        const { videoFilters } = buildVideoEncoderArgs('qsv', 'h264', { maxWidth: 1280 });

        expect(videoFilters[2]).toContain('w=\'min(1280,iw)\'');
      });

      it('sets an empty pixel format so ffmpeg does not override the hardware surface', () => {
        expect(buildVideoEncoderArgs('qsv').pixFmt).toBe('');
      });

      it('disables look-ahead', () => {
        expect(argAfter(buildVideoEncoderArgs('qsv').encoderArgs, '-look_ahead')).toBe('0');
      });
    });

    describe('nvenc', () => {
      it('needs no pre-input device args', () => {
        expect(buildVideoEncoderArgs('nvenc').preInputArgs).toEqual([]);
      });

      it('converts to yuv420p in software filters', () => {
        expect(buildVideoEncoderArgs('nvenc').videoFilters).toEqual(['format=yuv420p']);
      });

      it('uses preset p5 with variable-bitrate constant quality', () => {
        const { encoderArgs } = buildVideoEncoderArgs('nvenc');

        expect([argAfter(encoderArgs, '-preset'), argAfter(encoderArgs, '-cq'), argAfter(encoderArgs, '-rc')]).toEqual(['p5', '21', 'vbr']);
      });

      it('scales down to the width cap', () => {
        const { videoFilters } = buildVideoEncoderArgs('nvenc', 'h264', { maxWidth: 1920 });

        expect(videoFilters[0]).toBe('scale=\'min(1920,iw)\':-2:force_original_aspect_ratio=decrease,format=yuv420p');
      });
    });

    describe('amf', () => {
      it('uses quality-VBR rate control', () => {
        const { encoderArgs } = buildVideoEncoderArgs('amf');

        expect([argAfter(encoderArgs, '-rc'), argAfter(encoderArgs, '-qvbr_quality_level')]).toEqual(['qvbr', '21']);
      });

      it('sets yuv420p as the pixel format', () => {
        expect(buildVideoEncoderArgs('amf').pixFmt).toBe('yuv420p');
      });
    });

    describe('software', () => {
      it.each([
        ['h264', 'veryfast', '23'],
        ['hevc', 'veryfast', '26'],
        ['av1', '6', '30'],
      ])('uses the %s preset %s and crf %s', (codec, preset, crf) => {
        const { encoderArgs } = buildVideoEncoderArgs('none', codec);

        expect([argAfter(encoderArgs, '-preset'), argAfter(encoderArgs, '-crf')]).toEqual([preset, crf]);
      });

      it('fixes the GOP for h264 so HLS segments cut on a frame count', () => {
        const { encoderArgs } = buildVideoEncoderArgs('none', 'h264');

        expect([argAfter(encoderArgs, '-g'), argAfter(encoderArgs, '-keyint_min'), argAfter(encoderArgs, '-sc_threshold')]).toEqual(['120', '120', '0']);
      });

      it('omits the fixed GOP for software av1', () => {
        expect(buildVideoEncoderArgs('none', 'av1').encoderArgs).not.toContain('-g');
      });

      it('scales down to the width cap', () => {
        const { videoFilters } = buildVideoEncoderArgs('none', 'h264', { maxWidth: 1920 });

        expect(videoFilters[0]).toBe('scale=\'min(1920,iw)\':-2:force_original_aspect_ratio=decrease,format=yuv420p');
      });

      it('ignores a non-positive width cap', () => {
        expect(buildVideoEncoderArgs('none', 'h264', { maxWidth: 0 }).videoFilters).toEqual(['format=yuv420p']);
      });
    });

    describe('codec tags for Apple playback', () => {
      it('tags hevc as hvc1', () => {
        expect(argAfter(buildVideoEncoderArgs('none', 'hevc').encoderArgs, '-tag:v')).toBe('hvc1');
      });

      it('tags av1 as av01', () => {
        expect(argAfter(buildVideoEncoderArgs('none', 'av1').encoderArgs, '-tag:v')).toBe('av01');
      });

      it('does not tag h264', () => {
        expect(buildVideoEncoderArgs('none', 'h264').encoderArgs).not.toContain('-tag:v');
      });

      it.each(['qsv', 'nvenc', 'vaapi'])('tags hevc on %s too', (backend) => {
        expect(argAfter(buildVideoEncoderArgs(backend, 'hevc').encoderArgs, '-tag:v')).toBe('hvc1');
      });
    });

    describe('rate-control ceiling', () => {
      it('uses a fixed 12M ceiling when the width is capped (streaming)', () => {
        const { encoderArgs } = buildVideoEncoderArgs('nvenc', 'h264', { maxWidth: 1920, sourceHeight: 2160 });

        expect(argAfter(encoderArgs, '-maxrate')).toBe('12000k');
      });

      it('sets the buffer size to twice the ceiling', () => {
        const { encoderArgs } = buildVideoEncoderArgs('nvenc', 'h264', { maxWidth: 1920 });

        expect(argAfter(encoderArgs, '-bufsize')).toBe('24000k');
      });

      it.each([
        [2160, '35000k'],
        [1440, '16000k'],
        [1080, '8000k'],
        [720, '5000k'],
        [480, '2500k'],
        [360, '1200k'],
      ])('scales the ceiling for a %sp source', (height, expected) => {
        const { encoderArgs } = buildVideoEncoderArgs('nvenc', 'h264', { sourceHeight: height });

        expect(argAfter(encoderArgs, '-maxrate')).toBe(expected);
      });

      it('rounds an in-between height up to the next tier', () => {
        const { encoderArgs } = buildVideoEncoderArgs('nvenc', 'h264', { sourceHeight: 900 });

        expect(argAfter(encoderArgs, '-maxrate')).toBe('8000k');
      });

      it('clamps a source taller than 4K to the top tier', () => {
        const { encoderArgs } = buildVideoEncoderArgs('nvenc', 'h264', { sourceHeight: 4320 });

        expect(argAfter(encoderArgs, '-maxrate')).toBe('35000k');
      });

      it('falls back to 12M when the source height is unknown', () => {
        expect(argAfter(buildVideoEncoderArgs('qsv', 'h264').encoderArgs, '-maxrate')).toBe('12000k');
      });

      it('falls back to 12M for a non-positive source height', () => {
        expect(argAfter(buildVideoEncoderArgs('qsv', 'h264', { sourceHeight: -1 }).encoderArgs, '-maxrate')).toBe('12000k');
      });
    });
  });

  describe('buildSoftwareVideoEncoderArgs', () => {
    it('matches the software output of buildVideoEncoderArgs', () => {
      expect(buildSoftwareVideoEncoderArgs('hevc', { maxWidth: 1280 })).toEqual(buildVideoEncoderArgs('none', 'hevc', { maxWidth: 1280 }));
    });

    it('uses a software encoder for every codec', () => {
      const encoders = VALID_VIDEO_CODECS.map((codec) => argAfter(buildSoftwareVideoEncoderArgs(codec).encoderArgs, '-c:v'));

      expect(encoders).toEqual(['libx264', 'libx265', 'libsvtav1']);
    });
  });
});
