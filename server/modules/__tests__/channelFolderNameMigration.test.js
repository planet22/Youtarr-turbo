/* eslint-env jest */

jest.mock('../../logger');

describe('ChannelFolderNameMigration', () => {
  let migration;
  let Channel;
  let channelModule;
  let logger;

  const channel = (id, { folderNameAfter = 'Folder', reloadError = null } = {}) => {
    const c = {
      id,
      channel_id: `UC${id}`,
      uploader: `Uploader ${id}`,
      folder_name: null,
      reload: jest.fn(async () => {
        if (reloadError) throw reloadError;
        c.folder_name = folderNameAfter;
      }),
    };
    return c;
  };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    Channel = { findAll: jest.fn().mockResolvedValue([]) };
    channelModule = { resolveChannelFolderName: jest.fn().mockResolvedValue(undefined) };
    jest.doMock('../../models/channel', () => Channel);
    jest.doMock('../channelModule', () => channelModule);

    logger = require('../../logger');
    migration = require('../channelFolderNameMigration');
  });

  it('only looks at channels that have no folder name yet', async () => {
    await migration.migrateExistingChannels();

    expect(Channel.findAll).toHaveBeenCalledWith({
      where: { folder_name: null },
      attributes: ['id', 'channel_id', 'uploader', 'folder_name'],
    });
  });

  it('does nothing when every channel already has a folder name', async () => {
    await expect(migration.migrateExistingChannels()).resolves.toEqual({ migrated: 0, failed: 0 });

    expect(channelModule.resolveChannelFolderName).not.toHaveBeenCalled();
  });

  it('resolves the folder name of each channel and counts the successes', async () => {
    const channels = [channel(1), channel(2)];
    Channel.findAll.mockResolvedValue(channels);

    const result = await migration.migrateExistingChannels();

    expect(result).toEqual({ migrated: 2, failed: 0 });
    expect(channelModule.resolveChannelFolderName.mock.calls.map(([c]) => c)).toEqual(channels);
  });

  it('reloads each channel to see whether the folder name was saved', async () => {
    const c = channel(1);
    Channel.findAll.mockResolvedValue([c]);

    await migration.migrateExistingChannels();

    expect(c.reload).toHaveBeenCalledTimes(1);
  });

  it('counts a channel whose folder name could not be determined as failed', async () => {
    Channel.findAll.mockResolvedValue([channel(1, { folderNameAfter: null })]);

    const result = await migration.migrateExistingChannels();

    expect(result).toEqual({ migrated: 0, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith({ channelId: 'UC1', uploader: 'Uploader 1' }, 'Could not get folder_name from yt-dlp');
  });

  it('counts a channel whose resolution throws as failed and carries on with the rest', async () => {
    Channel.findAll.mockResolvedValue([channel(1), channel(2)]);
    channelModule.resolveChannelFolderName.mockRejectedValueOnce(new Error('yt-dlp crashed')).mockResolvedValue(undefined);

    const result = await migration.migrateExistingChannels();

    expect(result).toEqual({ migrated: 1, failed: 1 });
    expect(logger.error).toHaveBeenCalledWith({ err: 'yt-dlp crashed', channelId: 'UC1' }, 'Error migrating folder_name for channel');
  });

  it('counts a channel whose reload throws as failed', async () => {
    Channel.findAll.mockResolvedValue([channel(1, { reloadError: new Error('gone') })]);

    await expect(migration.migrateExistingChannels()).resolves.toEqual({ migrated: 0, failed: 1 });
  });

  it('processes channels one at a time', async () => {
    const order = [];
    channelModule.resolveChannelFolderName.mockImplementation(async (c) => {
      order.push(`start ${c.id}`);
      await Promise.resolve();
      order.push(`end ${c.id}`);
    });
    Channel.findAll.mockResolvedValue([channel(1), channel(2)]);

    await migration.migrateExistingChannels();

    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('logs a summary with the totals', async () => {
    Channel.findAll.mockResolvedValue([channel(1), channel(2, { folderNameAfter: null })]);

    await migration.migrateExistingChannels();

    expect(logger.info).toHaveBeenCalledWith({ migrated: 1, failed: 1, total: 2 }, 'Completed folder_name migration for existing channels');
  });

  it('propagates a failure to read the channels', async () => {
    Channel.findAll.mockRejectedValue(new Error('db down'));

    await expect(migration.migrateExistingChannels()).rejects.toThrow('db down');
  });
});
