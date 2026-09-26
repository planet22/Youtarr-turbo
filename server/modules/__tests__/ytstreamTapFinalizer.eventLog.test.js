/* eslint-env jest */

jest.mock('../../logger');
jest.mock('../videoPersistence', () => ({ upsertVideoForJob: jest.fn() }));
jest.mock('../../models/job', () => ({ create: jest.fn(), update: jest.fn() }));
jest.mock('../jobModule', () => ({ jobs: {} }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const videoPersistence = require('../videoPersistence');
const Job = require('../../models/job');
const jobModule = require('../jobModule');
const jobEventLog = require('../jobEventLog');
const { finalizeTapOutput, recordTsToMp4Finalize } = require('../ytstreamTapFinalizer');

const YT_ID = 'dQw4w9WgXcQ';

describe('ytstreamTapFinalizer video/events log', () => {
  let workDir;
  let tempPath;
  let finalPath;

  beforeEach(() => {
    jest.clearAllMocks();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-finalizer-log-'));
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
    it('records cache.hls_buffer_finalized for a tracked video, linked to the new job', async () => {
      await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

      expect(jobEventLog.record).toHaveBeenCalledWith('cache.hls_buffer_finalized', {
        jobId: 101,
        youtubeId: YT_ID,
        detail: { filePath: finalPath, fileSize: 2048, downloadDurationSeconds: null, avgDownloadMBps: null, tracked: true },
      });
    });

    it('records the same event flagged untracked when there is no Video row', async () => {
      await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, skipVideoUpsert: true });

      expect(jobEventLog.record).toHaveBeenCalledWith('cache.hls_buffer_finalized', expect.objectContaining({
        jobId: 101,
        detail: expect.objectContaining({ tracked: false, filePath: finalPath }),
      }));
    });

    it('records timing when a start time was given', async () => {
      await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath, startedAt: Date.now() - 4000 });

      expect(jobEventLog.record.mock.calls[0][1].detail.downloadDurationSeconds).toBeGreaterThanOrEqual(4);
    });

    it('records nothing for an empty temp file', async () => {
      fs.writeFileSync(tempPath, '');

      await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });

    it('records nothing when the job cannot be created', async () => {
      Job.create.mockRejectedValue(new Error('db down'));

      await finalizeTapOutput({ youtubeId: YT_ID, tempPath, finalPath });

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });

  describe('recordTsToMp4Finalize', () => {
    const OLD = '/cache/old.ts';
    const NEW = '/cache/new.mp4';

    beforeEach(() => {
      jobModule.jobs['orig-job'] = {
        id: 'orig-job',
        data: { hlsBufferCacheInfo: { youtubeId: YT_ID, filePath: OLD } },
      };
    });

    it('records cache.ts_to_mp4 on the new finalize job and names the original job', async () => {
      await recordTsToMp4Finalize(YT_ID, OLD, NEW, 999);

      expect(jobEventLog.record).toHaveBeenCalledWith('cache.ts_to_mp4', {
        jobId: 101,
        youtubeId: YT_ID,
        detail: { oldFilePath: OLD, newFilePath: NEW, newFileSize: 999, finalizesJobId: 'orig-job' },
      });
    });

    it('records nothing when no original fetch matches', async () => {
      await recordTsToMp4Finalize(YT_ID, '/cache/other.ts', NEW, 999);

      expect(jobEventLog.record).not.toHaveBeenCalled();
    });
  });
});
