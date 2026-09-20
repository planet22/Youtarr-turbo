/* eslint-env jest */

const {
  isBufferFetchActive,
  markBufferFetchStarted,
  markBufferFetchFinished,
  parseBufferedSeconds,
} = require('../ytstreamBufferFetch');

describe('ytstreamBufferFetch', () => {
  describe('in-flight fetch guard', () => {
    afterEach(() => {
      markBufferFetchFinished('vid-guard-1');
      markBufferFetchFinished('vid-guard-2');
    });

    it('reports a video as inactive before any fetch starts', () => {
      expect(isBufferFetchActive('vid-guard-1')).toBe(false);
    });

    it('reports a video as active after its fetch starts', () => {
      markBufferFetchStarted('vid-guard-1');

      expect(isBufferFetchActive('vid-guard-1')).toBe(true);
    });

    it('reports a video as inactive again once its fetch finishes', () => {
      markBufferFetchStarted('vid-guard-1');
      markBufferFetchFinished('vid-guard-1');

      expect(isBufferFetchActive('vid-guard-1')).toBe(false);
    });

    it('tracks each video independently', () => {
      markBufferFetchStarted('vid-guard-1');

      expect(isBufferFetchActive('vid-guard-2')).toBe(false);
    });

    it('does not throw when finishing a video that never started', () => {
      expect(() => markBufferFetchFinished('never-started')).not.toThrow();
    });

    it('treats a repeated start as a single active fetch', () => {
      markBufferFetchStarted('vid-guard-1');
      markBufferFetchStarted('vid-guard-1');
      markBufferFetchFinished('vid-guard-1');

      expect(isBufferFetchActive('vid-guard-1')).toBe(false);
    });
  });

  describe('parseBufferedSeconds', () => {
    it('parses an out_time line into seconds', () => {
      expect(parseBufferedSeconds('out_time=00:01:30.500000\n')).toBeCloseTo(90.5);
    });

    it('accounts for hours', () => {
      expect(parseBufferedSeconds('out_time=02:00:00.000000')).toBe(7200);
    });

    it('accepts whole seconds with no fractional part', () => {
      expect(parseBufferedSeconds('out_time=00:00:12')).toBe(12);
    });

    it('returns the most recent out_time when a chunk holds several progress blocks', () => {
      const chunk = 'out_time=00:00:05.000000\nprogress=continue\nout_time=00:00:10.000000\nprogress=continue\n';

      expect(parseBufferedSeconds(chunk)).toBe(10);
    });

    it('ignores the ambiguous out_time_ms and out_time_us fields', () => {
      expect(parseBufferedSeconds('out_time_ms=5000000\nout_time_us=5000000\n')).toBeNull();
    });

    it('reads out_time from a full progress block containing other keys', () => {
      const chunk = 'frame=100\nfps=30.0\nout_time_ms=3000000\nout_time=00:00:03.000000\nspeed=2x\n';

      expect(parseBufferedSeconds(chunk)).toBe(3);
    });

    it('returns null when the chunk has no out_time line', () => {
      expect(parseBufferedSeconds('frame=1\nprogress=continue\n')).toBeNull();
    });

    it('returns null for an empty chunk', () => {
      expect(parseBufferedSeconds('')).toBeNull();
    });

    it('returns null for out_time=N/A, which ffmpeg emits before the first output', () => {
      expect(parseBufferedSeconds('out_time=N/A\n')).toBeNull();
    });

    it('accepts a Buffer chunk', () => {
      expect(parseBufferedSeconds(Buffer.from('out_time=00:00:07.000000\n'))).toBe(7);
    });
  });
});
