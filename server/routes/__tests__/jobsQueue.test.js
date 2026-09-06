/* eslint-env jest */

const express = require('express');
const request = require('supertest');

jest.mock('../../logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

const mockStrmMaterializer = {
  pauseActiveJob: jest.fn(),
  resumeActiveJob: jest.fn(),
  setActiveJobRemainingUrls: jest.fn(),
  getActiveBatchState: jest.fn(),
};
jest.mock('../../modules/strmMaterializer', () => mockStrmMaterializer);

describe('Job queue routes', () => {
  let app;
  let mockJobModule;
  let mockDownloadModule;
  let mockVerifyToken;

  beforeEach(() => {
    jest.resetModules();

    mockStrmMaterializer.pauseActiveJob.mockReset().mockReturnValue(true);
    mockStrmMaterializer.resumeActiveJob.mockReset().mockReturnValue(true);
    mockStrmMaterializer.setActiveJobRemainingUrls.mockReset().mockReturnValue({ success: true });
    mockStrmMaterializer.getActiveBatchState.mockReset().mockReturnValue({
      processedUrls: ['https://youtu.be/z'],
      remainingUrls: ['https://youtu.be/a'],
      paused: false,
    });

    mockJobModule = {
      isQueueProcessingPaused: jest.fn().mockReturnValue(false),
      pauseQueueProcessing: jest.fn(),
      resumeQueueProcessing: jest.fn(),
      reorderPendingJobs: jest.fn().mockResolvedValue(),
      removePendingJob: jest.fn().mockResolvedValue({ success: true }),
      updateJobVideoUrls: jest.fn().mockResolvedValue({ success: true }),
      updateJob: jest.fn().mockResolvedValue(),
      emitJobsUpdated: jest.fn(),
      getJob: jest.fn(),
      getInProgressJobId: jest.fn(),
    };
    mockDownloadModule = {
      terminateCurrentDownload: jest.fn(),
      getCurrentActivitySnapshot: jest.fn(),
    };
    mockVerifyToken = (req, res, next) => next();

    const createJobRoutes = require('../jobs');

    app = express();
    app.use(express.json());
    app.use(createJobRoutes({
      verifyToken: mockVerifyToken,
      jobModule: mockJobModule,
      downloadModule: mockDownloadModule,
    }));
  });

  describe('GET /api/jobs/queue-state', () => {
    test('returns the current pause state', async () => {
      mockJobModule.isQueueProcessingPaused.mockReturnValue(true);

      const res = await request(app).get('/api/jobs/queue-state');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ paused: true });
    });
  });

  describe('POST /api/jobs/queue/pause', () => {
    test('pauses the queue', async () => {
      const res = await request(app).post('/api/jobs/queue/pause');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, paused: true });
      expect(mockJobModule.pauseQueueProcessing).toHaveBeenCalled();
    });
  });

  describe('POST /api/jobs/queue/resume', () => {
    test('resumes the queue', async () => {
      const res = await request(app).post('/api/jobs/queue/resume');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, paused: false });
      expect(mockJobModule.resumeQueueProcessing).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/jobs/queue/reorder', () => {
    test('reorders when given an array of ids', async () => {
      const res = await request(app)
        .patch('/api/jobs/queue/reorder')
        .send({ orderedIds: ['job-b', 'job-a'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockJobModule.reorderPendingJobs).toHaveBeenCalledWith(['job-b', 'job-a']);
    });

    test('rejects a non-array orderedIds', async () => {
      const res = await request(app)
        .patch('/api/jobs/queue/reorder')
        .send({ orderedIds: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(mockJobModule.reorderPendingJobs).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/jobs/:jobId/videos', () => {
    test('updates the video list', async () => {
      const res = await request(app)
        .patch('/api/jobs/job-a/videos')
        .send({ urls: ['https://youtu.be/a'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockJobModule.updateJobVideoUrls).toHaveBeenCalledWith('job-a', ['https://youtu.be/a']);
    });

    test('returns 400 when the update is rejected', async () => {
      mockJobModule.updateJobVideoUrls.mockResolvedValue({ success: false, error: 'Only pending (not yet started) jobs can have their video list edited' });

      const res = await request(app)
        .patch('/api/jobs/job-a/videos')
        .send({ urls: ['https://youtu.be/a'] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('POST /api/jobs/:jobId/strm/pause', () => {
    test('pauses the active batch and mirrors it onto the job record', async () => {
      const res = await request(app).post('/api/jobs/job-1/strm/pause');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, paused: true });
      expect(mockStrmMaterializer.pauseActiveJob).toHaveBeenCalledWith('job-1');
      expect(mockJobModule.updateJob).toHaveBeenCalledWith('job-1', { data: { strmPaused: true } });
      expect(mockJobModule.emitJobsUpdated).toHaveBeenCalledWith('job-1', 'StrmPaused');
    });

    test('returns 400 when there is no active STRM batch for the job', async () => {
      mockStrmMaterializer.pauseActiveJob.mockReturnValue(false);

      const res = await request(app).post('/api/jobs/job-1/strm/pause');

      expect(res.status).toBe(400);
      expect(mockJobModule.updateJob).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/jobs/:jobId/strm/resume', () => {
    test('resumes the active batch and mirrors it onto the job record', async () => {
      const res = await request(app).post('/api/jobs/job-1/strm/resume');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, paused: false });
      expect(mockStrmMaterializer.resumeActiveJob).toHaveBeenCalledWith('job-1');
      expect(mockJobModule.updateJob).toHaveBeenCalledWith('job-1', { data: { strmPaused: false } });
    });

    test('returns 400 when there is no active STRM batch for the job', async () => {
      mockStrmMaterializer.resumeActiveJob.mockReturnValue(false);

      const res = await request(app).post('/api/jobs/job-1/strm/resume');

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/jobs/:jobId/strm/videos', () => {
    test('updates the remaining queue and mirrors processed+remaining onto the job record', async () => {
      const res = await request(app)
        .patch('/api/jobs/job-1/strm/videos')
        .send({ urls: ['https://youtu.be/a'] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockStrmMaterializer.setActiveJobRemainingUrls).toHaveBeenCalledWith('job-1', ['https://youtu.be/a']);
      expect(mockJobModule.updateJob).toHaveBeenCalledWith('job-1', {
        data: { urls: ['https://youtu.be/z', 'https://youtu.be/a'] },
      });
      expect(mockJobModule.emitJobsUpdated).toHaveBeenCalledWith('job-1', 'VideosUpdated');
    });

    test('returns 400 when the batch rejects the update', async () => {
      mockStrmMaterializer.setActiveJobRemainingUrls.mockReturnValue({ success: false, error: 'nope' });

      const res = await request(app)
        .patch('/api/jobs/job-1/strm/videos')
        .send({ urls: ['https://youtu.be/a'] });

      expect(res.status).toBe(400);
      expect(mockJobModule.updateJob).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/jobs/:jobId', () => {
    test('removes a pending job', async () => {
      const res = await request(app).delete('/api/jobs/job-a');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockJobModule.removePendingJob).toHaveBeenCalledWith('job-a');
    });

    test('returns 400 when the job cannot be removed', async () => {
      mockJobModule.removePendingJob.mockResolvedValue({ success: false, error: 'Only pending (not yet started) jobs can be removed from the queue' });

      const res = await request(app).delete('/api/jobs/job-a');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });
});
