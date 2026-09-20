/* eslint-env jest */

const express = require('express');
const request = require('supertest');

jest.mock('../../logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

const logger = require('../../logger');
const createMaintenanceRoutes = require('../maintenance');

describe('Maintenance routes: every endpoint outcome', () => {
  let app;
  let videosModule;
  let configModule;
  let jobModule;
  let cronJobs;
  let verifyToken;

  beforeEach(() => {
    jest.clearAllMocks();
    videosModule = {
      tryStartBackfill: jest.fn(),
      isBackfillRunning: jest.fn().mockReturnValue(false),
      tryStartResolutionTagBackfill: jest.fn(),
      isResolutionTagBackfillRunning: jest.fn().mockReturnValue(false),
      tryStartImageRegen: jest.fn(),
      isImageRegenRunning: jest.fn().mockReturnValue(false),
      tryStartMetadataRegen: jest.fn(),
      isMetadataRegenRunning: jest.fn().mockReturnValue(false),
    };
    configModule = { getConfig: jest.fn().mockReturnValue({}) };
    jobModule = {
      previewCompactHistory: jest.fn().mockReturnValue({}),
      compactHistory: jest.fn().mockResolvedValue({ success: true }),
    };
    cronJobs = { getTasks: jest.fn().mockReturnValue([]), runTaskNow: jest.fn() };
    verifyToken = jest.fn((req, res, next) => next());

    app = express();
    app.use(express.json());
    app.use(createMaintenanceRoutes({ verifyToken, videosModule, configModule, jobModule, cronJobs }));
  });

  // [label, path, start fn, running fn, config key, 409 message, 500 start message, 500 status message]
  const jobs = [
    ['rescan', '/api/maintenance/rescan-files', 'tryStartBackfill', '/api/maintenance/rescan-status', 'isBackfillRunning', 'rescanLastRun', 'Rescan already in progress', 'Failed to start rescan', 'Failed to read rescan status'],
    ['resolution tag backfill', '/api/maintenance/backfill-resolution-tags', 'tryStartResolutionTagBackfill', '/api/maintenance/backfill-resolution-tags-status', 'isResolutionTagBackfillRunning', 'resolutionTagBackfillLastRun', 'Resolution tag backfill already in progress', 'Failed to start resolution tag backfill', 'Failed to read resolution tag backfill status'],
    ['channel image regeneration', '/api/maintenance/regenerate-channel-images', 'tryStartImageRegen', '/api/maintenance/regenerate-channel-images-status', 'isImageRegenRunning', 'channelImageRegenLastRun', 'Channel image regeneration already in progress', 'Failed to start channel image regeneration', 'Failed to read channel image regeneration status'],
    ['metadata regeneration', '/api/maintenance/regenerate-metadata', 'tryStartMetadataRegen', '/api/maintenance/regenerate-metadata-status', 'isMetadataRegenRunning', 'metadataRegenLastRun', 'Metadata regeneration already in progress', 'Failed to start metadata regeneration', 'Failed to read metadata regeneration status'],
  ];

  describe.each(jobs)('%s', (_label, startPath, startFn, statusPath, runningFn, configKey, conflictMessage, startFailure, statusFailure) => {
    it('starts and answers 202', async () => {
      videosModule[startFn].mockReturnValue({ started: true });

      const res = await request(app).post(startPath);

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'started', trigger: 'manual' });
      expect(videosModule[startFn]).toHaveBeenCalledWith({ trigger: 'manual' });
    });

    it('answers 409 when already running', async () => {
      videosModule[startFn].mockReturnValue({ started: false });

      const res = await request(app).post(startPath);

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: conflictMessage });
    });

    it('answers 500 and logs when starting throws', async () => {
      videosModule[startFn].mockImplementation(() => { throw new Error('boom'); });

      const res = await request(app).post(startPath);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: startFailure });
      expect(logger.error).toHaveBeenCalled();
    });

    it('requires authentication to start', async () => {
      verifyToken.mockImplementation((req, res) => res.status(401).json({ error: 'nope' }));
      videosModule[startFn].mockReturnValue({ started: true });

      const res = await request(app).post(startPath);

      expect(res.status).toBe(401);
      expect(videosModule[startFn]).not.toHaveBeenCalled();
    });

    it('reports it is idle with no previous run', async () => {
      const res = await request(app).get(statusPath);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ running: false, lastRun: null });
    });

    it('reports the running state and last run', async () => {
      videosModule[runningFn].mockReturnValue(true);
      configModule.getConfig.mockReturnValue({ [configKey]: { finishedAt: 'yesterday' } });

      const res = await request(app).get(statusPath);

      expect(res.body).toEqual({ running: true, lastRun: { finishedAt: 'yesterday' } });
    });

    it('answers 500 and logs when reading the status throws', async () => {
      videosModule[runningFn].mockImplementation(() => { throw new Error('boom'); });

      const res = await request(app).get(statusPath);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: statusFailure });
      expect(logger.error).toHaveBeenCalled();
    });

    it('answers 500 when reading the config throws', async () => {
      configModule.getConfig.mockImplementation(() => { throw new Error('boom'); });

      const res = await request(app).get(statusPath);

      expect(res.status).toBe(500);
    });

    it('requires authentication for the status', async () => {
      verifyToken.mockImplementation((req, res) => res.status(401).json({ error: 'nope' }));

      const res = await request(app).get(statusPath);

      expect(res.status).toBe(401);
    });
  });

  describe('compact history', () => {
    it('answers 500 with the failure payload when compaction reports failure', async () => {
      jobModule.compactHistory.mockResolvedValue({ success: false, error: 'disk full' });

      const res = await request(app).post('/api/maintenance/compact-history');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ success: false, error: 'disk full' });
    });

    it('answers 500 and logs when compaction throws', async () => {
      jobModule.compactHistory.mockRejectedValue(new Error('boom'));

      const res = await request(app).post('/api/maintenance/compact-history');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to compact job history' });
      expect(logger.error).toHaveBeenCalled();
    });

    it('answers 500 and logs when the preview throws', async () => {
      jobModule.previewCompactHistory.mockImplementation(() => { throw new Error('boom'); });

      const res = await request(app).get('/api/maintenance/compact-history-preview');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to preview history compaction' });
    });
  });

  describe('scheduled tasks', () => {
    it('answers 500 and logs when listing throws', async () => {
      cronJobs.getTasks.mockImplementation(() => { throw new Error('boom'); });

      const res = await request(app).get('/api/maintenance/tasks');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to list scheduled tasks' });
      expect(logger.error).toHaveBeenCalled();
    });

    it('answers 500 and logs when running a task throws', async () => {
      cronJobs.runTaskNow.mockImplementation(() => { throw new Error('boom'); });

      const res = await request(app).post('/api/maintenance/tasks/nightly/run');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to start task' });
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'nightly' }), expect.any(String));
    });

    it('passes the task id from the url', async () => {
      cronJobs.runTaskNow.mockReturnValue({ started: true });

      await request(app).post('/api/maintenance/tasks/cleanup-old-jobs/run');

      expect(cronJobs.runTaskNow).toHaveBeenCalledWith('cleanup-old-jobs');
    });

    it('requires authentication', async () => {
      verifyToken.mockImplementation((req, res) => res.status(401).json({ error: 'nope' }));

      const res = await request(app).get('/api/maintenance/tasks');

      expect(res.status).toBe(401);
    });
  });
});
