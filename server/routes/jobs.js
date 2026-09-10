const express = require('express');
const router = express.Router();
const strmMaterializer = require('../modules/strmMaterializer');
const nzbRoutes = require('./nzb');

/**
 * Creates job routes
 * @param {Object} deps - Dependencies
 * @param {Function} deps.verifyToken - Token verification middleware
 * @param {Object} deps.jobModule - Job module
 * @param {Object} deps.downloadModule - Download module
 * @returns {express.Router}
 */
module.exports = function createJobRoutes({ verifyToken, jobModule, downloadModule }) {
  /**
   * @swagger
   * /jobstatus/{jobId}:
   *   get:
   *     summary: Get job status
   *     description: Retrieve the status of a specific download job.
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: jobId
   *         required: true
   *         schema:
   *           type: string
   *         description: Job ID
   *     responses:
   *       200:
   *         description: Job status
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 jobId:
   *                   type: string
   *                 jobType:
   *                   type: string
   *                 status:
   *                   type: string
   *                 progress:
   *                   type: number
   *       404:
   *         description: Job not found
   */
  router.get('/jobstatus/:jobId', verifyToken, (req, res) => {
    const jobId = req.params.jobId;
    const job = jobModule.getJob(jobId);

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
    } else {
      res.json(job);
    }
  });

  /**
   * @swagger
   * /runningjobs:
   *   get:
   *     summary: Get running jobs
   *     description: Retrieve a list of currently running download jobs.
   *     tags: [Jobs]
   *     responses:
   *       200:
   *         description: List of running jobs
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   jobId:
   *                     type: string
   *                   jobType:
   *                     type: string
   *                   status:
   *                     type: string
   *                   progress:
   *                     type: number
   */
  router.get('/runningjobs', verifyToken, async (req, res) => {
    try {
      const runningJobs = await jobModule.getRunningJobsWithFreshVideos();
      // NZB-originated jobs (server/routes/nzb.js) get an extra display-only
      // job.data.nzb.statusDetail computed fresh on every request - it can
      // change between polls (e.g. Sonarr/Radarr importing) independent of
      // this job ever being updated/saved, so it's never cached on the job
      // itself. Returns a new object rather than mutating runningJobs'
      // entries in place, since those are live references into jobModule's
      // own in-memory job cache.
      const enrichedJobs = await Promise.all(runningJobs.map(async (job) => {
        if (!job.data?.nzb) return job;
        const statusDetail = await nzbRoutes.computeNzbStatusDetail(job);
        if (!statusDetail) return job;
        return { ...job, data: { ...job.data, nzb: { ...job.data.nzb, statusDetail } } };
      }));
      res.json(enrichedJobs);
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get running jobs');
      res.status(500).json({ error: 'Failed to get running jobs' });
    }
  });

  /**
   * @swagger
   * /api/jobs/current-activity:
   *   get:
   *     summary: Get current download activity
   *     description: >
   *       Snapshot of the current (or most recent) download run for the
   *       activity page. Combines the live progress monitor state with the
   *       last stored final-state message so a freshly-opened page can render
   *       immediately without waiting for a WebSocket broadcast.
   *     tags: [Jobs]
   *     responses:
   *       200:
   *         description: Current activity snapshot
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 jobId:
   *                   type: string
   *                   nullable: true
   *                 capturedAt:
   *                   type: number
   *                   nullable: true
   *                   description: Epoch ms of the monitor's last activity
   *                 terminal:
   *                   type: boolean
   *                   description: True when yt-dlp is not currently running
   *                 activity:
   *                   type: object
   *                   nullable: true
   *                   description: Structured progress payload (same shape as downloadProgress broadcasts)
   *                 lastFinalActivity:
   *                   type: object
   *                   nullable: true
   *                   description: Last stored final-state downloadProgress payload, if any
   *       500:
   *         description: Failed to get current download activity
   */
  router.get('/api/jobs/current-activity', verifyToken, (req, res) => {
    try {
      res.json(downloadModule.getCurrentActivitySnapshot());
    } catch (error) {
      req.log.error({ err: error }, 'Failed to get current download activity');
      res.status(500).json({ error: 'Failed to get current download activity' });
    }
  });

  /**
   * @swagger
   * /api/jobs/terminate:
   *   post:
   *     summary: Terminate current job
   *     description: Terminate the currently running download job.
   *     tags: [Jobs]
   *     responses:
   *       200:
   *         description: Job termination initiated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 jobId:
   *                   type: string
   *                 message:
   *                   type: string
   *       400:
   *         description: No job is currently running
   *       500:
   *         description: Failed to terminate job
   */
  router.post('/api/jobs/terminate', verifyToken, (req, res) => {
    const inProgressJobId = jobModule.getInProgressJobId();

    if (!inProgressJobId) {
      return res.status(400).json({
        error: 'No job is currently running',
        success: false
      });
    }

    const terminatedJobId = downloadModule.terminateCurrentDownload();

    if (terminatedJobId) {
      res.json({
        success: true,
        jobId: terminatedJobId,
        message: 'Download termination initiated'
      });
    } else {
      res.status(500).json({
        error: 'Failed to terminate job',
        success: false
      });
    }
  });

  /**
   * @swagger
   * /api/jobs/queue-state:
   *   get:
   *     summary: Get queue processing pause state
   *     description: Whether the job queue is currently paused from auto-starting the next pending job.
   *     tags: [Jobs]
   *     responses:
   *       200:
   *         description: Queue state
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 paused:
   *                   type: boolean
   */
  router.get('/api/jobs/queue-state', verifyToken, (req, res) => {
    res.json({ paused: jobModule.isQueueProcessingPaused() });
  });

  /**
   * @swagger
   * /api/jobs/queue/pause:
   *   post:
   *     summary: Pause queue processing
   *     description: Stops the system from auto-starting the next pending job. The currently running job (if any) is unaffected.
   *     tags: [Jobs]
   *     responses:
   *       200:
   *         description: Queue paused
   */
  router.post('/api/jobs/queue/pause', verifyToken, (req, res) => {
    jobModule.pauseQueueProcessing();
    res.json({ success: true, paused: true });
  });

  /**
   * @swagger
   * /api/jobs/queue/resume:
   *   post:
   *     summary: Resume queue processing
   *     description: Resumes auto-starting pending jobs, and immediately starts the next one if none is running.
   *     tags: [Jobs]
   *     responses:
   *       200:
   *         description: Queue resumed
   */
  router.post('/api/jobs/queue/resume', verifyToken, (req, res) => {
    jobModule.resumeQueueProcessing();
    res.json({ success: true, paused: false });
  });

  /**
   * @swagger
   * /api/jobs/queue/reorder:
   *   patch:
   *     summary: Reorder pending jobs
   *     description: Reassigns queue order for pending jobs to match the given id order.
   *     tags: [Jobs]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               orderedIds:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Queue reordered
   *       400:
   *         description: orderedIds must be an array
   */
  router.patch('/api/jobs/queue/reorder', verifyToken, async (req, res) => {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds)) {
      return res.status(400).json({ error: 'orderedIds must be an array', success: false });
    }
    await jobModule.reorderPendingJobs(orderedIds);
    res.json({ success: true });
  });

  /**
   * @swagger
   * /api/jobs/{jobId}/videos:
   *   patch:
   *     summary: Edit the video URL list on a pending job
   *     description: Replaces the URL list on a job that has not started yet - used to remove or reorder individual videos inside a queued multi-video job.
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: jobId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               urls:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Video list updated
   *       400:
   *         description: Job not found, not pending, or urls invalid
   */
  router.patch('/api/jobs/:jobId/videos', verifyToken, async (req, res) => {
    const { urls } = req.body;
    const result = await jobModule.updateJobVideoUrls(req.params.jobId, urls);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  /**
   * @swagger
   * /api/jobs/{jobId}/strm/pause:
   *   post:
   *     summary: Pause the active STRM materialize batch for this job
   *     description: >
   *       STRM materialize fetches metadata one video at a time (a single yt-dlp call per video, not one call for the whole batch like a real download), so unlike a normal download it can be paused between videos. Takes effect after the video currently in flight finishes.
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: jobId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Batch paused
   *       400:
   *         description: No active STRM batch for this job
   */
  router.post('/api/jobs/:jobId/strm/pause', verifyToken, async (req, res) => {
    const jobId = req.params.jobId;
    if (!strmMaterializer.pauseActiveJob(jobId)) {
      return res.status(400).json({ success: false, error: 'No active STRM batch for this job' });
    }
    await jobModule.updateJob(jobId, { data: { strmPaused: true } });
    jobModule.emitJobsUpdated(jobId, 'StrmPaused');
    res.json({ success: true, paused: true });
  });

  /**
   * @swagger
   * /api/jobs/{jobId}/strm/resume:
   *   post:
   *     summary: Resume the active STRM materialize batch for this job
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: jobId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Batch resumed
   *       400:
   *         description: No active STRM batch for this job
   */
  router.post('/api/jobs/:jobId/strm/resume', verifyToken, async (req, res) => {
    const jobId = req.params.jobId;
    if (!strmMaterializer.resumeActiveJob(jobId)) {
      return res.status(400).json({ success: false, error: 'No active STRM batch for this job' });
    }
    await jobModule.updateJob(jobId, { data: { strmPaused: false } });
    jobModule.emitJobsUpdated(jobId, 'StrmResumed');
    res.json({ success: true, paused: false });
  });

  /**
   * @swagger
   * /api/jobs/{jobId}/strm/videos:
   *   patch:
   *     summary: Reorder or remove videos not yet processed by the active STRM batch
   *     description: Replaces the not-yet-processed portion of the batch's queue - the same set of URLs, reordered, or a subset with some removed. Already-processed videos are untouched.
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: jobId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               urls:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Remaining queue updated
   *       400:
   *         description: No active STRM batch, or urls don't match the current remaining set
   */
  router.patch('/api/jobs/:jobId/strm/videos', verifyToken, async (req, res) => {
    const jobId = req.params.jobId;
    const { urls } = req.body;
    const result = strmMaterializer.setActiveJobRemainingUrls(jobId, urls);
    if (!result.success) {
      return res.status(400).json(result);
    }
    const state = strmMaterializer.getActiveBatchState(jobId);
    if (state) {
      await jobModule.updateJob(jobId, { data: { urls: [...state.processedUrls, ...state.remainingUrls] } });
      jobModule.emitJobsUpdated(jobId, 'VideosUpdated');
    }
    res.json({ success: true });
  });

  /**
   * @swagger
   * /api/jobs/{jobId}:
   *   delete:
   *     summary: Remove a pending job from the queue
   *     description: Only jobs that have not started (status Pending) can be removed this way.
   *     tags: [Jobs]
   *     parameters:
   *       - in: path
   *         name: jobId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Job removed
   *       400:
   *         description: Job not found or not pending
   */
  router.delete('/api/jobs/:jobId', verifyToken, async (req, res) => {
    const result = await jobModule.removePendingJob(req.params.jobId);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  });

  return router;
};

