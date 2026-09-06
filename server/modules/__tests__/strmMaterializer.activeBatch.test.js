/* eslint-env jest */

// Targeted coverage for the active-batch controls (pause/resume/reorder/
// remove) that back the Job Queue table's live STRM controls. These only
// touch strmMaterializer's in-memory _activeBatch bookkeeping, so - like
// strmMaterializer.writeThumbnail.test.js - this avoids mocking the much
// larger collaborator graph materializeMany itself needs (ytDlpRunner,
// nfoGenerator, strmGenerator, models, ...), which has no existing coverage.

jest.mock('../configModule', () => ({
  getImagePath: jest.fn().mockReturnValue('/images'),
}));
jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../jobModule', () => ({
  getJob: jest.fn(),
  emitJobsUpdated: jest.fn(),
}));

const strmMaterializer = require('../strmMaterializer');
const jobModule = require('../jobModule');

describe('strmMaterializer active batch controls', () => {
  beforeEach(() => {
    strmMaterializer._activeBatch = null;
  });

  const setBatch = (overrides = {}) => {
    strmMaterializer._activeBatch = {
      jobId: 'job-1',
      cancelled: false,
      paused: false,
      remainingUrls: ['https://youtu.be/a', 'https://youtu.be/b', 'https://youtu.be/c'],
      processedUrls: ['https://youtu.be/z'],
      ...overrides,
    };
  };

  describe('pauseActiveJob / resumeActiveJob', () => {
    test('pauses a matching active batch', () => {
      setBatch();
      expect(strmMaterializer.pauseActiveJob('job-1')).toBe(true);
      expect(strmMaterializer._activeBatch.paused).toBe(true);
    });

    test('returns false when there is no matching active batch', () => {
      setBatch({ jobId: 'other-job' });
      expect(strmMaterializer.pauseActiveJob('job-1')).toBe(false);
    });

    test('returns false when there is no active batch at all', () => {
      expect(strmMaterializer.pauseActiveJob('job-1')).toBe(false);
    });

    test('resumes a matching paused batch', () => {
      setBatch({ paused: true });
      expect(strmMaterializer.resumeActiveJob('job-1')).toBe(true);
      expect(strmMaterializer._activeBatch.paused).toBe(false);
    });
  });

  describe('getActiveBatchState', () => {
    test('returns a snapshot for a matching job', () => {
      setBatch();
      expect(strmMaterializer.getActiveBatchState('job-1')).toEqual({
        processedUrls: ['https://youtu.be/z'],
        remainingUrls: ['https://youtu.be/a', 'https://youtu.be/b', 'https://youtu.be/c'],
        paused: false,
      });
    });

    test('returns null when there is no matching batch', () => {
      expect(strmMaterializer.getActiveBatchState('job-1')).toBeNull();
      setBatch({ jobId: 'other-job' });
      expect(strmMaterializer.getActiveBatchState('job-1')).toBeNull();
    });

    test('the snapshot is a copy, not a live reference', () => {
      setBatch();
      const state = strmMaterializer.getActiveBatchState('job-1');
      state.remainingUrls.push('https://youtu.be/injected');
      expect(strmMaterializer._activeBatch.remainingUrls).toHaveLength(3);
    });
  });

  describe('setActiveJobRemainingUrls', () => {
    test('reorders the remaining queue', () => {
      setBatch();
      const result = strmMaterializer.setActiveJobRemainingUrls('job-1', [
        'https://youtu.be/c',
        'https://youtu.be/a',
        'https://youtu.be/b',
      ]);
      expect(result).toEqual({ success: true });
      expect(strmMaterializer._activeBatch.remainingUrls).toEqual([
        'https://youtu.be/c',
        'https://youtu.be/a',
        'https://youtu.be/b',
      ]);
    });

    test('removes a video by omitting it from the new list', () => {
      setBatch();
      const result = strmMaterializer.setActiveJobRemainingUrls('job-1', [
        'https://youtu.be/a',
        'https://youtu.be/c',
      ]);
      expect(result).toEqual({ success: true });
      expect(strmMaterializer._activeBatch.remainingUrls).toEqual([
        'https://youtu.be/a',
        'https://youtu.be/c',
      ]);
    });

    test('silently drops a URL that is no longer queued (already processed since the client last polled) instead of rejecting the whole edit', () => {
      setBatch();
      const result = strmMaterializer.setActiveJobRemainingUrls('job-1', [
        'https://youtu.be/a',
        'https://youtu.be/stale-already-processed',
        'https://youtu.be/c',
      ]);
      expect(result).toEqual({ success: true });
      expect(strmMaterializer._activeBatch.remainingUrls).toEqual([
        'https://youtu.be/a',
        'https://youtu.be/c',
      ]);
    });

    test('rejects when every submitted URL is stale', () => {
      setBatch();
      const result = strmMaterializer.setActiveJobRemainingUrls('job-1', [
        'https://youtu.be/stale-1',
        'https://youtu.be/stale-2',
      ]);
      expect(result.success).toBe(false);
      // Unchanged on rejection
      expect(strmMaterializer._activeBatch.remainingUrls).toHaveLength(3);
    });

    test('rejects an empty list', () => {
      setBatch();
      const result = strmMaterializer.setActiveJobRemainingUrls('job-1', []);
      expect(result.success).toBe(false);
    });

    test('rejects when there is no matching active batch', () => {
      const result = strmMaterializer.setActiveJobRemainingUrls('job-1', ['https://youtu.be/a']);
      expect(result.success).toBe(false);
    });
  });

  describe('cancelActiveJob (existing behavior, still works after the rename to _activeBatch)', () => {
    test('cancels a matching batch', () => {
      setBatch();
      expect(strmMaterializer.cancelActiveJob('job-1')).toBe(true);
      expect(strmMaterializer._activeBatch.cancelled).toBe(true);
    });

    test('returns false for a non-matching job', () => {
      setBatch({ jobId: 'other-job' });
      expect(strmMaterializer.cancelActiveJob('job-1')).toBe(false);
    });
  });

  describe('_toFailedVideos', () => {
    test('maps failed results to FailedVideo-shaped objects, extracting the id from the URL', () => {
      const failedVideos = strmMaterializer._toFailedVideos([
        { ok: true, youtubeId: 'aaaaaaaaaaa' },
        { ok: false, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', error: 'boom' },
      ]);
      expect(failedVideos).toEqual([
        { youtubeId: 'bbbbbbbbbbb', title: 'Unknown', error: 'boom' },
      ]);
    });
  });

  describe('_syncJobProgress', () => {
    beforeEach(() => {
      jobModule.getJob.mockReset();
      jobModule.emitJobsUpdated.mockReset();
    });

    test('writes the current success/failure lists onto the job record and broadcasts', () => {
      const job = { data: { urls: [] } };
      jobModule.getJob.mockReturnValue(job);

      strmMaterializer._syncJobProgress('job-1', [
        { ok: true, youtubeId: 'aaaaaaaaaaa' },
        { ok: false, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', error: 'boom' },
      ]);

      expect(job.data.videos).toEqual([{ youtubeId: 'aaaaaaaaaaa' }]);
      expect(job.data.failedVideos).toEqual([{ youtubeId: 'bbbbbbbbbbb', title: 'Unknown', error: 'boom' }]);
      expect(jobModule.emitJobsUpdated).toHaveBeenCalledWith('job-1', 'VideoProgress');
    });

    test('does nothing when the job no longer exists', () => {
      jobModule.getJob.mockReturnValue(undefined);

      expect(() => strmMaterializer._syncJobProgress('job-1', [{ ok: true, youtubeId: 'a' }])).not.toThrow();
      expect(jobModule.emitJobsUpdated).not.toHaveBeenCalled();
    });

    test('does nothing when jobId is falsy', () => {
      strmMaterializer._syncJobProgress(null, [{ ok: true, youtubeId: 'a' }]);
      expect(jobModule.getJob).not.toHaveBeenCalled();
    });
  });
});
