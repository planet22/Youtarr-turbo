const logger = require('../../logger');
const { EVENT_TYPES, LEVELS, describeEvent } = require('./eventCatalog');

// Append-only video/events log. Every call site is a single fire-and-forget
// `jobEventLog.record(...)`: it returns immediately, never throws, and never
// delays or alters the code it observes - a failure to write is logged and
// dropped, exactly like nzbDiagnosticLog. See the create-job-events migration
// for why rows carry a snapshot instead of foreign keys.

const MAX_MESSAGE_LENGTH = 512;
const MAX_TITLE_LENGTH = 512;
const MAX_CHANNEL_LENGTH = 255;
const MAX_JOB_TYPE_LENGTH = 255;
const MAX_DETAIL_BYTES = 16 * 1024;
const DEFAULT_RETENTION_DAYS = 180;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const truncate = (value, max) => {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text.length > max ? text.slice(0, max) : text;
};

// Detail is diagnostic context, never something a reader filters on, so an
// oversized or unserializable payload is replaced rather than failing the row.
function serializeDetail(detail) {
  if (detail === undefined || detail === null) return null;
  try {
    const json = JSON.stringify(detail);
    if (json.length > MAX_DETAIL_BYTES) {
      return JSON.stringify({ truncated: true, originalBytes: json.length });
    }
    return json;
  } catch (err) {
    return JSON.stringify({ unserializable: true });
  }
}

