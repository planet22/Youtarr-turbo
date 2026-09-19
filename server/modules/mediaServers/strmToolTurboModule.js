// Remote control of the StrmToolTurbo Jellyfin plugin (extracts codec / stream
// info for .strm files and caches it in .strmtool.json sidecars) through
// Jellyfin's plugin and scheduled-task APIs, authenticated with the same API
// key the Jellyfin adapter already holds. Jellyfin stays the source of truth
// for the plugin's settings; nothing is mirrored into Youtarr's config.json.

const PLUGIN_ID = '6107fc8c-883a-4171-b70e-7590658706b9';
// IScheduledTask.Key of the plugin's extraction task; the display name is
// localised, so the key is matched first and a "strm" name match is the fallback.
const TASK_KEY = 'StrmToolTask';
const TASK_NAME_FALLBACK = /strm/i;
const TASK_STATE_RUNNING = ['Running', 'Cancelling'];

// Limits mirror the sliders on the plugin's own Jellyfin config page.
const CONFIG_FIELDS = [
  { key: 'enableAutoExtract', jellyfinKey: 'EnableAutoExtract', type: 'boolean' },
  { key: 'enableMediaInfoCache', jellyfinKey: 'EnableMediaInfoCache', type: 'boolean' },
  { key: 'importExistingCacheWhenMissing', jellyfinKey: 'ImportExistingCacheWhenMissing', type: 'boolean' },
  { key: 'forceRefreshIgnoreExisting', jellyfinKey: 'ForceRefreshIgnoreExisting', type: 'boolean' },
  { key: 'forceRefreshIgnoreCache', jellyfinKey: 'ForceRefreshIgnoreCache', type: 'boolean' },
  { key: 'refreshDelayMs', jellyfinKey: 'RefreshDelayMs', type: 'integer', min: 0, max: 10000 },
  { key: 'metadataRestoreTimeoutMinutes', jellyfinKey: 'MetadataRestoreTimeoutMinutes', type: 'integer', min: 1, max: 30 },
  { key: 'maxConcurrentExtract', jellyfinKey: 'MaxConcurrentExtract', type: 'integer', min: 1, max: 50 },
];

class StrmToolTurboError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'StrmToolTurboError';
    this.statusCode = statusCode;
  }
}

// Jellyfin serialises GUIDs without dashes ("N" format) in JSON, so ids from
// /Plugins never match the dashed form; compare with the dashes stripped.
const normalizeGuid = (id) => String(id || '').replace(/-/g, '').toLowerCase();

// Jellyfin serialises plugin config PascalCase; tolerate any casing on read.
function findKey(obj, wanted) {
  const lower = wanted.toLowerCase();
  return Object.keys(obj).find((k) => k.toLowerCase() === lower);
}

function normalizeConfiguration(raw) {
  const out = {};
  for (const field of CONFIG_FIELDS) {
    const actualKey = findKey(raw, field.jellyfinKey);
    out[field.key] = actualKey === undefined ? null : raw[actualKey];
  }
  return out;
}

function validateUpdates(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new StrmToolTurboError('Request body must be an object of plugin settings', 400);
  }
  const valid = {};
  for (const [key, value] of Object.entries(updates)) {
    const field = CONFIG_FIELDS.find((f) => f.key === key);
    if (!field) throw new StrmToolTurboError(`Unknown StrmToolTurbo setting: ${key}`, 400);
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new StrmToolTurboError(`${key} must be true or false`, 400);
    } else if (!Number.isInteger(value) || value < field.min || value > field.max) {
      throw new StrmToolTurboError(`${key} must be a whole number from ${field.min} to ${field.max}`, 400);
    }
    valid[field.key] = value;
  }
  return valid;
}

function mapTask(task) {
  const last = task.LastExecutionResult;
  return {
    id: task.Id,
    name: task.Name,
    state: task.State,
    running: TASK_STATE_RUNNING.includes(task.State),
    progressPercent: typeof task.CurrentProgressPercentage === 'number' ? task.CurrentProgressPercentage : null,
    lastRun: last
      ? {
        status: last.Status,
        startedAt: last.StartTimeUtc || null,
        endedAt: last.EndTimeUtc || null,
        error: last.ErrorMessage || null,
      }
      : null,
  };
}

class StrmToolTurboModule {
  async _findPlugin(adapter) {
    const plugins = await adapter.listPlugins();
    return plugins.find((p) => normalizeGuid(p.Id) === normalizeGuid(PLUGIN_ID)) || null;
  }

  async _findTask(adapter) {
    const tasks = await adapter.listScheduledTasks();
    const task = tasks.find((t) => t.Key === TASK_KEY) || tasks.find((t) => TASK_NAME_FALLBACK.test(t.Name || ''));
    return task || null;
  }

  async _requireActivePlugin(adapter) {
    const plugin = await this._findPlugin(adapter);
    if (!plugin) throw new StrmToolTurboError('The StrmToolTurbo plugin is not installed on this Jellyfin server', 404);
    if (plugin.Status !== 'Active') {
      throw new StrmToolTurboError(`The StrmToolTurbo plugin is not active (status: ${plugin.Status})`, 409);
    }
  }

  async getStatus(adapter) {
    const plugin = await this._findPlugin(adapter);
    if (!plugin) return { installed: false };
    const status = { installed: true, version: plugin.Version, pluginStatus: plugin.Status };
    // A disabled or failed plugin has no live configuration or task to read.
    if (plugin.Status !== 'Active') return status;

    const [raw, task] = await Promise.all([adapter.getPluginConfiguration(PLUGIN_ID), this._findTask(adapter)]);
    return { ...status, config: normalizeConfiguration(raw), task: task ? mapTask(task) : null };
  }

  async saveConfiguration(adapter, updates) {
    const valid = validateUpdates(updates);
    await this._requireActivePlugin(adapter);

    const raw = await adapter.getPluginConfiguration(PLUGIN_ID);
    const merged = { ...raw };
    for (const field of CONFIG_FIELDS) {
      if (!(field.key in valid)) continue;
      merged[findKey(raw, field.jellyfinKey) || field.jellyfinKey] = valid[field.key];
    }
    await adapter.setPluginConfiguration(PLUGIN_ID, merged);
    return normalizeConfiguration(merged);
  }

  async runExtraction(adapter) {
    await this._requireActivePlugin(adapter);
    const task = await this._findTask(adapter);
    if (!task) throw new StrmToolTurboError('The StrmToolTurbo extraction task was not found on the server', 404);
    if (TASK_STATE_RUNNING.includes(task.State)) {
      throw new StrmToolTurboError('The extraction task is already running', 409);
    }
    await adapter.startScheduledTask(task.Id);
  }
}

module.exports = new StrmToolTurboModule();
module.exports.StrmToolTurboError = StrmToolTurboError;
module.exports.CONFIG_FIELDS = CONFIG_FIELDS;
module.exports.PLUGIN_ID = PLUGIN_ID;
