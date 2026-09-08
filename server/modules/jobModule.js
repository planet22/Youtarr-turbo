const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const Job = require('../models/job');
const Video = require('../models/video');
const JobVideo = require('../models/jobvideo');
const JobVideoDownload = require('../models/jobvideodownload');
const ChannelVideo = require('../models/channelvideo');
const videoPersistence = require('./videoPersistence');
const cron = require('node-cron');
const MessageEmitter = require('./messageEmitter.js'); // import the helper function
const configModule = require('./configModule');
const { isDownloadJob } = require('./download/jobTypes');
const downloadCleanup = require('./download/downloadCleanup');
const { serializeAuxData, parseAuxData } = require('./jobAuxData');
const logger = require('../logger');

// Scratch flag for ad-hoc verbose tracing (queue reorder/order investigation
// as of 2026-09-06) - flip via the DETAILED_DEBUG=true env var, no rebuild
// needed. Every log line it gates is tagged '[detailedDebug]' so `grep -r
// detailedDebug` finds every call site (including this flag itself) when
// it's time to rip the scaffold back out.
const DETAILED_DEBUG = process.env.DETAILED_DEBUG === 'true';

const MAX_SAVE_RETRIES = 3;
// Download History window: jobs older than this are purged from memory,
// and at most MAX_HISTORY_JOBS are returned to the client. DB rows are
// never deleted, so raising these resurfaces older persisted jobs.
const JOB_RETENTION_DAYS = 42;
const MAX_HISTORY_JOBS = 720;

class JobModule {
  constructor() {
    this.jobsDir = configModule.getJobsPath();
    this.jobsFilePath = path.join(this.jobsDir, 'jobs.json');
    this.jobsFilePathOld = path.join(this.jobsDir, 'jobs.json.old');
    this.isSaving = false; // Locking mechanism to prevent multiple saves at the same time
    this.jobs = {}; // Initialize this.jobs as an empty object
    // In-memory only, intentionally not persisted: a forgotten pause should
    // never survive a restart and silently stall downloads forever.
    this.queueProcessingPaused = false;

    if (!fs.existsSync(this.jobsDir)) {
      fs.mkdirSync(this.jobsDir, { recursive: true });
    }

    // If there is a jobs.json file, load it and migrate to the DB
    if (fs.existsSync(this.jobsFilePath)) {
      const fileContent = fs.readFileSync(this.jobsFilePath);
      this.jobs = JSON.parse(fileContent);

      this.migrateJobsFromFile().then(() => {
        // Save the jobs.json file to jobs.json.old just in case we need it later
        fs.renameSync(this.jobsFilePath, this.jobsFilePathOld);

        // Reload from the DB
        this.loadJobsFromDB().then(() => {
          this.terminateInProgressJobs();
          this.saveJobsAndStartNext();
        });
      });
    } else {
      // If there is no jobs.json file, load the jobs from the DB
      this.loadJobsFromDB().then(() => {
        this.terminateInProgressJobs();
        this.saveJobsAndStartNext();
      });
    }

    // Schedule a daily backfill from complete.list and run an initial backfill
    this.scheduleDailyBackfill();

    const disableInitialBackfill = process.env.JOBMODULE_DISABLE_INITIAL_BACKFILL === 'true';
    if (!disableInitialBackfill) {
      setTimeout(() => {
        this.backfillFromCompleteList().catch((err) => {
          logger.error({ err }, 'Initial backfill failed');
        });
      }, 0);
    }
  }

  /**
   * Recover completed videos from JobVideoDownload tracking table
   * Reads .info.json files and ensures videos are properly saved to DB
   * @param {string} jobId - The job ID to recover videos for
   * @returns {Promise<number>} Number of videos successfully recovered
   */
  async recoverCompletedVideos(jobId) {
    let recoveredCount = 0;

    try {
      // Find all completed video downloads for this job
      const completedDownloads = await JobVideoDownload.findAll({
        where: {
          job_id: jobId,
          status: 'completed'
        }
      });

      if (completedDownloads.length === 0) {
        logger.info({ jobId }, 'No completed videos to recover for job');
        return 0;
      }

      logger.info({ jobId, count: completedDownloads.length }, 'Found completed videos to recover for job');

      // Try to get the job instance for creating JobVideo relationships
      let jobInstance = await Job.findOne({ where: { id: jobId } });

      for (const download of completedDownloads) {
        try {
          const youtubeId = download.youtube_id;
          const infoJsonPath = path.join(this.jobsDir, 'info', `${youtubeId}.info.json`);

          // Check if .info.json file exists
          let infoExists = false;
          try {
            await fsPromises.access(infoJsonPath);
            infoExists = true;
          } catch (err) {
            logger.warn({ youtubeId }, 'Info file not found for video, skipping recovery');
            continue;
          }

          if (!infoExists) {
            continue;
          }

          // Read and parse the info.json file
          const infoContent = await fsPromises.readFile(infoJsonPath, 'utf-8');
          const info = JSON.parse(infoContent);

          // Build video data object from info.json
          const preferredChannelName = info.uploader || info.channel || info.uploader_id || info.channel_id || 'Unknown Channel';

          const videoData = {
            youtubeId: info.id,
            youTubeChannelName: preferredChannelName,
            youTubeVideoName: info.title,
            duration: info.duration,
            description: info.description,
            originalDate: info.upload_date,
            channel_id: info.channel_id,
            media_type: info.media_type || 'video',
            content_rating: info.content_rating || null,
            age_limit: info.age_limit ?? null,
            normalized_rating: info.normalized_rating || null,
            rating_source: info.rating_source || null,
          };

          // Determine candidate file paths, preferring yt-dlp's recorded actual location
          const candidatePaths = [];
          const pushCandidate = (candidatePath) => {
            if (candidatePath && !candidatePaths.includes(candidatePath)) {
              candidatePaths.push(candidatePath);
            }
          };

          const actualFilePath = info._actual_filepath ? path.normalize(info._actual_filepath) : null;
          pushCandidate(actualFilePath);

          // If post-processing updated the tracking record with an exact path, use it
          if (!actualFilePath && download.file_path && path.extname(download.file_path)) {
            pushCandidate(path.normalize(download.file_path));
          }

          const fallbackBasePath = path.join(
            configModule.directoryPath,
            preferredChannelName,
            `${preferredChannelName} - ${info.title} - ${info.id}`,
            `${preferredChannelName} - ${info.title}  [${info.id}]`
          );

          const fallbackExtensions = ['.mp4', '.webm', '.mkv', '.m4v', '.avi'];
          for (const ext of fallbackExtensions) {
            pushCandidate(`${fallbackBasePath}${ext}`);
          }

          // Check candidates until we find an existing file
          let resolvedPath = null;
          let resolvedStats = null;
          for (const candidate of candidatePaths) {
            try {
              const stats = await fsPromises.stat(candidate);
              resolvedPath = candidate;
              resolvedStats = stats;
              break;
            } catch (err) {
              // Try next candidate
            }
          }

          if (resolvedPath) {
            videoData.filePath = resolvedPath;
            videoData.fileSize = resolvedStats?.size !== undefined ? resolvedStats.size.toString() : null;
            videoData.removed = false;
          } else {
            // File not found, but we still want to record the expected metadata location
            const assumedPath = actualFilePath || `${fallbackBasePath}.mp4`;
            videoData.filePath = assumedPath;
            videoData.fileSize = null;
            videoData.removed = false;
          }

          // Upsert video into Videos table and ensure JobVideo relationship exists
          // Note: Video and ChannelVideo were already created during normal download processing
          // We just need to ensure the JobVideo relationship exists for this terminated job
          await this.upsertVideoForJob(videoData, jobInstance, true);

          recoveredCount++;
          logger.info({ youtubeId, title: info.title }, 'Recovered video');
        } catch (err) {
          logger.error({ err, youtubeId: download.youtube_id }, 'Error recovering video');
        }
      }

      logger.info({ jobId, recoveredCount }, 'Successfully recovered videos for job');
      return recoveredCount;
    } catch (err) {
      logger.error({ err, jobId }, 'Error in recoverCompletedVideos for job');
      return recoveredCount;
    }
  }

