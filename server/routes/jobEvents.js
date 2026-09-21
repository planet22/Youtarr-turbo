const express = require('express');
const logger = require('../logger');

const MAX_ID_LENGTH = 36;
const MAX_YOUTUBE_ID_LENGTH = 20;
const MAX_EVENT_TYPE_LENGTH = 64;
const MAX_SEARCH_LENGTH = 200;
const MAX_LIMIT = 500;
const MAX_TIMESTAMP_LENGTH = 40;
const MAX_ACTOR_LENGTH = 48;
const MAX_CHANNEL_LENGTH = 255;
const MAX_SOURCE_LENGTH = 40;
const TRACKED_VALUES = ['tracked', 'untracked'];
const CATEGORIES = ['job', 'video', 'nzb', 'strm', 'cache', 'playlist', 'log'];
const LEVELS = ['info', 'warn', 'error'];
const ORDERS = ['asc', 'desc'];

// Reads an optional string query param; returns { value } or { error }.
function optionalString(query, name, maxLength) {
  const raw = query[name];
  if (raw === undefined || raw === '') return { value: undefined };
  if (typeof raw !== 'string') return { error: `${name} must be a single string` };
  if (raw.length > maxLength) return { error: `${name} must be at most ${maxLength} characters` };
  return { value: raw };
}

// Reads an optional ISO timestamp query param; returns { value } or { error }.
function optionalTimestamp(query, name) {
  const parsed = optionalString(query, name, MAX_TIMESTAMP_LENGTH);
  if (parsed.error || parsed.value === undefined) return parsed;
  if (Number.isNaN(Date.parse(parsed.value))) return { error: `${name} must be an ISO date or date-time` };
  return parsed;
}

// Reads an optional non-negative integer query param; returns { value } or { error }.
function optionalInteger(query, name, max = Number.MAX_SAFE_INTEGER) {
  const raw = query[name];
  if (raw === undefined || raw === '') return { value: undefined };
  const parsed = Number(raw);
  if (typeof raw !== 'string' || !Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    return { error: `${name} must be an integer between 0 and ${max}` };
  }
  return { value: parsed };
}

/**
 * Validates and normalises the list query. Returns { filters } or { error }.
 * Untrusted input: every value is length/shape checked before it reaches the module.
 */
function parseListQuery(query) {
  const fields = {
    jobId: optionalString(query, 'jobId', MAX_ID_LENGTH),
    youtubeId: optionalString(query, 'youtubeId', MAX_YOUTUBE_ID_LENGTH),
    eventType: optionalString(query, 'eventType', MAX_EVENT_TYPE_LENGTH),
    q: optionalString(query, 'q', MAX_SEARCH_LENGTH),
    category: optionalString(query, 'category', 8),
    level: optionalString(query, 'level', 8),
    actor: optionalString(query, 'actor', MAX_ACTOR_LENGTH),
    channel: optionalString(query, 'channel', MAX_CHANNEL_LENGTH),
    source: optionalString(query, 'source', MAX_SOURCE_LENGTH),
    tracked: optionalString(query, 'tracked', 10),
    order: optionalString(query, 'order', 4),
    from: optionalTimestamp(query, 'from'),
    to: optionalTimestamp(query, 'to'),
    offset: optionalInteger(query, 'offset'),
    limit: optionalInteger(query, 'limit', MAX_LIMIT),
  };

  const failed = Object.values(fields).find((field) => field.error);
  if (failed) return { error: failed.error };
  if (fields.level.value !== undefined && !LEVELS.includes(fields.level.value)) {
    return { error: `level must be one of: ${LEVELS.join(', ')}` };
  }
  if (fields.tracked.value !== undefined && !TRACKED_VALUES.includes(fields.tracked.value)) {
    return { error: `tracked must be one of: ${TRACKED_VALUES.join(', ')}` };
  }
  if (fields.category.value !== undefined && !CATEGORIES.includes(fields.category.value)) {
    return { error: `category must be one of: ${CATEGORIES.join(', ')}` };
  }
  if (fields.order.value !== undefined && !ORDERS.includes(fields.order.value)) {
    return { error: `order must be one of: ${ORDERS.join(', ')}` };
  }

  const filters = {};
  for (const [name, field] of Object.entries(fields)) {
    if (field.value !== undefined) filters[name] = field.value;
  }
  return { filters };
}

/**
 * Video/events log read routes (session-auth only).
 * @param {Object} deps
 * @param {Function} deps.verifyToken
 * @param {Object} deps.jobEventLog
 * @returns {express.Router}
 */
