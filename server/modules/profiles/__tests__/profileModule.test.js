/* eslint-env jest */
const path = require('path');

jest.mock('../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../../../db', () => ({ sequelize: { transaction: jest.fn((fn) => fn('tx')) } }));
jest.mock('../../configModule', () => ({
  directoryPath: '/data',
  getConfig: jest.fn(() => ({})),
}));
jest.mock('../../mediaServers/adapters/jellyfinAdapter', () => jest.fn());
jest.mock('../../../models', () => ({
  Profile: { findAll: jest.fn(), findByPk: jest.fn(), findOne: jest.fn(), create: jest.fn() },
  ProfileSubscription: { findAll: jest.fn(), destroy: jest.fn(), bulkCreate: jest.fn() },
  ProfileVideoLink: { findAll: jest.fn(), create: jest.fn(), destroy: jest.fn() },
  Video: { findAll: jest.fn(), findByPk: jest.fn() },
  PlaylistVideo: { findAll: jest.fn() },
  Channel: { findAll: jest.fn() },
  Playlist: { findAll: jest.fn() },
  VideoWatchStatus: { findAll: jest.fn() },
}));
jest.mock('../../mediaServers/mediaServerSync', () => ({
  syncPlaylist: jest.fn(),
  removeProfileCopies: jest.fn(),
}));
jest.mock('../profileLinker', () => ({
  linkVideo: jest.fn(),
  unlinkPaths: jest.fn(),
  ensureProfileRoot: jest.fn(),
  renameProfileRoot: jest.fn(),
  removeProfileRoot: jest.fn(),
}));

function makeProfile(overrides = {}) {
  return {
    id: 1,
    name: 'Alice',
    jellyfin_user_id: null,
    jellyfin_user_name: null,
    jellyfin_library_id: null,
    update: jest.fn(),
    destroy: jest.fn(),
    ...overrides,
  };
}

function makeLinkRow(overrides = {}) {
  return {
    profile_id: 1,
    video_id: 10,
    link_paths: JSON.stringify(['/data/__profiles__/Alice/Chan/v [abc123def45].mp4']),
    update: jest.fn(),
    destroy: jest.fn(),
    ...overrides,
  };
}

const VIDEO = { id: 10, youtubeId: 'abc123def45', channel_id: 'UC1', filePath: '/data/Chan/v [abc123def45].mp4', removed: false };