  async terminateInProgressJobs() {
    // Change the status of "In Progress" jobs to "Terminated" and recover/cleanup videos
    for (let jobId in this.jobs) {
      if (this.jobs[jobId].status === 'In Progress') {
        logger.info({ jobId }, 'Recovering job after server restart');

        let recoveredCount = 0;
        let outputMessage = 'Job terminated due to server restart';

        try {
          // Step 1: Recover completed videos from JobVideoDownload table
          recoveredCount = await this.recoverCompletedVideos(jobId);

          // Step 2: Clean up in-progress videos from disk
          try {
            await downloadCleanup.cleanupInProgressVideos(jobId);
          } catch (cleanupErr) {
            logger.error({ err: cleanupErr, jobId }, 'Error cleaning up in-progress videos for job');
          }

          // Step 3: Set appropriate output message
          if (recoveredCount > 0) {
            outputMessage = `${recoveredCount} video${recoveredCount === 1 ? '' : 's'} completed (recovered after server restart)`;
          }

          // Step 4: Clean up all JobVideoDownload entries for this job
          try {
            const deletedCount = await JobVideoDownload.destroy({
              where: { job_id: jobId }
            });
            if (deletedCount > 0) {
              logger.info({ jobId, deletedCount }, 'Cleaned up JobVideoDownload tracking entries for job');
            }
          } catch (deleteErr) {
            logger.error({ err: deleteErr, jobId }, 'Error deleting JobVideoDownload entries for job');
          }
        } catch (err) {
          logger.error({ err, jobId }, 'Error during recovery for job');
          outputMessage = `Job terminated with errors: ${err.message}`;
        }

        // Step 5: Reload job videos from database into in-memory structure
        // This ensures Download History shows the correct count
        try {
          const jobVideos = await JobVideo.findAll({
            where: { job_id: jobId }
          });

          const videos = [];
          for (const jobVideo of jobVideos) {
            const video = await Video.findOne({ where: { id: jobVideo.video_id } });
            if (video) {
              videos.push(video.dataValues);
            }
          }

          if (!this.jobs[jobId].data) {
            this.jobs[jobId].data = {};
          }
          this.jobs[jobId].data.videos = videos;

          logger.info({ jobId, videoCount: videos.length }, 'Loaded videos into in-memory structure for job');
        } catch (loadErr) {
          logger.error({ err: loadErr, jobId }, 'Error loading videos into memory for job');
        }

        // Step 6: Update job status and output
        this.jobs[jobId].status = 'Terminated';
        this.jobs[jobId].output = outputMessage;

        try {
          await Job.update(
            {
              status: 'Terminated',
              output: outputMessage
            },
            { where: { id: jobId } }
          );
          logger.info({ jobId, outputMessage }, 'Job marked as Terminated');
        } catch (err) {
          logger.error({ err, jobId }, 'Failed to update job in database');
        }
      }
    }

    // Terminate all Pending jobs (they can't be safely resumed after restart)
    for (let jobId in this.jobs) {
      if (this.jobs[jobId].status === 'Pending') {
        logger.warn({ jobId, jobType: this.jobs[jobId].jobType },
          'Terminating pending job - jobs cannot be resumed after server restart');

        this.jobs[jobId].status = 'Terminated';
        this.jobs[jobId].output = 'Job terminated during server restart';

        try {
          await Job.update(
            {
              status: 'Terminated',
              output: 'Job terminated during server restart'
            },
            { where: { id: jobId } }
          );
          logger.info({ jobId }, 'Pending job marked as Terminated');
        } catch (err) {
          logger.error({ err, jobId }, 'Failed to update pending job in database');
        }
      }
    }
  }

  async saveJobsAndStartNext() {
    // Just start the next job - no need to save anything on startup
    await this.startNextJob();
  }