function parseDetail(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

class JobEventLog {
  constructor() {
    // Inserts run strictly in call order so row ids follow real event order
    // even though each write is async. occurred_at is captured synchronously
    // in record(), so a delayed insert still carries the true event time.
    this.tail = Promise.resolve();
  }

  /**
   * @param {string} eventType - one of EVENT_TYPES (unknown strings still record)
   * @param {object} [fields]
   * @param {string} [fields.jobId]
   * @param {string} [fields.youtubeId]
   * @param {string} [fields.videoTitle] - snapshot; looked up from Videos at write time when omitted
   * @param {string} [fields.channelName] - snapshot; same
   * @param {string} [fields.jobType] - snapshot; looked up from Jobs at write time when omitted
   * @param {object} [fields.detail] - structured context stored as JSON
   * @param {string} [fields.message] - overrides the catalog's message
   * @param {string} [fields.level] - overrides the catalog's level
   * @param {string} [fields.actor] - overrides the catalog's actor
   * @param {Date|number} [fields.occurredAt] - override for events reconstructed after the fact
   * @returns {void}
   */
  record(eventType, fields = {}) {
    try {
      const occurredAt = fields.occurredAt ? new Date(fields.occurredAt) : new Date();
      const { actor, level, message } = describeEvent(eventType, fields);
      const entry = {
        occurred_at: occurredAt,
        job_id: truncate(fields.jobId, 36),
        youtube_id: truncate(fields.youtubeId, 20),
        event_type: truncate(eventType, 64),
        level,
        actor: truncate(actor, 48),
        message: truncate(message, MAX_MESSAGE_LENGTH),
        detail: serializeDetail(fields.detail),
        video_title: truncate(fields.videoTitle, MAX_TITLE_LENGTH),
        channel_name: truncate(fields.channelName, MAX_CHANNEL_LENGTH),
        job_type: truncate(fields.jobType, MAX_JOB_TYPE_LENGTH),
      };
      this.tail = this.tail.then(() => this.write(entry));
    } catch (err) {
      logger.warn({ err, eventType }, 'jobEventLog: failed to queue event');
    }
  }

  // Resolves once every event recorded so far has been written (or dropped).
  flush() {
    return this.tail;
  }

  async write(entry) {
    try {
      const { JobEvent } = require('../../models');
      await this.fillSnapshot(entry);
      await JobEvent.create(entry);
    } catch (err) {
      logger.warn({ err, eventType: entry.event_type, jobId: entry.job_id }, 'jobEventLog: failed to persist event');
    }
  }

  // Best-effort: whatever the row can't be told by its caller is read from the
  // live Video/Job row at write time, so it stays readable after those rows
  // are deleted. Missing rows simply leave the snapshot columns null.
  async fillSnapshot(entry) {
    try {
      const { Video, Job } = require('../../models');
      if (entry.youtube_id && (!entry.video_title || !entry.channel_name)) {
        const video = await Video.findOne({
          where: { youtubeId: entry.youtube_id },
          attributes: ['youTubeVideoName', 'youTubeChannelName'],
        });
        if (video) {
          entry.video_title = entry.video_title || truncate(video.youTubeVideoName, MAX_TITLE_LENGTH);
          entry.channel_name = entry.channel_name || truncate(video.youTubeChannelName, MAX_CHANNEL_LENGTH);
        }
      }
      if (entry.job_id && !entry.job_type) {
        const job = await Job.findOne({ where: { id: entry.job_id }, attributes: ['jobType'] });
        if (job) entry.job_type = truncate(job.jobType, MAX_JOB_TYPE_LENGTH);
      }
    } catch (err) {
      logger.debug({ err }, 'jobEventLog: snapshot lookup failed; storing the row without it');
    }
  }

  /**
   * Cursor-paged read. Newest-first pages with `before`, oldest-first pages
   * with `after`; ids are the cursor because they follow real event order.
   * @param {object} [filters]
   * @param {string} [filters.jobId]
   * @param {string} [filters.youtubeId]
   * @param {string|string[]} [filters.eventType]
   * @param {string} [filters.level]
   * @param {string} [filters.q] - substring match on message, video title, channel name
   * @param {number} [filters.before] - only rows with id < before
   * @param {number} [filters.after] - only rows with id > after
   * @param {'asc'|'desc'} [filters.order='desc']
   * @param {number} [filters.limit]
   * @returns {Promise<{events: object[], nextCursor: number|null}>}
   */
  async list(filters = {}) {
    const { JobEvent } = require('../../models');
    const { Op } = require('sequelize');

    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(filters.limit)) || DEFAULT_PAGE_SIZE));
    const order = filters.order === 'asc' ? 'ASC' : 'DESC';
    const where = {};
    if (filters.jobId) where.job_id = filters.jobId;
    if (filters.youtubeId) where.youtube_id = filters.youtubeId;
    if (filters.eventType) where.event_type = filters.eventType;
    if (filters.level) where.level = filters.level;

    const idBounds = {};
    if (Number.isFinite(filters.before)) idBounds[Op.lt] = filters.before;
    if (Number.isFinite(filters.after)) idBounds[Op.gt] = filters.after;
    if (Reflect.ownKeys(idBounds).length > 0) where.id = idBounds;

    const q = typeof filters.q === 'string' ? filters.q.trim() : '';
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      where[Op.or] = [
        { message: { [Op.like]: pattern } },
        { video_title: { [Op.like]: pattern } },
        { channel_name: { [Op.like]: pattern } },
      ];
    }

    // One extra row tells us whether another page exists without a count query.
    const rows = await JobEvent.findAll({ where, order: [['id', order]], limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map((row) => this.toApiShape(row));
    const nextCursor = hasMore ? events[events.length - 1].id : null;
    return { events, nextCursor };
  }

  toApiShape(row) {
    const data = row.get ? row.get({ plain: true }) : row;
    return {
      id: data.id,
      occurredAt: new Date(data.occurred_at).toISOString(),
      jobId: data.job_id,
      youtubeId: data.youtube_id,
      eventType: data.event_type,
      level: data.level,
      actor: data.actor,
      message: data.message,
      detail: parseDetail(data.detail),
      videoTitle: data.video_title,
      channelName: data.channel_name,
      jobType: data.job_type,
    };
  }

  // 0 disables pruning (keep forever); anything invalid falls back to the default.
  getRetentionDays() {
    try {
      const raw = require('../configModule').getConfig().jobEventLogRetentionDays;
      const days = Number(raw);
      if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS;
      return Math.min(MAX_RETENTION_DAYS, Math.floor(days));
    } catch (err) {
      return DEFAULT_RETENTION_DAYS;
    }
  }

  /**
   * Deletes events older than the retention window. The only path that ever
   * removes rows.
   * @param {number} [retentionDays] - defaults to the configured value; 0 keeps everything
   * @returns {Promise<number>} rows deleted
   */
  async prune(retentionDays = this.getRetentionDays()) {
    if (!retentionDays) return 0;
    const { JobEvent } = require('../../models');
    const { Op } = require('sequelize');
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);
    const deleted = await JobEvent.destroy({ where: { occurred_at: { [Op.lt]: cutoff } } });
    if (deleted > 0) {
      logger.info({ deleted, retentionDays }, 'jobEventLog: pruned events past retention');
    }
    return deleted;
  }
}

module.exports = new JobEventLog();
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LEVELS = LEVELS;
module.exports.DEFAULT_RETENTION_DAYS = DEFAULT_RETENTION_DAYS;