describe('profileModule', () => {
  let profileModule;
  let models;
  let profileLinker;
  let configModule;
  let JellyfinAdapter;
  let mediaServerSync;

  // Fire-and-forget work (playlist syncs) settles on later ticks.
  async function waitFor(condition) {
    for (let i = 0; i < 20 && !condition(); i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    models = require('../../../models');
    profileLinker = require('../profileLinker');
    configModule = require('../../configModule');
    JellyfinAdapter = require('../../mediaServers/adapters/jellyfinAdapter');
    profileModule = require('../profileModule');

    models.ProfileSubscription.findAll.mockResolvedValue([]);
    models.ProfileVideoLink.findAll.mockResolvedValue([]);
    models.PlaylistVideo.findAll.mockResolvedValue([]);
    models.Profile.findAll.mockResolvedValue([]);
    models.Playlist.findAll.mockResolvedValue([]);
    profileLinker.linkVideo.mockResolvedValue(['/data/__profiles__/Alice/Chan/v [abc123def45].mp4']);
    mediaServerSync = require('../../mediaServers/mediaServerSync');
    mediaServerSync.syncPlaylist.mockResolvedValue(undefined);
    mediaServerSync.removeProfileCopies.mockResolvedValue(undefined);
  });

  describe('Jellyfin playlist copies', () => {
    test('changing the Jellyfin user removes the old user\'s playlist copies', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile({ jellyfin_user_id: 'u-old' }));
      await profileModule.update(1, { jellyfinUserId: 'u-new' });
      expect(mediaServerSync.removeProfileCopies).toHaveBeenCalledWith(1);
    });

    test('keeping the same Jellyfin user leaves the copies alone', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile({ jellyfin_user_id: 'u1' }));
      await profileModule.update(1, { jellyfinUserId: 'u1' });
      expect(mediaServerSync.removeProfileCopies).not.toHaveBeenCalled();
    });

    test('deleting a profile removes its playlist copies', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile());
      await profileModule.remove(1);
      expect(mediaServerSync.removeProfileCopies).toHaveBeenCalledWith(1);
    });

    test('following a new playlist syncs it to the media servers', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile());
      models.Playlist.findAll.mockResolvedValue([{ id: 42 }]);
      await profileModule.setSubscriptions(1, { playlists: ['PL1'] });
      await waitFor(() => mediaServerSync.syncPlaylist.mock.calls.length > 0);
      expect(mediaServerSync.syncPlaylist).toHaveBeenCalledWith(42);
    });
  });

  describe('remove watched after days', () => {
    test('create rejects a zero day count with status 400', async () => {
      await expect(profileModule.create({ name: 'Alice', removeWatchedAfterDays: 0 })).rejects.toMatchObject({ status: 400 });
    });

    test('update stores a valid day count', async () => {
      const profile = makeProfile();
      models.Profile.findByPk.mockResolvedValue(profile);
      await profileModule.update(1, { removeWatchedAfterDays: 14 });
      expect(profile.update).toHaveBeenCalledWith({ remove_watched_after_days: 14 });
    });

    test('removeWatchedLinks unlinks a watched video and marks it dismissed', async () => {
      const row = makeLinkRow();
      models.Profile.findAll.mockResolvedValue([makeProfile({ remove_watched_after_days: 7, jellyfin_user_id: 'u1' })]);
      models.VideoWatchStatus.findAll.mockResolvedValue([{ video_id: 10 }]);
      models.Video.findAll.mockResolvedValue([{ id: 10 }]);
      models.ProfileVideoLink.findAll.mockResolvedValue([row]);

      const result = await profileModule.removeWatchedLinks();

      expect(result).toEqual({ profiles: 1, removed: 1, failed: 0 });
      expect(row.update).toHaveBeenCalledWith({ link_paths: '[]', dismissed_at: expect.any(Date) });
    });

    test('removeWatchedLinks skips protected videos', async () => {
      models.Profile.findAll.mockResolvedValue([makeProfile({ remove_watched_after_days: 7, jellyfin_user_id: 'u1' })]);
      models.VideoWatchStatus.findAll.mockResolvedValue([{ video_id: 10 }]);
      models.Video.findAll.mockResolvedValue([]);
      models.ProfileVideoLink.findAll.mockResolvedValue([]);

      await profileModule.removeWatchedLinks();

      expect(models.ProfileVideoLink.findAll).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ video_id: [] }),
      }));
    });

    test('a dismissed video is not linked again by reconcile', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile());
      models.ProfileSubscription.findAll.mockResolvedValue([{ profile_id: 1, source_type: 'channel', source_id: 'UC1' }]);
      models.Video.findAll.mockResolvedValue([VIDEO]);
      models.ProfileVideoLink.findAll.mockResolvedValue([makeLinkRow({ dismissed_at: new Date(), link_paths: '[]' })]);

      await profileModule.reconcile(1);

      expect(profileLinker.linkVideo).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    test('rejects an empty name with status 400', async () => {
      await expect(profileModule.create({ name: '  ' })).rejects.toMatchObject({ status: 400 });
    });

    test('rejects a name with path characters with status 400', async () => {
      await expect(profileModule.create({ name: '../etc' })).rejects.toMatchObject({ status: 400 });
    });

    test('rejects a duplicate name with status 409', async () => {
      models.Profile.findOne.mockResolvedValue(makeProfile());
      await expect(profileModule.create({ name: 'Alice' })).rejects.toMatchObject({ status: 409 });
    });

    test('creates the profile folder', async () => {
      models.Profile.findOne.mockResolvedValue(null);
      models.Profile.create.mockResolvedValue(makeProfile());
      await profileModule.create({ name: ' Alice ' });
      expect(profileLinker.ensureProfileRoot).toHaveBeenCalledWith('/data', 'Alice');
    });
  });

  describe('list', () => {
    test('counts subscriptions and linked videos per profile', async () => {
      models.Profile.findAll.mockResolvedValue([makeProfile()]);
      models.ProfileSubscription.findAll.mockResolvedValue([
        { profile_id: 1, source_type: 'channel' },
        { profile_id: 1, source_type: 'playlist' },
        { profile_id: 1, source_type: 'channel' },
      ]);
      models.ProfileVideoLink.findAll.mockResolvedValue([{ profile_id: 1 }]);
      const [profile] = await profileModule.list();
      expect(profile).toMatchObject({ channelCount: 2, playlistCount: 1, videoCount: 1 });
    });
  });

  describe('update', () => {
    test('renames the profile folder when the name changes', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile());
      models.Profile.findOne.mockResolvedValue(null);
      await profileModule.update(1, { name: 'Bob' });
      expect(profileLinker.renameProfileRoot).toHaveBeenCalledWith('/data', 'Alice', 'Bob');
    });

    test('rewrites stored link paths to the new folder', async () => {
      const linkUnder = (name) => path.join('/data', '__profiles__', name, 'Chan', 'v [abc123def45].mp4');
      const row = makeLinkRow({ link_paths: JSON.stringify([linkUnder('Alice')]) });
      models.Profile.findByPk.mockResolvedValue(makeProfile());
      models.Profile.findOne.mockResolvedValue(null);
      models.ProfileVideoLink.findAll.mockResolvedValue([row]);
      await profileModule.update(1, { name: 'Bob' });
      expect(row.update).toHaveBeenCalledWith(
        { link_paths: JSON.stringify([linkUnder('Bob')]) },
        { transaction: 'tx' }
      );
    });

    test('returns 404 for an unknown profile', async () => {
      models.Profile.findByPk.mockResolvedValue(null);
      await expect(profileModule.update(9, {})).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('setSubscriptions / reconcile', () => {
    beforeEach(() => {
      models.Profile.findByPk.mockResolvedValue(makeProfile());
    });

    test('stores deduplicated channel and playlist subscriptions', async () => {
      await profileModule.setSubscriptions(1, { channels: ['UC1', 'UC1'], playlists: ['PL1'] });
      expect(models.ProfileSubscription.bulkCreate).toHaveBeenCalledWith([
        { profile_id: 1, source_type: 'channel', source_id: 'UC1' },
        { profile_id: 1, source_type: 'playlist', source_id: 'PL1' },
      ], { transaction: 'tx' });
    });

    test('links a subscribed video that is not linked yet', async () => {
      models.ProfileSubscription.findAll.mockResolvedValue([{ profile_id: 1, source_type: 'channel', source_id: 'UC1' }]);
      models.Video.findAll.mockResolvedValue([VIDEO]);
      const result = await profileModule.reconcile(1);
      expect(result).toEqual({ linked: 1, unlinked: 0, failed: 0 });
    });

    test('unlinks a video that is no longer subscribed', async () => {
      const row = makeLinkRow();
      models.ProfileVideoLink.findAll.mockResolvedValue([row]);
      const result = await profileModule.reconcile(1);
      expect(result).toEqual({ linked: 0, unlinked: 1, failed: 0 });
    });

    test('does not query videos when the profile has no subscriptions', async () => {
      await profileModule.reconcile(1);
      expect(models.Video.findAll).not.toHaveBeenCalled();
    });

    test('counts a link failure without aborting the rest', async () => {
      models.ProfileSubscription.findAll.mockResolvedValue([{ profile_id: 1, source_type: 'channel', source_id: 'UC1' }]);
      models.Video.findAll.mockResolvedValue([VIDEO, { ...VIDEO, id: 11, youtubeId: 'zzz999yyy88' }]);
      profileLinker.linkVideo.mockRejectedValueOnce(new Error('EPERM'));
      const result = await profileModule.reconcile(1);
      expect(result).toEqual({ linked: 1, unlinked: 0, failed: 1 });
    });
  });

  describe('addSubscriptions', () => {
    test('adds new sources without removing existing ones', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile());
      await profileModule.addSubscriptions(1, { channels: ['UC9'], playlists: [] });
      expect(models.ProfileSubscription.destroy).not.toHaveBeenCalled();
    });

    test('ignores sources the profile already follows', async () => {
      models.Profile.findByPk.mockResolvedValue(makeProfile());
      await profileModule.addSubscriptions(1, { channels: ['UC9'] });
      expect(models.ProfileSubscription.bulkCreate).toHaveBeenCalledWith(
        [{ profile_id: 1, source_type: 'channel', source_id: 'UC9' }],
        { ignoreDuplicates: true }
      );
    });
  });

  describe('syncVideo', () => {
    test('links a video into a profile subscribed to one of its playlists', async () => {
      const profile = makeProfile();
      models.PlaylistVideo.findAll.mockResolvedValue([{ playlist_id: 'PL1' }]);
      const ctx = { subs: [{ profile_id: 1, source_type: 'playlist', source_id: 'PL1' }], profilesById: new Map([[1, profile]]) };
      await profileModule.syncVideo(VIDEO, ctx);
      expect(profileLinker.linkVideo).toHaveBeenCalledWith('/data', 'Alice', VIDEO);
    });

    test('removes links of a deleted video', async () => {
      const row = makeLinkRow();
      models.ProfileVideoLink.findAll.mockResolvedValue([row]);
      const ctx = { subs: [{ profile_id: 1, source_type: 'channel', source_id: 'UC1' }], profilesById: new Map([[1, makeProfile()]]) };
      await profileModule.syncVideo({ ...VIDEO, removed: true }, ctx);
      expect(row.destroy).toHaveBeenCalled();
    });

    test('never throws when the database fails', async () => {
      models.ProfileVideoLink.findAll.mockRejectedValue(new Error('db down'));
      await expect(profileModule.syncVideo(VIDEO, { subs: [], profilesById: new Map() })).resolves.toEqual([]);
    });
  });

  describe('syncDownloadedVideos', () => {
    test('does nothing when no profiles exist', async () => {
      await profileModule.syncDownloadedVideos(['abc123def45']);
      expect(models.Video.findAll).not.toHaveBeenCalled();
    });

    test('refreshes the Jellyfin library of a profile that received a link', async () => {
      const refreshLibraryById = jest.fn().mockResolvedValue(undefined);
      JellyfinAdapter.mockImplementation(() => ({ refreshLibraryById }));
      configModule.getConfig.mockReturnValue({ jellyfinEnabled: true, jellyfinUrl: 'http://jf', jellyfinApiKey: 'k' });
      models.Profile.findAll.mockResolvedValue([makeProfile({ jellyfin_library_id: 'lib1' })]);
      models.ProfileSubscription.findAll.mockResolvedValue([{ profile_id: 1, source_type: 'channel', source_id: 'UC1' }]);
      models.Video.findAll.mockResolvedValue([VIDEO]);
      await profileModule.syncDownloadedVideos(['abc123def45']);
      expect(refreshLibraryById).toHaveBeenCalledWith('lib1');
    });
  });

  describe('listSources', () => {
    test('falls back to the uploader when a channel has no title', async () => {
      models.Channel.findAll.mockResolvedValue([{ channel_id: 'UC1', title: null, uploader: 'Uploader' }]);
      models.Playlist.findAll.mockResolvedValue([]);
      const sources = await profileModule.listSources();
      expect(sources.channels).toEqual([{ id: 'UC1', title: 'Uploader' }]);
    });

    test('skips channels without a YouTube channel id', async () => {
      models.Channel.findAll.mockResolvedValue([{ channel_id: null, title: 'Broken' }]);
      models.Playlist.findAll.mockResolvedValue([{ playlist_id: 'PL1', title: 'Mix' }]);
      const sources = await profileModule.listSources();
      expect(sources).toEqual({ channels: [], playlists: [{ id: 'PL1', title: 'Mix' }] });
    });
  });

  describe('listJellyfinUsers', () => {
    test('rejects with 409 when Jellyfin is not configured', async () => {
      await expect(profileModule.listJellyfinUsers()).rejects.toMatchObject({ status: 409 });
    });
  });
});
