const { AsyncLocalStorage } = require('async_hooks');
const logger = require('../../logger');
const { EVENT_TYPES, LEVELS, describeEvent } = require('./eventCatalog');
const { SOURCES, SOURCE_LABELS } = require('./sourceLabels');

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
const MAX_REMEMBERED = 2000;
const MAX_FACET_VALUES = 500;
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

// "Title [GSdt_08xE8k]" -> "Title": NZB names carry the video id; the real title does not.
const cleanProvisionalTitle = (title) =>
  typeof title === 'string' ? title.replace(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/, '').trim() || undefined : undefined;

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

// Insertion-ordered map capped at MAX_REMEMBERED entries, oldest evicted first.
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

class JobEventLog {
  constructor() {
    // Inserts run strictly in call order so row ids follow real event order
    // even though each write is async. occurred_at is captured synchronously
    // in record(), so a delayed insert still carries the true event time.
    this.tail = Promise.resolve();
    // Ambient context (see runWithContext) so a caller can say once WHY a
    // whole operation is happening instead of threading a reason argument
    // through every function underneath it.
    this.contextStorage = new AsyncLocalStorage();
    this.videoInfo = new Map();
    this.jobTypes = new Map();
    // Which videos currently have a library row. Null until warm() has read the
    // Videos table; changes made before then are kept in trackedOverrides so
    // none is lost when the read lands.
    this.trackedIds = null;
    this.trackedOverrides = new Map();
  }

  /**
   * Loads which videos are in the library (and the names of the most recent
   * ones) once, at startup, so record() can answer synchronously afterwards.
   * Events recorded before this finishes carry "unknown" for is_tracked.
   */
  async warm() {
    try {
      const { Video } = require('../../models');
      const rows = await Video.findAll({
        attributes: ['youtubeId', 'youTubeVideoName', 'youTubeChannelName'],
        raw: true,
      });
      const ids = new Set(rows.map((row) => row.youtubeId));
      for (const [id, tracked] of this.trackedOverrides) {
        if (tracked) ids.add(id);
        else ids.delete(id);
      }
      this.trackedOverrides.clear();
      this.trackedIds = ids;
      // Newest rows last; never overwrite a name something already supplied.
      for (const row of rows.slice(-MAX_REMEMBERED)) {
        if (this.videoInfo.has(row.youtubeId)) continue;
        this.rememberVideo(row.youtubeId, { title: row.youTubeVideoName, channelName: row.youTubeChannelName });
      }
      logger.info({ videos: ids.size }, 'jobEventLog: loaded library state');
    } catch (err) {
      logger.warn({ err }, 'jobEventLog: could not load library state; is_tracked stays unknown until restart');
    }
  }

  /**
   * Called where a Video row is created (true) or removed (false).
   * @param {string} youtubeId
   * @param {boolean} tracked
   */
  markTracked(youtubeId, tracked) {
    if (!youtubeId) return;
    if (this.trackedIds) {
      if (tracked) this.trackedIds.add(youtubeId);
      else this.trackedIds.delete(youtubeId);
    } else {
      remember(this.trackedOverrides, youtubeId, Boolean(tracked));
    }
  }

  // true / false once library state is loaded, null while it is not known.
  isTracked(youtubeId) {
    if (!youtubeId) return null;
    if (this.trackedOverrides.has(youtubeId)) return this.trackedOverrides.get(youtubeId);
    return this.trackedIds ? this.trackedIds.has(youtubeId) : null;
  }

  /**
   * Runs fn with an ambient context that record() applies to every event
   * recorded inside it (including across awaits): ctx.actor becomes the
   * event's actor and ctx.reason its detail.reason, unless the call itself
   * already set them. e.g. the nightly auto-removal wraps its run in
   * { actor: 'auto-removal', reason: 'automatic removal' }.
   * @param {{actor?: string, reason?: string}} ctx
   * @param {Function} fn
   * @returns {*} whatever fn returns
   */
  runWithContext(ctx, fn) {
    return this.contextStorage.run(ctx, fn);
  }

