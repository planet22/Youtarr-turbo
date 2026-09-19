const strmToolTurbo = require('../strmToolTurboModule');

const PLUGIN_ID = '6107fc8c-883a-4171-b70e-7590658706b9';

const RAW_CONFIG = {
  RefreshDelayMs: 5000,
  EnableAutoExtract: false,
  EnableMediaInfoCache: true,
  MaxConcurrentExtract: 5,
  ForceRefreshIgnoreExisting: false,
  ForceRefreshIgnoreCache: false,
  MetadataRestoreTimeoutMinutes: 5,
  ImportExistingCacheWhenMissing: true,
};

const buildAdapter = (overrides = {}) => ({
  listPlugins: jest.fn().mockResolvedValue([{ Id: PLUGIN_ID.replace(/-/g, ''), Name: 'StrmToolTurbo', Version: '1.0.0.0', Status: 'Active' }]),
  getPluginConfiguration: jest.fn().mockResolvedValue({ ...RAW_CONFIG }),
  setPluginConfiguration: jest.fn().mockResolvedValue(undefined),
  listScheduledTasks: jest.fn().mockResolvedValue([
    { Id: 'other', Key: 'RefreshLibrary', Name: 'Scan Media Library', State: 'Idle' },
    { Id: 'task-1', Key: 'StrmToolTask', Name: 'Extract Strm Media Info', State: 'Idle', LastExecutionResult: { Status: 'Completed', StartTimeUtc: 's', EndTimeUtc: 'e' } },
  ]),
  startScheduledTask: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('strmToolTurboModule.getStatus', () => {
  test('reports not installed when the plugin is absent', async () => {
    const adapter = buildAdapter({ listPlugins: jest.fn().mockResolvedValue([]) });
    await expect(strmToolTurbo.getStatus(adapter)).resolves.toEqual({ installed: false });
  });

  test('matches the dashless plugin id Jellyfin returns and reports version and status', async () => {
    const status = await strmToolTurbo.getStatus(buildAdapter());
    expect(status).toMatchObject({ installed: true, version: '1.0.0.0', pluginStatus: 'Active' });
  });

  test('maps the Jellyfin configuration to camelCase fields', async () => {
    const status = await strmToolTurbo.getStatus(buildAdapter());
    expect(status.config).toEqual({
      enableAutoExtract: false,
      enableMediaInfoCache: true,
      importExistingCacheWhenMissing: true,
      forceRefreshIgnoreExisting: false,
      forceRefreshIgnoreCache: false,
      refreshDelayMs: 5000,
      metadataRestoreTimeoutMinutes: 5,
      maxConcurrentExtract: 5,
    });
  });

  test('finds the extraction task by key and maps its last run', async () => {
    const status = await strmToolTurbo.getStatus(buildAdapter());
    expect(status.task).toEqual({
      id: 'task-1',
      name: 'Extract Strm Media Info',
      state: 'Idle',
      running: false,
      progressPercent: null,
      lastRun: { status: 'Completed', startedAt: 's', endedAt: 'e', error: null },
    });
  });

  test('falls back to a name match when the task key differs', async () => {
    const adapter = buildAdapter({
      listScheduledTasks: jest.fn().mockResolvedValue([{ Id: 't2', Key: 'Renamed', Name: '提取 Strm 媒体信息', State: 'Running', CurrentProgressPercentage: 42 }]),
    });
    const status = await strmToolTurbo.getStatus(adapter);
    expect(status.task).toMatchObject({ id: 't2', running: true, progressPercent: 42 });
  });

  test('skips config and task lookups when the plugin is not active', async () => {
    const adapter = buildAdapter({
      listPlugins: jest.fn().mockResolvedValue([{ Id: PLUGIN_ID, Version: '1.0.0.0', Status: 'Disabled' }]),
    });
    const status = await strmToolTurbo.getStatus(adapter);
    expect(status).toEqual({ installed: true, version: '1.0.0.0', pluginStatus: 'Disabled' });
    expect(adapter.getPluginConfiguration).not.toHaveBeenCalled();
  });
});

describe('strmToolTurboModule.saveConfiguration', () => {
  test('posts the full configuration with only the changed field replaced', async () => {
    const adapter = buildAdapter();
    await strmToolTurbo.saveConfiguration(adapter, { maxConcurrentExtract: 10 });
    expect(adapter.setPluginConfiguration).toHaveBeenCalledWith(PLUGIN_ID, { ...RAW_CONFIG, MaxConcurrentExtract: 10 });
  });

  test('returns the merged settings', async () => {
    const config = await strmToolTurbo.saveConfiguration(buildAdapter(), { enableAutoExtract: true });
    expect(config.enableAutoExtract).toBe(true);
  });

  test('rejects an unknown setting with 400', async () => {
    await expect(strmToolTurbo.saveConfiguration(buildAdapter(), { bogus: 1 })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('rejects a boolean field given a non-boolean with 400', async () => {
    await expect(strmToolTurbo.saveConfiguration(buildAdapter(), { enableAutoExtract: 'yes' })).rejects.toMatchObject({ statusCode: 400 });
  });

  test.each([
    ['maxConcurrentExtract', 0],
    ['maxConcurrentExtract', 51],
    ['refreshDelayMs', 10001],
    ['refreshDelayMs', -1],
    ['metadataRestoreTimeoutMinutes', 31],
    ['refreshDelayMs', 1.5],
  ])('rejects %s = %s as out of range', async (key, value) => {
    await expect(strmToolTurbo.saveConfiguration(buildAdapter(), { [key]: value })).rejects.toMatchObject({ statusCode: 400 });
  });

  test('does not write anything when validation fails', async () => {
    const adapter = buildAdapter();
    await expect(strmToolTurbo.saveConfiguration(adapter, { maxConcurrentExtract: 0 })).rejects.toBeDefined();
    expect(adapter.setPluginConfiguration).not.toHaveBeenCalled();
  });

  test('rejects with 404 when the plugin is not installed', async () => {
    const adapter = buildAdapter({ listPlugins: jest.fn().mockResolvedValue([]) });
    await expect(strmToolTurbo.saveConfiguration(adapter, { enableAutoExtract: true })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects with 409 when the plugin is not active', async () => {
    const adapter = buildAdapter({
      listPlugins: jest.fn().mockResolvedValue([{ Id: PLUGIN_ID, Status: 'Disabled' }]),
    });
    await expect(strmToolTurbo.saveConfiguration(adapter, { enableAutoExtract: true })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('writes back using the casing Jellyfin returned', async () => {
    const adapter = buildAdapter({ getPluginConfiguration: jest.fn().mockResolvedValue({ maxConcurrentExtract: 5 }) });
    await strmToolTurbo.saveConfiguration(adapter, { maxConcurrentExtract: 8 });
    expect(adapter.setPluginConfiguration).toHaveBeenCalledWith(PLUGIN_ID, { maxConcurrentExtract: 8 });
  });
});

describe('strmToolTurboModule.runExtraction', () => {
  test('starts the extraction task by its Jellyfin id', async () => {
    const adapter = buildAdapter();
    await strmToolTurbo.runExtraction(adapter);
    expect(adapter.startScheduledTask).toHaveBeenCalledWith('task-1');
  });

  test('rejects with 409 when the task is already running', async () => {
    const adapter = buildAdapter({
      listScheduledTasks: jest.fn().mockResolvedValue([{ Id: 'task-1', Key: 'StrmToolTask', State: 'Running' }]),
    });
    await expect(strmToolTurbo.runExtraction(adapter)).rejects.toMatchObject({ statusCode: 409 });
    expect(adapter.startScheduledTask).not.toHaveBeenCalled();
  });

  test('rejects with 404 when the task cannot be found', async () => {
    const adapter = buildAdapter({ listScheduledTasks: jest.fn().mockResolvedValue([]) });
    await expect(strmToolTurbo.runExtraction(adapter)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('rejects with 404 when the plugin is not installed', async () => {
    const adapter = buildAdapter({ listPlugins: jest.fn().mockResolvedValue([]) });
    await expect(strmToolTurbo.runExtraction(adapter)).rejects.toMatchObject({ statusCode: 404 });
  });
});