function createJobEventRoutes({ verifyToken, jobEventLog }) {
  const router = express.Router();

  /**
   * @swagger
   * /api/job-events:
   *   get:
   *     summary: List video/events log entries
   *     description: >
   *       Append-only log of each step in a job's or video's life, with millisecond
   *       timestamps. Newest first by default; events on the same millisecond keep
   *       the order they were written in. Page with `limit` and `offset`; `total`
   *       is the number of events matching the filters.
   *     tags: [Jobs]
   *     parameters:
   *       - { in: query, name: jobId, schema: { type: string } }
   *       - { in: query, name: youtubeId, schema: { type: string } }
   *       - { in: query, name: eventType, schema: { type: string }, description: "e.g. video.failed" }
   *       - { in: query, name: level, schema: { type: string, enum: [info, warn, error] } }
   *       - { in: query, name: q, schema: { type: string }, description: Substring match on message, video title and channel }
   *       - { in: query, name: category, schema: { type: string, enum: [job, video, nzb, strm, cache, playlist, log] }, description: Event type family }
   *       - { in: query, name: from, schema: { type: string, format: date-time }, description: Only events at or after this time }
   *       - { in: query, name: to, schema: { type: string, format: date-time }, description: Only events at or before this time }
   *       - { in: query, name: actor, schema: { type: string }, description: Who recorded the event (downloader, nzb, ...) }
   *       - { in: query, name: channel, schema: { type: string }, description: Exact channel name }
   *       - { in: query, name: source, schema: { type: string }, description: Job source label from /api/job-events/facets }
   *       - { in: query, name: tracked, schema: { type: string, enum: [tracked, untracked] }, description: Whether the video was in the library when the event happened }
   *       - { in: query, name: offset, schema: { type: integer, minimum: 0 } }
   *       - { in: query, name: order, schema: { type: string, enum: [asc, desc], default: desc } }
   *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 500, default: 100 } }
   *     responses:
   *       200:
   *         description: A page of log entries
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 events:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: integer }
   *                       occurredAt: { type: string, format: date-time, description: ISO timestamp with milliseconds }
   *                       jobId: { type: string, nullable: true }
   *                       youtubeId: { type: string, nullable: true }
   *                       eventType: { type: string }
   *                       level: { type: string }
   *                       actor: { type: string, nullable: true }
   *                       message: { type: string }
   *                       detail: { type: object, nullable: true }
   *                       videoTitle: { type: string, nullable: true }
   *                       channelName: { type: string, nullable: true }
   *                       jobType: { type: string, nullable: true }
   *                       isTracked: { type: boolean, nullable: true, description: Whether the video was in the library at that moment; null if not known }
   *                 total: { type: integer }
   *       400:
   *         description: Invalid query parameter
   *       500:
   *         description: Failed to read the log
   */
  router.get('/api/job-events', verifyToken, async (req, res) => {
    const { filters, error } = parseListQuery(req.query);
    if (error) {
      return res.status(400).json({ error });
    }

    try {
      const result = await jobEventLog.list(filters);
      return res.json(result);
    } catch (err) {
      logger.error({ err, filters }, 'Failed to list video/events log entries');
      return res.status(500).json({ error: 'Failed to list video/events log entries' });
    }
  });

  /**
   * @swagger
   * /api/job-events/facets:
   *   get:
   *     summary: Values available to the log's filter dropdowns
   *     description: Distinct event types, actors and channel names present in the log, plus the job source labels.
   *     tags: [Jobs]
   *     responses:
   *       200:
   *         description: Filter option lists
   *       500:
   *         description: Failed to read the log
   */
  router.get('/api/job-events/facets', verifyToken, async (req, res) => {
    try {
      return res.json(await jobEventLog.facets());
    } catch (err) {
      logger.error({ err }, 'Failed to read video/events log filter options');
      return res.status(500).json({ error: 'Failed to read video/events log filter options' });
    }
  });

  /**
   * @swagger
   * /api/job-events:
   *   delete:
   *     summary: Clear the whole video/events log
   *     description: Permanently deletes every log entry (one "log cleared" entry is left behind). Download History and downloaded videos are not affected. Cannot be undone.
   *     tags: [Maintenance]
   *     responses:
   *       200:
   *         description: The log was cleared
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success: { type: boolean }
   *                 deletedCount: { type: integer }
   *       500:
   *         description: Failed to clear the log
   */
  router.delete('/api/job-events', verifyToken, async (req, res) => {
    try {
      const deletedCount = await jobEventLog.clear();
      return res.json({ success: true, deletedCount });
    } catch (err) {
      logger.error({ err }, 'Failed to clear the video/events log');
      return res.status(500).json({ error: 'Failed to clear the video/events log' });
    }
  });

  return router;
}

module.exports = createJobEventRoutes;