  async loadJobsFromDB() {
    try {
      const jobs = await Job.findAll();
      const jobVideos = await JobVideo.findAll();

      this.jobs = {};

      for (let job of jobs) {
        const { aux_data: auxData, ...row } = job.dataValues;
        this.jobs[job.id] = {
          ...row,
          data: {
            ...parseAuxData(auxData),
            videos: [],
          },
          // Don't restore action functions - pending jobs will be terminated on startup
          // since they can't be safely resumed (missing urls, etc.)
        };
      }

      for (let jobVideo of jobVideos) {
        const video = await Video.findOne({ where: { id: jobVideo.video_id } });
        if (video && this.jobs[jobVideo.job_id]) {
          this.jobs[jobVideo.job_id].data.videos.push(video.dataValues);
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error loading jobs from DB');
    }
  }

  async migrateJobsFromFile() {
    for (let jobId in this.jobs) {
      const jobData = this.jobs[jobId];
      if (!jobData.data) {
        continue;
      }
      const videos = jobData.data.videos ? jobData.data.videos : [];
      delete jobData.data; // Remove videos from job data

      // Convert timestamps to Date objects
      jobData.timeInitiated = new Date(jobData.timeInitiated);
      jobData.timeCreated = new Date(jobData.timeCreated);

      try {
        const jobInstance = await Job.create(jobData); // Create job entry

        // Create video entries and jobVideo relationships
        for (let video of videos) {
          let videoInstance;
          try {
            videoInstance = await Video.create(video); // Create video entry
          } catch (error) {
            logger.error({ err: error }, 'Error migrating video');
          }

          // Create jobVideo relationship
          try {
            await JobVideo.create({
              job_id: jobInstance.id,
              video_id: videoInstance.id,
            });
          } catch (error) {
            logger.error({ err: error }, 'Error migrating jobVideo');
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'Error migrating job');
      }
    }
  }

  // FIFO position for a Pending job: manual reorders (reorderPendingJobs)
  // set data.queueOrder; jobs never reordered fall back to creation time, so
  // they sort oldest-first. Shared by startNextJob (what runs next) and
  // getRunningJobs (what the client displays as queued) - they must agree,
  // or the queue's on-screen order stops matching real run order.
  pendingJobOrder(job) {
    return job.data?.queueOrder ?? job.timeCreated;
  }

  getInProgressJobId() {
    for (let id in this.jobs) {
      if (this.jobs[id].status === 'In Progress') {
        return id;
      }
    }
    return null;
  }

  async startNextJob() {
    if (this.queueProcessingPaused) {
      logger.info('Queue processing paused; not starting next job');
      return;
    }

    // A caller (notably resumeQueueProcessing, which always calls this after
    // unpausing) can race a job that's still actively running - without this
    // guard, addOrUpdateJob's isNextJob branch silently no-ops (logs a
    // warning, never assigns jobId) and the caller crashes dereferencing an
    // undefined job id.
    if (this.getInProgressJobId()) {
      logger.info('A job is already in progress; not starting another');
      return;
    }

    logger.info('Looking for next job to start');
    const jobs = this.getAllJobs();
    const pendingIds = Object.keys(jobs)
      .filter((id) => jobs[id].status === 'Pending')
      .sort((a, b) => this.pendingJobOrder(jobs[a]) - this.pendingJobOrder(jobs[b]));

    if (pendingIds.length === 0) {
      return;
    }

    const id = pendingIds[0];
    jobs[id].id = id;
    if (jobs[id].action) {
      // Fire-and-forget: nothing here awaits the job's action, so an
      // uncaught rejection would otherwise become an unhandled promise
      // rejection - fatal by default on Node 15+, crashing the whole
      // process (and every other in-progress/queued job with it) over a
      // single bad job. Log and move on instead.
      Promise.resolve(jobs[id].action(jobs[id], true)).catch((err) => {
        logger.error({ err, jobId: id, jobType: jobs[id].jobType }, 'Job action threw while starting next job');
      });
    } else {
      // Job is missing its action function (likely loaded from DB after restart)
      logger.warn({ jobId: id, jobType: jobs[id].jobType },
        'Cannot start pending job - missing action function, marking as Terminated');

      await this.updateJob(id, {
        status: 'Terminated',
        output: 'Job could not be started after server restart',
      });

      // Try to start the next pending job
      this.startNextJob();
    }
  }

  pauseQueueProcessing() {
    this.queueProcessingPaused = true;
    this.emitQueuePauseChanged();
    this.pauseActiveStrmBatchIfAny();
  }

  resumeQueueProcessing() {
    this.queueProcessingPaused = false;
    this.emitQueuePauseChanged();
    this.resumeActiveStrmBatchIfAny();
    this.startNextJob().catch((err) => {
      logger.error({ err }, 'Failed to start next job after resuming queue processing');
    });
  }

  // "Pause Queue" implies nothing moves forward, including the job
  // currently running - if that job is a STRM batch (metadata-only, one
  // yt-dlp call per video, so genuinely pausable between videos - see
  // strmMaterializer.js), pause its loop too rather than only blocking the
  // *next* job from starting while this one keeps running to completion.
  pauseActiveStrmBatchIfAny() {
    const inProgressJobId = this.getInProgressJobId();
    const job = inProgressJobId && this.jobs[inProgressJobId];
    if (!job || !job.data?.isStrmBatch) return;

    const strmMaterializer = require('./strmMaterializer');
    if (strmMaterializer.pauseActiveJob(inProgressJobId)) {
      job.data.strmPaused = true;
      this.emitJobsUpdated(inProgressJobId, 'StrmPaused');
    }
  }

  // Mirrors pauseActiveStrmBatchIfAny so "Resume Queue" undoes what
  // "Pause Queue" itself paused.
  resumeActiveStrmBatchIfAny() {
    const inProgressJobId = this.getInProgressJobId();
    const job = inProgressJobId && this.jobs[inProgressJobId];
    if (!job || !job.data?.isStrmBatch || !job.data.strmPaused) return;

    const strmMaterializer = require('./strmMaterializer');
    if (strmMaterializer.resumeActiveJob(inProgressJobId)) {
      job.data.strmPaused = false;
      this.emitJobsUpdated(inProgressJobId, 'StrmResumed');
    }
  }

  isQueueProcessingPaused() {
    return this.queueProcessingPaused;
  }

  emitQueuePauseChanged() {
    MessageEmitter.emitMessage('broadcast', null, 'download', 'queuePauseChanged', {
      paused: this.queueProcessingPaused,
    });
  }

  // Reassigns queueOrder for Pending jobs to match the given id order.
  // Ids that no longer exist or already started are silently skipped -
  // guards against a client reordering a stale snapshot of the queue.
  async reorderPendingJobs(orderedIds) {
    if (DETAILED_DEBUG) logger.info({ orderedIds }, '[detailedDebug] reorderPendingJobs called');
    for (let index = 0; index < orderedIds.length; index++) {
      const id = orderedIds[index];
      const job = this.jobs[id];
      if (!job || job.status !== 'Pending') {
        if (DETAILED_DEBUG) {
          logger.info(
            { id, index, exists: !!job, status: job?.status },
            '[detailedDebug] reorderPendingJobs skipping id (not found or not Pending)'
          );
        }
        continue;
      }
      await this.updateJob(id, { data: { queueOrder: index } });
      if (DETAILED_DEBUG) {
        logger.info({ id, index, queueOrder: this.jobs[id].data?.queueOrder }, '[detailedDebug] reorderPendingJobs set queueOrder');
      }
    }
    this.emitJobsUpdated(null, 'QueueReordered');
  }

  // Replaces the video URL list on a queued (never-started) job - lets the
  // queue manager UI remove/reorder individual videos inside a still-pending
  // multi-video job before it runs. Not supported once a job is In Progress:
  // a normal (non-STRM) download hands its whole URL list to one yt-dlp
  // subprocess call, which Node has no way to interrupt or edit mid-run.
  async updateJobVideoUrls(jobId, urls) {
    const job = this.jobs[jobId];
    if (!job) {
      return { success: false, error: 'Job not found' };
    }
    if (job.status !== 'Pending') {
      return { success: false, error: 'Only pending (not yet started) jobs can have their video list edited' };
    }
    if (!Array.isArray(urls) || urls.length === 0) {
      return { success: false, error: 'urls must be a non-empty array' };
    }

    await this.updateJob(jobId, { data: { urls } });
    this.emitJobsUpdated(jobId, 'VideosUpdated');
    return { success: true };
  }

  // Removes a queued (never-started) job entirely - an in-progress job is
  // cancelled via terminateCurrentDownload/the Stop Job button instead.
  async removePendingJob(jobId) {
    const job = this.jobs[jobId];
    if (!job) {
      return { success: false, error: 'Job not found' };
    }
    if (job.status !== 'Pending') {
      return { success: false, error: 'Only pending (not yet started) jobs can be removed from the queue' };
    }

    try {
      await JobVideo.destroy({ where: { job_id: jobId } });
      await Job.destroy({ where: { id: jobId } });
    } catch (error) {
      logger.error({ err: error, jobId }, 'Failed to remove pending job');
      return { success: false, error: error.message };
    }

    delete this.jobs[jobId];
    this.emitJobsUpdated(jobId, 'Removed');
    return { success: true };
  }

  async addOrUpdateJob(jobData, isNextJob = false) {
    let jobId;
    const inProgressJobId = this.getInProgressJobId();
    if (!isNextJob) {
      if (inProgressJobId) {
        // If there is a job in progress, create a new job with status Pending
        logger.info({ jobType: jobData.jobType }, 'A job is already in progress. Adding job to the queue');
        jobData.status = 'Pending';
        jobId = await this.addJob(jobData);
      } else if (this.queueProcessingPaused) {
        // Nothing is running, but the queue is paused: queue this job as
        // Pending instead of starting it immediately - otherwise a fresh job
        // submission (e.g. clicking Download All again) would bypass the
        // pause entirely, since startNextJob() is the only other place that
        // checks queueProcessingPaused and this path never calls it.
        logger.info({ jobType: jobData.jobType }, 'Queue processing paused; adding job to the queue instead of starting it');
        jobData.status = 'Pending';
        jobId = await this.addJob(jobData);
      } else {
        // Otherwise, add a job with status In Progress
        logger.info({ jobType: jobData.jobType }, 'Adding job to jobs list as In Progress');
        jobData.status = 'In Progress';
        jobId = await this.addJob(jobData);
      }
    } else if (isNextJob && !inProgressJobId) {
      // If this is a next job and there's no job in progress, update its status to In Progress
      logger.info('This is a "next job", flipping from Pending to In Progress');
      await this.updateJob(jobData.id, {
        status: 'In Progress',
        timeInitiated: Date.now(),
      });
      jobId = jobData.id;
      this.emitJobsUpdated(jobId, 'In Progress');
    } else {
      logger.warn('Cannot start next job as a job is already in progress');
    }
    return jobId;
  }

  /**
   * Prepares video data for database save, setting last_downloaded_at if file is verified
   */
  prepareVideoDataForSave(video, isNewVideo = false) {
    return videoPersistence.prepareVideoDataForSave(video, isNewVideo);
  }

  /**
   * Upserts a video and creates JobVideo relationship
   * @param {Object} video - Video data
   * @param {Object} jobInstance - Job instance
   * @param {boolean} alwaysCreateJobVideo - Always create JobVideo relationship even if video exists (for recovery)
   */
  async upsertVideoForJob(video, jobInstance, alwaysCreateJobVideo = false) {
    return videoPersistence.upsertVideoForJob(video, jobInstance, alwaysCreateJobVideo);
  }

  // Save a single job and its video data to the database
  async saveJobOnly(jobId, jobDataOriginal) {
    const jobData = { ...jobDataOriginal };

    // Extract video data if present (download jobs); non-download jobs may not have data
    let videos = [];
    jobData.aux_data = serializeAuxData(jobData.data);
    if (jobData.data) {
      videos = jobData.data.videos ? jobData.data.videos : [];
      delete jobData.data; // Remove videos from job data before DB update
    }

    try {
      // Update the job in the database
      let jobInstance = await Job.findOne({ where: { id: jobId } });
      if (jobInstance) {
        await jobInstance.update(jobData);
      } else {
        jobInstance = await Job.create(jobData);
      }

      // Process videos for this job only (download jobs)
      for (let video of videos) {
        await this.upsertVideoForJob(video, jobInstance);

        // Upsert into channelvideos
        try {
          await this.upsertChannelVideoFromInfo({
            id: video.youtubeId,
            title: video.youTubeVideoName,
            duration: video.duration,
            upload_date: video.originalDate,
            channel_id: video.channel_id,
            media_type: video.media_type || 'video',
          });
        } catch (cvErr) {
          logger.error({ err: cvErr }, 'Error upserting channel video');
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error saving job');
    }
  }

  async saveJobs() {
    if (this.isSaving) {
      // If a save operation is already in progress, skip this one
      logger.debug('Save operation already in progress, skipping');
      return;
    }
    this.isSaving = true; // Set the locking variable
    logger.debug({ jobCount: Object.keys(this.jobs).length }, 'saveJobs() called - processing jobs');

    for (let jobId in this.jobs) {
      let jobDataOriginal = this.jobs[jobId];
      const jobData = { ...jobDataOriginal };

      // Extract video data if present (download jobs); non-download jobs may not have data
      let videos = [];
      jobData.aux_data = serializeAuxData(jobData.data);
      if (jobData.data) {
        videos = jobData.data.videos ? jobData.data.videos : [];
        logger.debug({ jobId, videoCount: videos.length }, 'Job has videos to save');
        delete jobData.data; // Remove videos from job data before DB update
      }

      try {
        // Find the job in the database.
        let jobInstance = await Job.findOne({ where: { id: jobId } });

        // If the job exists, update it. Otherwise, create it.
        if (jobInstance) {
          await jobInstance.update(jobData);
        } else {
          jobInstance = await Job.create(jobData);
        }

        // Skip updating video data for completed/terminated jobs to avoid overwriting fresher data
        // UNLESS the job is marked as needing save (e.g., after saveJobOnly failed)
        const isCompletedJob = jobData.status === 'Complete' ||
                               jobData.status === 'Complete with Warnings' ||
                               jobData.status === 'Error' ||
                               jobData.status === 'Terminated' ||
                               jobData.status === 'Killed';

        if (isCompletedJob && !jobDataOriginal._needsSave) {
          logger.debug({ jobId }, 'Skipping video updates for completed job');
          continue;
        }

        if (jobDataOriginal._needsSave) {
          logger.debug({ jobId, retryAttempt: jobDataOriginal._saveRetries || 1 }, 'Processing job due to previous save failure');
          // Don't clear flags yet - only clear after successful video processing
        }

        // For each video, find it in the database. If it exists, update it. Otherwise, create it.
        try {
          for (let video of videos) {
            logger.debug({ youtubeId: video.youtubeId, title: video.youTubeVideoName }, 'Processing video');
            await this.upsertVideoForJob(video, jobInstance);

            // Also upsert into channelvideos so Channel page reflects downloaded items
            try {
              await this.upsertChannelVideoFromInfo({
                id: video.youtubeId,
                title: video.youTubeVideoName,
                duration: video.duration,
                upload_date: video.originalDate,
                channel_id: video.channel_id,
                media_type: video.media_type || 'video',
              });
            } catch (cvErr) {
              logger.error({ err: cvErr }, 'Error upserting channel video');
            }
          }

          // Only clear retry flags if video processing succeeded
          if (jobDataOriginal._needsSave) {
            logger.debug({ jobId }, 'Successfully saved job on retry, clearing flags');
            delete jobDataOriginal._needsSave;
            delete jobDataOriginal._saveRetries;
          }
        } catch (error) {
          logger.error({ err: error, jobId }, 'Error saving videos for job');
          // Don't clear flags - let retry logic handle it
          if (jobDataOriginal._needsSave) {
            logger.error({ jobId }, 'Retry failed for job, flags preserved for next attempt');
          }
          throw error; // Re-throw to be caught by outer catch
        }
      } catch (error) {
        logger.error({ err: error }, 'Error saving job');
      }
    }
    this.isSaving = false; // Reset the locking variable when done
  }

  // Convert yt-dlp upload_date (YYYYMMDD) to ISO string
  uploadDateToIso(upload_date) {
    return videoPersistence.uploadDateToIso(upload_date);
  }

  // Upsert into channelvideos using info.json-like fields
  async upsertChannelVideoFromInfo(info, options) {
    return videoPersistence.upsertChannelVideoFromInfo(info, options);
  }

  // Backfill Videos and channelvideos tables from complete.list and jobs info JSON
  async backfillFromCompleteList() {
    try {
      const archivePath = path.join(__dirname, '../../config', 'complete.list');
      let archiveContent;
      try {
        archiveContent = await fsPromises.readFile(archivePath, 'utf-8');
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          logger.info('No complete.list found for backfill. Skipping.');
          return;
        }
        throw e;
      }

      const lines = archiveContent
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      const ids = lines
        .map((line) => line.split(' ')[1])
        .filter(Boolean);

      let videosUpserts = 0;
      let channelVideosUpserts = 0;
      const missingInfoIds = [];

      // Build fast lookup sets of existing youtube IDs to avoid overwriting fresher DB data
      const existingVideos = await Video.findAll({ attributes: ['youtubeId'] });
      const existingVideoIdSet = new Set(existingVideos.map(v => v.youtubeId));
      const existingChannelVideos = await ChannelVideo.findAll({ attributes: ['youtube_id'] });
      const existingChannelVideoIdSet = new Set(existingChannelVideos.map(cv => cv.youtube_id));

      // Build candidate list first (IDs needing backfill in either table),
      // starting from newest entries at the end of complete.list
      const candidates = [];
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i];
        const needsVideo = !existingVideoIdSet.has(id);
        const needsChannelVideo = !existingChannelVideoIdSet.has(id);
        // Always include in candidates - we may need to update media_type on existing records
        candidates.push({ id, needsVideo, needsChannelVideo });
      }

      // Cap per run to 300 items
      const maxPerRun = 300;
      const capped = candidates.slice(0, maxPerRun);

      let processed = 0;
      for (const { id, needsVideo, needsChannelVideo } of capped) {
        const infoPath = path.join(__dirname, `../../jobs/info/${id}.info.json`);

        let info;
        try {
          const content = await fsPromises.readFile(infoPath, 'utf-8');
          info = JSON.parse(content);
        } catch (e) {
          if (e && e.code === 'ENOENT') {
            // Record ids missing info.json only if we needed to backfill and cannot
            missingInfoIds.push(id);
            // Yield occasionally even on misses to keep loop responsive
            processed++;
            if (processed % 20 === 0) {
              await new Promise((resolve) => setImmediate(resolve));
            }
            continue;
          }
          logger.error({ err: e, id }, 'Failed parsing info.json');
          processed++;
          if (processed % 20 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }
          continue;
        }

        // Upsert into Videos table only if missing
        try {
          const configModule = require('./configModule');
          const baseOutputPath = configModule.directoryPath;
          const preferredChannelName = info.uploader || info.channel || info.uploader_id || info.channel_id || 'Unknown Channel';
          const videoFolder = `${preferredChannelName} - ${info.title} - ${info.id}`;
          const videoFileName = `${preferredChannelName} - ${info.title}  [${info.id}].mp4`;
          const fullPath = path.join(baseOutputPath, preferredChannelName, videoFolder, videoFileName);

          const payload = {
            youtubeId: info.id,
            youTubeChannelName: preferredChannelName,
            youTubeVideoName: info.title,
            duration: info.duration,
            description: info.description,
            originalDate: info.upload_date,
            channel_id: info.channel_id,
            media_type: info.media_type || 'video',
            content_rating: info.content_rating || null,
            age_limit: info.age_limit || null,
            normalized_rating: info.normalized_rating || null,
            rating_source: info.rating_source || null,
          };

          // Check if file exists and get file size
          try {
            const stats = await fsPromises.stat(fullPath);
            payload.filePath = fullPath;
            payload.fileSize = stats.size.toString();
            payload.removed = false;
          } catch (err) {
            // Try other common extensions
            const extensions = ['.webm', '.mkv', '.m4v', '.avi'];
            let fileFound = false;

            for (const ext of extensions) {
              const altPath = fullPath.replace('.mp4', ext);
              try {
                const stats = await fsPromises.stat(altPath);
                payload.filePath = altPath;
                payload.fileSize = stats.size.toString();
                payload.removed = false;
                fileFound = true;
                break;
              } catch (altErr) {
                // Continue trying other extensions
              }
            }

            if (!fileFound) {
              payload.filePath = fullPath;
              payload.fileSize = null;
              payload.removed = false;
            }
          }

          let videoInstance = await Video.findOne({ where: { youtubeId: info.id } });
          if (!videoInstance && needsVideo) {
            const created = await Video.create(payload);
            videosUpserts += 1;
            // Diagnostic for the nzb 'untracked' resurrection bug: this is
            // the exact point where a video whose DB row was removed (by
            // Sonarr/Radarr-triggered untrack) comes back to life, as long
            // as it's still listed in complete.list. If a video keeps
            // reappearing after being untracked, this log confirms it's
            // this path recreating it, and with what new id.
            logger.info(
              { newVideoId: created.id, youtubeId: info.id, removed: payload.removed },
              'backfillFromCompleteList: recreated a Video row from complete.list + info.json (was missing from Videos table)'
            );
          } else if (videoInstance) {
            const updates = {};

            // Update file metadata only if not already set
            if (!videoInstance.filePath || !videoInstance.fileSize) {
              if (payload.filePath || payload.fileSize) {
                updates.filePath = payload.filePath;
                updates.fileSize = payload.fileSize;
                updates.removed = payload.removed;
              }
            }

            // Update media_type only if currently set to default 'video' (meaning it hasn't been set yet)
            if (videoInstance.media_type === 'video' && payload.media_type && payload.media_type !== 'video') {
              updates.media_type = payload.media_type;
            }

            if (!videoInstance.normalized_rating && payload.normalized_rating) {
              updates.normalized_rating = payload.normalized_rating;
              updates.content_rating = payload.content_rating;
              updates.age_limit = payload.age_limit;
              updates.rating_source = payload.rating_source;
            }

            if (Object.keys(updates).length > 0) {
              await videoInstance.update(updates);
            }
          }
        } catch (vidErr) {
          logger.error({ err: vidErr, id }, 'Error upserting Videos');
        }

        // Upsert into channelvideos table only if missing
        try {
          if (needsChannelVideo) {
            await this.upsertChannelVideoFromInfo(info, { skipUpdateIfExists: true });
            channelVideosUpserts += 1;
          } else {
            // For existing records, only update media_type if it's currently 'video' (default)
            const existing = await ChannelVideo.findOne({
              where: { youtube_id: info.id, channel_id: info.channel_id }
            });
            if (existing && existing.media_type === 'video' && info.media_type && info.media_type !== 'video') {
              await existing.update({ media_type: info.media_type });
            }
          }
        } catch (cvErr) {
          logger.error({ err: cvErr, id }, 'Error upserting channelvideos');
        }

        // Yield to event loop every 20 items to keep server responsive
        processed++;
        if (processed % 20 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      logger.info({ videosUpserts, channelVideosUpserts }, 'Backfill complete');
      if (missingInfoIds.length > 0) {
        logger.warn({ missingCount: missingInfoIds.length, missingIds: missingInfoIds.join(', ') }, 'Backfill skipped due to missing info.json');
      }
    } catch (err) {
      logger.error({ err }, 'Backfill error');
    }
  }

  // Schedule daily backfill at 2:20am local time
  scheduleDailyBackfill() {
    try {
      cron.schedule('20 2 * * *', () => {
        this.backfillFromCompleteList().catch((err) => {
          logger.error({ err }, 'Scheduled backfill failed');
        });
      });
      logger.info('Scheduled daily backfill from complete.list at 2:20am');
    } catch (err) {
      logger.error({ err }, 'Failed to schedule daily backfill');
    }
  }

  getJob(jobId) {
    return this.jobs[jobId];
  }

  getRunningJobs() {
    // If this.jobs is undefined or null, return an empty array
    if (!this.jobs) {
      logger.debug('No jobs found. Returning empty array.');
      return [];
    }

    const now = Date.now();
    const cutoff = now - JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // Delete jobs older than the cutoff
    for (let jobId in this.jobs) {
      if (this.jobs[jobId].timeCreated < cutoff) {
        delete this.jobs[jobId];
      }
    }

    // Convert jobs into an array and add 'id' field
    let jobsArray = Object.entries(this.jobs).map(([id, job]) => {
      return { id, ...job };
    });

    // Pending jobs must appear in the same FIFO order startNextJob will run
    // them in (oldest-first / queueOrder), not lumped in with history's
    // newest-first sort - otherwise the queue table shows jobs in the
    // opposite order they'll actually execute, and manual reorders (which
    // only change queueOrder) appear to have no effect.
    const pending = jobsArray.filter((job) => job.status === 'Pending');
    const rest = jobsArray.filter((job) => job.status !== 'Pending');

    pending.sort((a, b) => this.pendingJobOrder(a) - this.pendingJobOrder(b));
    rest.sort((a, b) => b.timeCreated - a.timeCreated);

    if (DETAILED_DEBUG && pending.length > 0) {
      logger.info(
        { order: pending.map((j) => ({ id: j.id, queueOrder: j.data?.queueOrder, timeCreated: j.timeCreated, sortKey: this.pendingJobOrder(j) })) },
        '[detailedDebug] getRunningJobs pending order'
      );
    }

    jobsArray = [...pending, ...rest];

    // Return the most recent jobs, capped at MAX_HISTORY_JOBS
    return jobsArray.slice(0, MAX_HISTORY_JOBS);
  }

  // The in-memory job snapshot only refreshes at job completion or server
  // startup, so per-video fields (removed, protected, normalized_rating, etc.)
  // go stale after the user mutates a video. Re-read fresh rows from the
  // Videos table and substitute them in before returning to the client.
  async getRunningJobsWithFreshVideos() {
    const jobs = this.getRunningJobs();

    const videoIds = new Set();
    for (const job of jobs) {
      const videos = job.data?.videos;
      if (!Array.isArray(videos)) continue;
      for (const video of videos) {
        if (typeof video?.id === 'number') {
          videoIds.add(video.id);
        }
      }
    }

    // NZB grabs (see server/routes/nzb.js) that yt-dlp skipped because the
    // video was already downloaded by an earlier job leave THIS job's own
    // data.videos empty - no --exec post-processor run, no JobVideo row
    // created for this specific job - even though the video genuinely
    // exists in the library. Same fallback nzb.js's own resolveNzbVideoRow
    // uses for its Newznab/SABnzbd history reporting, applied here so the
    // Download History page can show a real title/thumbnail/filename for
    // these jobs too, instead of "None".
    const nzbYoutubeIdsNeedingBackfill = new Set();
    for (const job of jobs) {
      const hasVideos = Array.isArray(job.data?.videos) && job.data.videos.length > 0;
      const nzbYoutubeId = job.data?.nzb?.youtubeId;
      if (!hasVideos && nzbYoutubeId) {
        nzbYoutubeIdsNeedingBackfill.add(nzbYoutubeId);
      }
    }

    // ytstreamTapFinalizer.js's mode=hls-buffer fetch against an untracked
    // video (no Video row - see its skipVideoUpsert doc comment) stashes its
    // per-fetch facts (fileSize/timing/filePath) on the job's own aux_data
    // under `hlsBufferCacheInfo`, since there's no Video row to attach them
    // to. Build a display-only video object for these the same way the NZB
    // backfill above does, combined with whatever youtube_metadata_cache
    // already knows (title/channel/duration, if this video has ever been
    // streamed/viewed) - mirrors videosModule.js's own "Show untracked"
    // Library rows (id: null, isTracked: false).
    const hlsBufferInfoNeedingBackfill = new Map(); // youtubeId -> hlsBufferCacheInfo
    for (const job of jobs) {
      const hasVideos = Array.isArray(job.data?.videos) && job.data.videos.length > 0;
      const info = job.data?.hlsBufferCacheInfo;
      if (!hasVideos && info?.youtubeId) {
        hlsBufferInfoNeedingBackfill.set(info.youtubeId, info);
      }
    }

    if (videoIds.size === 0 && nzbYoutubeIdsNeedingBackfill.size === 0 && hlsBufferInfoNeedingBackfill.size === 0) {
      return jobs;
    }

    const freshVideos = videoIds.size > 0
      ? await Video.findAll({ where: { id: Array.from(videoIds) } })
      : [];
    const freshById = new Map(freshVideos.map(v => [v.id, v.dataValues]));

    const backfillByYoutubeId = new Map();
    if (nzbYoutubeIdsNeedingBackfill.size > 0) {
      const backfillVideos = await Video.findAll({
        where: { youtubeId: Array.from(nzbYoutubeIdsNeedingBackfill) },
      });
      for (const v of backfillVideos) {
        backfillByYoutubeId.set(v.youtubeId, v.dataValues);
      }
    }

    const hlsBufferMetadataByYoutubeId = new Map();
    if (hlsBufferInfoNeedingBackfill.size > 0) {
      // Lazy require (like youtubeMetadataCache.js's own getModel): this
      // model/its ../db dependency shouldn't load eagerly for every jobModule
      // consumer, only the rare read path that actually needs it.
      const YoutubeMetadataCache = require('../models/youtubemetadatacache');
      const metaRows = await YoutubeMetadataCache.findAll({
        where: { youtube_id: Array.from(hlsBufferInfoNeedingBackfill.keys()) },
      });
      for (const row of metaRows) {
        let info = null;
        try {
          info = row.raw_info_json ? JSON.parse(row.raw_info_json) : null;
        } catch (err) {
          logger.warn({ err, youtubeId: row.youtube_id }, 'getRunningJobsWithFreshVideos: failed to parse cached raw_info_json for HLS Buffer Cache backfill');
        }
        hlsBufferMetadataByYoutubeId.set(row.youtube_id, info);
      }
    }

    return jobs.map(job => {
      const videos = job.data?.videos;
      const hasVideos = Array.isArray(videos) && videos.length > 0;
      const nzbYoutubeId = job.data?.nzb?.youtubeId;
      const hlsBufferInfo = job.data?.hlsBufferCacheInfo;

      if (!hasVideos && nzbYoutubeId && backfillByYoutubeId.has(nzbYoutubeId)) {
        return {
          ...job,
          data: {
            ...job.data,
            videos: [backfillByYoutubeId.get(nzbYoutubeId)],
          },
        };
      }

      if (!hasVideos && hlsBufferInfo?.youtubeId) {
        const info = hlsBufferMetadataByYoutubeId.get(hlsBufferInfo.youtubeId) || null;
        return {
          ...job,
          data: {
            ...job.data,
            videos: [{
              id: null,
              youtubeId: hlsBufferInfo.youtubeId,
              youTubeChannelName: info?.uploader ?? info?.channel ?? '',
              youTubeVideoName: info?.title ?? hlsBufferInfo.youtubeId,
              duration: info?.duration ?? null,
              filePath: hlsBufferInfo.filePath ?? null,
              fileSize: hlsBufferInfo.fileSize ?? null,
              downloadDurationSeconds: hlsBufferInfo.downloadDurationSeconds ?? null,
              avgDownloadMBps: hlsBufferInfo.avgDownloadMBps ?? null,
              is_strm: false,
              removed: false,
              isTracked: false,
            }],
          },
        };
      }

      if (!Array.isArray(videos)) return job;
      return {
        ...job,
        data: {
          ...job.data,
          videos: videos.map(video => freshById.get(video?.id) || video),
        },
      };
    });
  }

  getAllJobs() {
    return this.jobs;
  }

  // Jobs still doing something (In Progress/Pending) are the only ones
  // "critical to function" - queued/active work that must survive a compact.
  // Everything else is finished history that just accumulates over time.
  getCompactableJobIds() {
    return Object.entries(this.jobs)
      .filter(([, job]) => job.status !== 'In Progress' && job.status !== 'Pending')
      .map(([id]) => id);
  }

  // Dry-run counts for the Maintenance page's "Compact History" preview -
  // read-only, makes no changes.
  previewCompactHistory() {
    const totalJobs = Object.keys(this.jobs).length;
    const compactableCount = this.getCompactableJobIds().length;
    return { totalJobs, compactableCount };
  }

  // Deletes every finished job (everything but In Progress/Pending) from
  // both the DB and memory, so history stops growing without bound.
  // JobVideos has no onDelete on its job_id FK (see
  // migrations/20230602155921-create-jobvideos-table.js), so those rows
  // must be removed before the Job row itself, or the delete would fail
  // with a foreign key constraint error; JobVideoDownloads has a real
  // ON DELETE CASCADE and cleans itself up.
  async compactHistory() {
    const idsToDelete = this.getCompactableJobIds();

    if (idsToDelete.length === 0) {
      return { success: true, deletedCount: 0 };
    }

    try {
      await JobVideo.destroy({ where: { job_id: { [Op.in]: idsToDelete } } });
      await Job.destroy({ where: { id: { [Op.in]: idsToDelete } } });
    } catch (error) {
      logger.error({ err: error }, 'Failed to compact job history');
      return { success: false, error: error.message, deletedCount: 0 };
    }

    for (const id of idsToDelete) {
      delete this.jobs[id];
    }

    this.emitJobsUpdated(null, 'HistoryCompacted');
    return { success: true, deletedCount: idsToDelete.length };
  }

  // Lets listing pages (e.g. Download History) refetch when a job is enqueued or starts.
  emitJobsUpdated(jobId, status) {
    MessageEmitter.emitMessage('broadcast', null, 'download', 'jobsUpdated', {
      jobId,
      status,
    });
  }

  async addJob(job) {
    const jobId = uuidv4(); // Generate a new UUID
    job.timeInitiated = Date.now();
    job.timeCreated = Date.now();
    job.id = jobId;
    if (job.status === 'Pending') {
      job.data = job.data || {};
      if (job.data.queueOrder === undefined) {
        // Defaults to creation order, preserving today's FIFO behavior for
        // anyone who never reorders the queue.
        job.data.queueOrder = job.timeCreated;
      }
    }
    this.jobs[jobId] = job;

    try {
      // Only save the new job to DB, don't touch other jobs
      await Job.create({
        id: jobId,
        jobType: job.jobType,
        status: job.status,
        output: job.output || '',
        timeInitiated: job.timeInitiated,
        timeCreated: job.timeCreated,
      });
      this.emitJobsUpdated(jobId, job.status);
      return jobId;
    } catch (error) {
      logger.error({ err: error }, 'Error saving job');
      throw error;
    }
  }

  async updateJob(jobId, updatedFields) {
    logger.debug({ jobId, status: updatedFields.status }, 'updateJob called');
    if (updatedFields.data && updatedFields.data.videos) {
      logger.debug({ jobId, videoCount: updatedFields.data.videos.length }, 'updateJob data contains videos');
    }

    const job = this.jobs[jobId];
    if (!job) {
      logger.warn('Job to update did not exist!');
      return;
    }

    // Non-download jobs (e.g. Import Subscriptions) manage their own output field.
    const jobIsDownload = isDownloadJob(job.jobType);

    if (
      jobIsDownload && (
        updatedFields.status === 'Complete' ||
        updatedFields.status === 'Error' ||
        updatedFields.status === 'Complete with Warnings' ||
        updatedFields.status === 'Terminated'
      )
    ) {
      // downloadModule already sends proper completion messages with finalSummary
      // Only send the downloadComplete event for backwards compatibility
      MessageEmitter.emitMessage(
        'broadcast',
        null,
        'download',
        'downloadComplete',
        { text: 'Download job completed.', videos: updatedFields.data?.videos || [] }
      );

      // Only modify output and status for actual completions, not terminations
      if (updatedFields.status !== 'Terminated') {
        let numVideos = updatedFields.data?.videos?.length || 0;
        updatedFields.output = numVideos + ' videos.';
        if (updatedFields.status !== 'Complete with Warnings') {
          updatedFields.status = 'Complete';
        }
      }
    }

    // Update in-memory job. `data` is merged rather than replaced wholesale:
    // callers (e.g. downloadJobFinalizer's terminal update) pass a fresh
    // payload containing only the fields they know about (videos,
    // failedVideos, diagnoses, ...), which would otherwise silently wipe
    // out-of-band data set elsewhere on the job - notably nzb.js's
    // job.data.nzb (and its stagedPath/untracked sub-fields), which the
    // NZB queue/history endpoints rely on to recognize the job at all. A
    // job whose data.nzb got dropped here simply vanishes from Sonarr/
    // Radarr's SABnzbd queue AND history once it completes.
    for (let field in updatedFields) {
      if (field === 'data') {
        job.data = { ...(job.data || {}), ...updatedFields.data };
      } else {
        job[field] = updatedFields[field];
      }
    }

    // Save only THIS job to DB, don't iterate through all jobs
    const isCompletedJob = updatedFields.status === 'Complete' ||
                           updatedFields.status === 'Complete with Warnings' ||
                           updatedFields.status === 'Error' ||
                           updatedFields.status === 'Terminated' ||
                           updatedFields.status === 'Killed';

    if (isCompletedJob && jobIsDownload) {
      // For completed download jobs, reload videos from DB to ensure accurate counts
      // This is especially important for multi-group downloads where each group
      // updates the job with only its own videos, potentially losing earlier videos
      try {
        const jobVideos = await JobVideo.findAll({
          where: { job_id: jobId }
        });

        const videos = [];
        for (const jobVideo of jobVideos) {
          const video = await Video.findOne({ where: { id: jobVideo.video_id } });
          if (video) {
            videos.push(video.dataValues);
          }
        }

        // Update in-memory structure with complete video list from DB
        if (!job.data) {
          job.data = {};
        }
        job.data.videos = videos;

        // Update output message to reflect correct video count
        if (updatedFields.status !== 'Terminated') {
          job.output = `${videos.length} videos.`;
        }

        logger.info({ jobId, videoCount: videos.length }, 'Reloaded videos from database for completed job');
      } catch (loadErr) {
        logger.error({ err: loadErr, jobId }, 'Error loading videos from database for completed job');
        // Continue with save anyway - don't fail the job completion
      }
    }

    if (isCompletedJob) {
      // Save ALL completed jobs to DB (download and non-download alike) with retry on failure
      this.saveJobOnly(jobId, job).catch(err => {
        logger.error({ err, jobId }, 'Failed to save completed job, marking for retry');
        // Track retry attempts to avoid infinite loops
        if (this.jobs[jobId]) {
          this.jobs[jobId]._needsSave = true;
          this.jobs[jobId]._saveRetries = (this.jobs[jobId]._saveRetries || 0) + 1;

          // Only retry up to 3 times
          if (this.jobs[jobId]._saveRetries <= MAX_SAVE_RETRIES) {
            this.scheduleSaveRetry(jobId, this.jobs[jobId]._saveRetries);
          } else {
            logger.error({ jobId, maxRetries: MAX_SAVE_RETRIES }, 'Max retries exceeded for job. Video data may be lost. Check database connectivity.');
            // Clear flags so we don't keep trying
            delete this.jobs[jobId]._needsSave;
            delete this.jobs[jobId]._saveRetries;
          }
        }
      });
    } else {
      // For in-progress jobs, call saveJobs to handle updates
      this.saveJobs().catch(err => {
        logger.error({ err, jobId }, 'Failed to save in-progress job');
      });
    }
  }

  scheduleSaveRetry(jobId, attempt) {
    const job = this.jobs[jobId];
    if (!job) {
      logger.warn({ jobId }, 'Cannot schedule retry for missing job');
      return;
    }

    const retryDelay = 1000 * attempt; // Exponential backoff: 1s, 2s, 3s
    logger.info({ jobId, attempt, maxRetries: MAX_SAVE_RETRIES, retryDelay }, 'Will retry save for job');

    setTimeout(() => {
      this.runSaveRetry(jobId, attempt);
    }, retryDelay);
  }

  async runSaveRetry(jobId, attempt) {
    const jobBeforeRetry = this.jobs[jobId];
    if (!jobBeforeRetry) {
      logger.warn({ jobId, attempt }, 'Retry attempt skipped - job no longer exists in memory');
      return;
    }

    try {
      await this.saveJobs();
    } catch (err) {
      logger.error({ err, jobId, attempt }, 'Retry attempt for job failed while saving jobs');
    }

    const jobAfterRetry = this.jobs[jobId];
    if (!jobAfterRetry) {
      logger.warn({ jobId, attempt }, 'Retry attempt completed but job is no longer tracked');
      return;
    }

    if (!jobAfterRetry._needsSave) {
      // Retry succeeded - clear counters if present
      if (jobAfterRetry._saveRetries) {
        logger.debug({ jobId, attempt }, 'Successfully saved job after retry attempt, clearing retry flags');
        delete jobAfterRetry._saveRetries;
      }
      return;
    }

    if (attempt >= MAX_SAVE_RETRIES) {
      logger.error({ jobId, maxRetries: MAX_SAVE_RETRIES }, 'Max retries exhausted for job. Video data may be lost. Giving up.');
      delete jobAfterRetry._needsSave;
      delete jobAfterRetry._saveRetries;
      return;
    }

    const nextAttempt = attempt + 1;
    jobAfterRetry._saveRetries = nextAttempt;
    logger.error({ jobId, attempt, nextAttempt, maxRetries: MAX_SAVE_RETRIES }, 'Retry attempt did not clear the pending save. Scheduling next attempt');
    this.scheduleSaveRetry(jobId, nextAttempt);
  }
}

module.exports = new JobModule();