  /**
   * @param {string} eventType - one of EVENT_TYPES (unknown strings still record)
   * @param {object} [fields]
   * @param {string} [fields.jobId]
   * @param {string} [fields.youtubeId]
   * @param {string} [fields.videoTitle] - snapshot; looked up from Videos at write time when omitted
   * @param {string} [fields.channelName] - snapshot; same
   * @param {string} [fields.provisionalTitle] - a stand-in title (e.g. an NZB name), used only when no real title is known
   * @param {boolean} [fields.isTracked] - whether the video has a library row; when omitted it is read from the in-memory library state
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
      const ctx = this.contextStorage.getStore();
      if (ctx) {
        fields = {
          ...fields,
          actor: fields.actor || ctx.actor,
          detail: ctx.reason && !(fields.detail && fields.detail.reason)
            ? { ...fields.detail, reason: ctx.reason }
            : fields.detail,
        };
      }
      const occurredAt = fields.occurredAt ? new Date(fields.occurredAt) : new Date();
      const { actor, level, message } = describeEvent(eventType, fields);
      // Everything is fixed here, at the moment of the event: what the caller
      // knows first, then what was remembered a moment ago. Never looked up later.
      // A provisional title (e.g. an NZB's own name) is used only when nothing
      // authoritative is known, so one video reads the same across its events.
      const known = (fields.youtubeId && this.videoInfo.get(fields.youtubeId)) || {};
      const videoTitle = fields.videoTitle || known.title || cleanProvisionalTitle(fields.provisionalTitle);
      const channelName = fields.channelName || known.channelName;
      if (fields.isTracked !== undefined) this.markTracked(fields.youtubeId, fields.isTracked);
      const isTracked = fields.isTracked !== undefined ? fields.isTracked : this.isTracked(fields.youtubeId);
      const jobType = fields.jobType || (fields.jobId && this.jobTypes.get(fields.jobId)) || undefined;
      // Only authoritative names are remembered, never a provisional one.
      if (fields.youtubeId) this.rememberVideo(fields.youtubeId, { title: fields.videoTitle, channelName: fields.channelName });
      const entry = {
        occurred_at: occurredAt,
        job_id: truncate(fields.jobId, 36),
        youtube_id: truncate(fields.youtubeId, 20),
        event_type: truncate(eventType, 64),
        level,
        actor: truncate(actor, 48),
        message: truncate(message, MAX_MESSAGE_LENGTH),
        detail: serializeDetail(fields.detail),
        video_title: truncate(videoTitle, MAX_TITLE_LENGTH),
        channel_name: truncate(channelName, MAX_CHANNEL_LENGTH),
        job_type: truncate(jobType, MAX_JOB_TYPE_LENGTH),
        is_tracked: isTracked === null || isTracked === undefined ? null : Boolean(isTracked),
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

  // Inserts exactly what record() captured. Nothing is looked up here: every
  // fact on the row was taken at the moment of the event, so it can never be
  // wrong or missing because a Video/Job row changed or vanished in between.
  async write(entry) {
    try {
      const { JobEvent } = require('../../models');
      await JobEvent.create(entry);
    } catch (err) {
      logger.warn({ err, eventType: entry.event_type, jobId: entry.job_id }, 'jobEventLog: failed to persist event');
    }
  }

  // Synchronous, in-memory memory of what recent videos/jobs are called, fed
  // by call sites that already hold the facts (a persisted Video, a new job).
  // record() reads it instantly so an event that lacks a title can still be
  // stamped with what was known at that moment - never with a later lookup.
  rememberVideo(youtubeId, { title, channelName } = {}) {
    if (!youtubeId || (!title && !channelName)) return;
    const previous = this.videoInfo.get(youtubeId) || {};
    remember(this.videoInfo, youtubeId, {
      title: title || previous.title,
      channelName: channelName || previous.channelName,
    });
  }

  rememberJob(jobId, jobType) {
    if (jobId && jobType) remember(this.jobTypes, jobId, jobType);
  }

  /**
   * Page read. Ties on the same millisecond keep the order they were written
   * in (insertion order), whichever direction the list runs.
   * @param {object} [filters]
   * @param {string} [filters.jobId]
   * @param {string} [filters.youtubeId]
   * @param {string} [filters.eventType]
   * @param {string} [filters.category] - event type family: job, video, nzb, strm or cache
   * @param {string} [filters.level]
   * @param {string} [filters.actor]
   * @param {'tracked'|'untracked'} [filters.tracked] - whether the video was in the library when it happened
   * @param {string} [filters.channel]
   * @param {string} [filters.source] - a job source label (Channels, NZB, ...)
   * @param {string} [filters.q] - substring match on message, video title, channel name
   * @param {string} [filters.from] - only events at or after this ISO time
   * @param {string} [filters.to] - only events at or before this ISO time
   * @param {'asc'|'desc'} [filters.order='desc'] - by time
   * @param {number} [filters.limit]
   * @param {number} [filters.offset]
   * @returns {Promise<{events: object[], total: number}>}
   */
  async list(filters = {}) {
    const { JobEvent } = require('../../models');
    const { Op } = require('sequelize');

    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(filters.limit)) || DEFAULT_PAGE_SIZE));
    const offset = Math.max(0, Math.floor(Number(filters.offset)) || 0);
    const order = filters.order === 'asc' ? 'ASC' : 'DESC';
    const where = {};
    if (filters.jobId) where.job_id = filters.jobId;
    if (filters.youtubeId) where.youtube_id = filters.youtubeId;
    if (filters.eventType) where.event_type = filters.eventType;
    if (filters.level) where.level = filters.level;
    if (filters.category) where.event_type = { [Op.like]: `${escapeLike(filters.category)}.%` };
    if (filters.actor) where.actor = filters.actor;
    if (filters.tracked === 'tracked') where.is_tracked = true;
    if (filters.tracked === 'untracked') where.is_tracked = false;
    if (filters.channel) where.channel_name = filters.channel;
    // A source label selects jobs by their type; an unknown label is ignored.
    const sourcePatterns = filters.source && SOURCES[filters.source];
    if (sourcePatterns) where[Op.and] = [{ [Op.or]: sourcePatterns.map((pattern) => ({ job_type: { [Op.like]: pattern } })) }];

    const timeBounds = {};
    if (filters.from) timeBounds[Op.gte] = new Date(filters.from);
    if (filters.to) timeBounds[Op.lte] = new Date(filters.to);
    if (Reflect.ownKeys(timeBounds).length > 0) where.occurred_at = timeBounds;

    const q = typeof filters.q === 'string' ? filters.q.trim() : '';
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      where[Op.or] = [
        { message: { [Op.like]: pattern } },
        { video_title: { [Op.like]: pattern } },
        { channel_name: { [Op.like]: pattern } },
      ];
    }

    const [total, rows] = await Promise.all([
      JobEvent.count({ where }),
      JobEvent.findAll({ where, order: [['occurred_at', order], ['id', 'ASC']], limit, offset }),
    ]);
    return { events: rows.map((row) => this.toApiShape(row)), total };
  }

  /**
   * The values each filter dropdown can offer, taken from the log itself.
   * @returns {Promise<{eventTypes: string[], actors: string[], channels: string[], sources: string[]}>}
   */
  async facets() {
    const { JobEvent } = require('../../models');
    const { Op, fn, col } = require('sequelize');
    const distinct = async (column) => {
      const rows = await JobEvent.findAll({
        attributes: [[fn('DISTINCT', col(column)), 'value']],
        where: { [column]: { [Op.ne]: null } },
        order: [[col(column), 'ASC']],
        limit: MAX_FACET_VALUES,
        raw: true,
      });
      return rows.map((row) => row.value).filter(Boolean);
    };
    const [eventTypes, actors, channels] = await Promise.all([
      distinct('event_type'),
      distinct('actor'),
      distinct('channel_name'),
    ]);
    return { eventTypes, actors, channels, sources: SOURCE_LABELS };
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
      isTracked: data.is_tracked === null || data.is_tracked === undefined ? null : Boolean(data.is_tracked),
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
   * Deletes every event (the Maintenance page's "Clear event log"). Pending
   * writes are flushed first so nothing lands after the delete, and one
   * log.cleared entry is left behind so the log never empties silently.
   * @returns {Promise<number>} rows deleted
   */
  async clear() {
    const { JobEvent } = require('../../models');
    await this.flush();
    const deletedCount = await JobEvent.destroy({ where: {} });
    this.record(EVENT_TYPES.LOG_CLEARED, { detail: { deletedCount } });
    logger.warn({ deletedCount }, 'jobEventLog: event log cleared');
    return deletedCount;
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
