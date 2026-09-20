/* eslint-env jest */

jest.mock('../../logger');
jest.mock('../videoPersistence', () => ({ upsertVideoForJob: jest.fn() }));
jest.mock('../../models/job', () => ({ create: jest.fn(), update: jest.fn() }));
jest.mock('../jobModule', () => ({ jobs: {} }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../logger');
const videoPersistence = require('../videoPersistence');
const Job = require('../../models/job');
const jobModule = require('../jobModule');
const { finalizeTapOutput, discardTapOutput, recordTsToMp4Finalize } = require('../ytstreamTapFinalizer');

const YT_ID = 'dQw4w9WgXcQ';

describe('ytstreamTapFinalizer', () => {
  let workDir;
  let tempPath;
  let finalPath;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-finalizer-'));
    tempPath = path.join(workDir, 'buffer.ts');
    finalPath = path.join(workDir, 'library', 'Channel', 'Video [dQw4w9WgXcQ].ts');
    fs.writeFileSync(tempPath, 'x'.repeat(2048));

    Object.keys(jobModule.jobs).forEach((key) => delete jobModule.jobs[key]);
    Job.create.mockImplementation(async (data) => ({ id: 101, ...data }));
    Job.update.mockResolvedValue([1]);
    videoPersistence.upsertVideoForJob.mockResolvedValue({ id: 55 });
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('finalizeTapOutput', () => {
    describe('input validation', () => {
      it('returns null when no temp path is given', async () => {
        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath: null, finalPath })).resolves.toBeNull();
      });

      it('returns null when the temp file does not exist', async () => {
        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath: path.join(workDir, 'missing.ts'), finalPath })).resolves.toBeNull();
      });

      it('returns null for an empty temp file', async () => {
        fs.writeFileSync(tempPath, '');

        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath })).resolves.toBeNull();
      });

      it('does not create a job for an empty temp file', async () => {
        fs.writeFileSync(tempPath, '');

        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(Job.create).not.toHaveBeenCalled();
      });
    });

    describe('tracked video', () => {
      it('returns the final path', async () => {
        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath })).resolves.toBe(finalPath);
      });

      it('moves the file into the library location, creating parent directories', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(fs.statSync(finalPath).size).toBe(2048);
      });

      it('removes the temp file once moved', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(fs.existsSync(tempPath)).toBe(false);
      });

      it('creates a Complete job labelled with the HLS buffer cache prefix', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, ytdlpCommand: 'yt-dlp -f best' });

        expect(Job.create).toHaveBeenCalledWith(expect.objectContaining({
          status: 'Complete',
          jobType: `HLS Buffer Cache: ${YT_ID}`,
          output: '1 videos.',
          ytdlpCommand: 'yt-dlp -f best',
        }));
      });

      it('upserts the video as a real (non-STRM) file always linked to the job', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(videoPersistence.upsertVideoForJob).toHaveBeenCalledWith(
          expect.objectContaining({ youtubeId: YT_ID, filePath: finalPath, fileSize: 2048, is_strm: false }),
          expect.objectContaining({ id: 101 }),
          true
        );
      });

      it('registers the job in jobModule so Download History shows it before a restart', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(jobModule.jobs[101]).toMatchObject({ id: 101, data: { videos: [{ id: 55 }] } });
      });

      it('leaves timings null when no start time is given', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(videoPersistence.upsertVideoForJob.mock.calls[0][0]).toMatchObject({ downloadDurationSeconds: null, avgDownloadMBps: null });
      });

      it('records download duration and throughput when a start time is given', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, startedAt: 1_000_000 - 4000 });

        expect(videoPersistence.upsertVideoForJob.mock.calls[0][0]).toMatchObject({
          downloadDurationSeconds: 4,
          avgDownloadMBps: 2048 / 1024 / 1024 / 4,
        });
      });

      it('uses the start time for the job timestamps', async () => {
        const startedAt = Date.parse('2026-05-01T10:00:00Z');

        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, startedAt });

        expect(Job.create.mock.calls[0][0].timeInitiated).toEqual(new Date(startedAt));
      });

      it('returns null and logs a warning when the job cannot be created', async () => {
        Job.create.mockRejectedValue(new Error('db down'));

        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath })).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalled();
      });

      it('returns null when the video upsert fails', async () => {
        videoPersistence.upsertVideoForJob.mockRejectedValue(new Error('constraint'));

        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath })).resolves.toBeNull();
      });
    });

    describe('cross-device move', () => {
      it('falls back to copy and unlink when rename fails with EXDEV', async () => {
        const realRename = fs.renameSync;
        jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
          if (from === tempPath) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
          return realRename(from, to);
        });

        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(fs.existsSync(finalPath)).toBe(true);
        expect(fs.existsSync(tempPath)).toBe(false);
      });

      it('fails (returns null) for any other rename error', async () => {
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        });

        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath })).resolves.toBeNull();
      });

      it('leaves the temp file in place after a non-EXDEV rename error', async () => {
        jest.spyOn(fs, 'renameSync').mockImplementation(() => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        });

        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

        expect(fs.existsSync(tempPath)).toBe(true);
      });
    });

    describe('untracked video (skipVideoUpsert)', () => {
      it('returns the final path', async () => {
        await expect(finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, skipVideoUpsert: true })).resolves.toBe(finalPath);
      });

      it('never creates or updates a Video row', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, skipVideoUpsert: true });

        expect(videoPersistence.upsertVideoForJob).not.toHaveBeenCalled();
      });

      it('creates a Complete job carrying the file facts in aux_data', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, skipVideoUpsert: true });

        const auxData = JSON.parse(Job.create.mock.calls[0][0].aux_data);
        expect(auxData.hlsBufferCacheInfo).toMatchObject({ youtubeId: YT_ID, filePath: finalPath, fileSize: 2048 });
      });

      it('registers the job with an empty videos array', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, skipVideoUpsert: true });

        expect(jobModule.jobs[101].data.videos).toEqual([]);
      });

      it('keeps the cache info on the in-memory job for later finalize matching', async () => {
        await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, skipVideoUpsert: true });

        expect(jobModule.jobs[101].data.hlsBufferCacheInfo.filePath).toBe(finalPath);
      });
    });
  });

  describe('discardTapOutput', () => {
    it('deletes the temp file', async () => {
      discardTapOutput({ youtubeId: YT_ID, tempPath });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(tempPath)).toBe(false);
    });

    it('does nothing when no temp path is given', () => {
      expect(() => discardTapOutput({ youtubeId: YT_ID, tempPath: null })).not.toThrow();
    });

    it('does not warn when the file is already gone', async () => {
      discardTapOutput({ youtubeId: YT_ID, tempPath: path.join(workDir, 'missing.ts') });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('warns when deletion fails for a reason other than the file being missing', async () => {
      jest.spyOn(fs, 'unlink').mockImplementation((_p, cb) => cb(Object.assign(new Error('busy'), { code: 'EBUSY' })));

      discardTapOutput({ youtubeId: YT_ID, tempPath });

      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('recordTsToMp4Finalize', () => {
    const oldPath = '/cache/dQw4w9WgXcQ.ts';
    const newPath = '/cache/dQw4w9WgXcQ.mp4';

    function seedOriginalJob(overrides = {}) {
      jobModule.jobs[7] = {
        id: 7,
        data: { hlsBufferCacheInfo: { youtubeId: YT_ID, filePath: oldPath }, videos: [] },
        ...overrides,
      };
    }

    it('returns false when no original fetch job matches', async () => {
      await expect(recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234)).resolves.toBe(false);
    });

    it('does not create a job when nothing matches', async () => {
      await recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234);

      expect(Job.create).not.toHaveBeenCalled();
    });

    it('does not match a job for the same video at a different file path', async () => {
      seedOriginalJob({ data: { hlsBufferCacheInfo: { youtubeId: YT_ID, filePath: '/cache/other.ts' } } });

      await expect(recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234)).resolves.toBe(false);
    });

    it('does not match a job for a different video at the same file path', async () => {
      seedOriginalJob({ data: { hlsBufferCacheInfo: { youtubeId: 'someoneElse1', filePath: oldPath } } });

      await expect(recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234)).resolves.toBe(false);
    });

    it('ignores jobs that carry no data', async () => {
      jobModule.jobs[9] = { id: 9 };

      await expect(recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234)).resolves.toBe(false);
    });

    it('returns true when the original job is found', async () => {
      seedOriginalJob();

      await expect(recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234)).resolves.toBe(true);
    });

    it('creates a separate Complete job with the finalize label', async () => {
      seedOriginalJob();

      await recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234);

      expect(Job.create).toHaveBeenCalledWith(expect.objectContaining({
        status: 'Complete',
        jobType: `HLS Buffer Cache Finalize: ${YT_ID}`,
      }));
    });

    it('records the new file and links back to the original job', async () => {
      seedOriginalJob();

      await recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234);

      const auxData = JSON.parse(Job.create.mock.calls[0][0].aux_data);
      expect(auxData).toMatchObject({
        finalizeOfJobId: 7,
        hlsBufferCacheInfo: { youtubeId: YT_ID, filePath: newPath, fileSize: 1234 },
      });
    });

    it('links the original job forward to the finalize job in memory', async () => {
      seedOriginalJob();

      await recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234);

      expect(jobModule.jobs[7].data.finalizedByJobId).toBe(101);
    });

    it('persists the forward link on the original job row', async () => {
      seedOriginalJob();

      await recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234);

      expect(Job.update).toHaveBeenCalledWith({ aux_data: expect.any(String) }, { where: { id: 7 } });
    });

    it('registers the finalize job in memory', async () => {
      seedOriginalJob();

      await recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234);

      expect(jobModule.jobs[101]).toMatchObject({ id: 101, data: { finalizeOfJobId: 7, videos: [] } });
    });

    it('still succeeds when persisting the forward link fails', async () => {
      seedOriginalJob();
      Job.update.mockRejectedValue(new Error('db down'));

      await expect(recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234)).resolves.toBe(true);
    });

    it('keeps the in-memory forward link when persisting it fails', async () => {
      seedOriginalJob();
      Job.update.mockRejectedValue(new Error('db down'));

      await recordTsToMp4Finalize(YT_ID, oldPath, newPath, 1234);

      expect(jobModule.jobs[7].data.finalizedByJobId).toBe(101);
    });
  });
});
