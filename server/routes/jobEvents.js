const express = require('express');
const logger = require('../logger');

const MAX_ID_LENGTH = 36;
const MAX_YOUTUBE_ID_LENGTH = 20;
const MAX_EVENT_TYPE_LENGTH = 64;
const MAX_SEARCH_LENGTH = 200;
const MAX_LIMIT = 500;
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
    level: optionalString(query, 'level', 8),
    order: optionalString(query, 'order', 4),
    before: optionalInteger(query, 'before'),
    after: optionalInteger(query, 'after'),
    limit: optionalInteger(query, 'limit', MAX_LIMIT),
  };

  const failed = Object.values(fields).find((field) => field.error);
  if (failed) return { error: failed.error };
  if (fields.level.value !== undefined && !LEVELS.includes(fields.level.value)) {
    return { error: `level must be one of: ${LEVELS.join(', ')}` };
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
   *       timestamps. Newest first by default. Page with `before` (older) or `after`
   *       (newer, use with order=asc) using the returned nextCursor.
   *     tags: [Jobs]
   *     parameters:
   *       - { in: query, name: jobId, schema: { type: string } }
   *       - { in: query, name: youtubeId, schema: { type: string } }
   *       - { in: query, name: eventType, schema: { type: string }, description: "e.g. video.failed" }
   *       - { in: query, name: level, schema: { type: string, enum: [info, warn, error] } }
   *       - { in: query, name: q, schema: { type: string }, description: Substring match on message, video title and channel }
   *       - { in: query, name: before, schema: { type: integer }, description: Only entries with id below this }
   *       - { in: query, name: after, schema: { type: integer }, description: Only entries with id above this }
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
   *                 nextCursor: { type: integer, nullable: true }
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

  return router;
}

module.exports = createJobEventRoutes;
