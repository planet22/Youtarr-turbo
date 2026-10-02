// User profiles: a named folder under <output>/__profiles__/ (optionally tied
// to a Jellyfin user + library) that receives hardlinks of every downloaded
// video from the channels and playlists the profile subscribes to. Videos are
// downloaded once; each profile gets its own links.
const { Op } = require('sequelize');
const logger = require('../../logger');
const { sequelize } = require('../../db');
const configModule = require('../configModule');
const JellyfinAdapter = require('../mediaServers/adapters/jellyfinAdapter');
const { validateSubFolderName } = require('../filesystem/subfolderValidation');
const { Profile, ProfileSubscription, ProfileVideoLink, Video, PlaylistVideo, Channel, Playlist } = require('../../models');
const profileLinker = require('./profileLinker');
const { profileRootPath } = require('./profilePaths');

const SOURCE_TYPES = Object.freeze({ CHANNEL: 'channel', PLAYLIST: 'playlist' });
const MAX_NAME_LENGTH = 100;

function makeError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parsePaths(row) {
  try {
    const parsed = JSON.parse(row.link_paths);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasLibraryFile(video) {
  return !!video && !video.removed && !!(video.filePath || video.audioFilePath);
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { valid: false, error: 'Profile name is required' };
  }
  if (name.trim().length > MAX_NAME_LENGTH) {
    return { valid: false, error: `Profile name must be ${MAX_NAME_LENGTH} characters or less` };
  }
  const result = validateSubFolderName(name.trim());
  return result.valid ? result : { valid: false, error: result.error.replace(/Subfolder/g, 'Profile') };
}

class ProfileModule {
  constructor() {
    this.SOURCE_TYPES = SOURCE_TYPES;
  }

  _baseDir() {
    return configModule.directoryPath;
  }

  _serialize(profile, counts = {}) {
    return {
      id: profile.id,
      name: profile.name,
      jellyfinUserId: profile.jellyfin_user_id,
      jellyfinUserName: profile.jellyfin_user_name,
      jellyfinLibraryId: profile.jellyfin_library_id,
      folderPath: profileRootPath(this._baseDir(), profile.name),
      channelCount: counts.channels || 0,
      playlistCount: counts.playlists || 0,
      videoCount: counts.videos || 0,
    };
  }

  async _getProfileOr404(id) {
    const profile = await Profile.findByPk(id);
    if (!profile) throw makeError('Profile not found', 404);
    return profile;
  }

  async _assertNameAvailable(name, exceptId = null) {
    const existing = await Profile.findOne({ where: { name } });
    if (existing && existing.id !== exceptId) {
      throw makeError('A profile with that name already exists', 409);
    }
  }

  async list() {
    const [profiles, subs, links] = await Promise.all([
      Profile.findAll({ order: [['name', 'ASC']] }),
      ProfileSubscription.findAll({ attributes: ['profile_id', 'source_type'], raw: true }),
      ProfileVideoLink.findAll({ attributes: ['profile_id'], raw: true }),
    ]);
    const counts = new Map(profiles.map((p) => [p.id, { channels: 0, playlists: 0, videos: 0 }]));
    for (const sub of subs) {
      const c = counts.get(sub.profile_id);
      if (!c) continue;
      if (sub.source_type === SOURCE_TYPES.CHANNEL) c.channels += 1;
      if (sub.source_type === SOURCE_TYPES.PLAYLIST) c.playlists += 1;
    }
    for (const link of links) {
      const c = counts.get(link.profile_id);
      if (c) c.videos += 1;
    }
    return profiles.map((p) => this._serialize(p, counts.get(p.id)));
  }

  async create({ name, jellyfinUserId = null, jellyfinUserName = null, jellyfinLibraryId = null }) {
    const validation = validateName(name);
    if (!validation.valid) throw makeError(validation.error, 400);
    const clean = name.trim();
    await this._assertNameAvailable(clean);

    const profile = await Profile.create({
      name: clean,
      jellyfin_user_id: jellyfinUserId || null,
      jellyfin_user_name: jellyfinUserName || null,
      jellyfin_library_id: jellyfinLibraryId || null,
    });
    await profileLinker.ensureProfileRoot(this._baseDir(), clean);
    return this._serialize(profile);
  }

  async update(id, fields) {
    const profile = await this._getProfileOr404(id);
    const updates = {};

    if (fields.name !== undefined && fields.name.trim() !== profile.name) {
      const validation = validateName(fields.name);
      if (!validation.valid) throw makeError(validation.error, 400);
      const newName = fields.name.trim();
      await this._assertNameAvailable(newName, profile.id);
      await this._renameFolder(profile, newName);
      updates.name = newName;
    }
    if (fields.jellyfinUserId !== undefined) updates.jellyfin_user_id = fields.jellyfinUserId || null;
    if (fields.jellyfinUserName !== undefined) updates.jellyfin_user_name = fields.jellyfinUserName || null;
    if (fields.jellyfinLibraryId !== undefined) updates.jellyfin_library_id = fields.jellyfinLibraryId || null;

    await profile.update(updates);
    const [profileView] = (await this.list()).filter((p) => p.id === profile.id);
    return profileView;
  }

  async _renameFolder(profile, newName) {
    const baseDir = this._baseDir();
    const oldRoot = profileRootPath(baseDir, profile.name);
    const newRoot = profileRootPath(baseDir, newName);
    await profileLinker.renameProfileRoot(baseDir, profile.name, newName);

    const rows = await ProfileVideoLink.findAll({ where: { profile_id: profile.id } });
    await sequelize.transaction(async (transaction) => {
      for (const row of rows) {
        const moved = parsePaths(row).map((p) => (p.startsWith(oldRoot) ? newRoot + p.slice(oldRoot.length) : p));
        await row.update({ link_paths: JSON.stringify(moved) }, { transaction });
      }
    });
  }

  async remove(id) {
    const profile = await this._getProfileOr404(id);
    await profileLinker.removeProfileRoot(this._baseDir(), profile.name);
    await sequelize.transaction(async (transaction) => {
      await ProfileVideoLink.destroy({ where: { profile_id: profile.id }, transaction });
      await ProfileSubscription.destroy({ where: { profile_id: profile.id }, transaction });
      await profile.destroy({ transaction });
    });
  }

  async getSubscriptions(id) {
    await this._getProfileOr404(id);
    const subs = await ProfileSubscription.findAll({ where: { profile_id: id }, raw: true });
    return {
      channels: subs.filter((s) => s.source_type === SOURCE_TYPES.CHANNEL).map((s) => s.source_id),
      playlists: subs.filter((s) => s.source_type === SOURCE_TYPES.PLAYLIST).map((s) => s.source_id),
    };
  }

  /**
   * Replace the profile's subscriptions, then link/unlink videos to match.
   * @returns {Promise<{linked:number, unlinked:number, failed:number}>}
   */
  async setSubscriptions(id, { channels = [], playlists = [] }) {
    const profile = await this._getProfileOr404(id);
    const rows = [
      ...[...new Set(channels)].map((sourceId) => ({ profile_id: profile.id, source_type: SOURCE_TYPES.CHANNEL, source_id: sourceId })),
      ...[...new Set(playlists)].map((sourceId) => ({ profile_id: profile.id, source_type: SOURCE_TYPES.PLAYLIST, source_id: sourceId })),
    ];
    await sequelize.transaction(async (transaction) => {
      await ProfileSubscription.destroy({ where: { profile_id: profile.id }, transaction });
      if (rows.length > 0) await ProfileSubscription.bulkCreate(rows, { transaction });
    });
    return this.reconcile(profile.id);
  }

  async _desiredVideos(profileId) {
    const subs = await ProfileSubscription.findAll({ where: { profile_id: profileId }, raw: true });
    const channelIds = subs.filter((s) => s.source_type === SOURCE_TYPES.CHANNEL).map((s) => s.source_id);
    const playlistIds = subs.filter((s) => s.source_type === SOURCE_TYPES.PLAYLIST).map((s) => s.source_id);

    const sources = [];
    if (channelIds.length > 0) sources.push({ channel_id: channelIds });
    if (playlistIds.length > 0) {
      const members = await PlaylistVideo.findAll({ where: { playlist_id: playlistIds }, attributes: ['youtube_id'], raw: true });
      if (members.length > 0) sources.push({ youtubeId: [...new Set(members.map((m) => m.youtube_id))] });
    }
    if (sources.length === 0) return [];

    return Video.findAll({
      where: {
        [Op.and]: [
          { removed: false },
          { [Op.or]: [{ filePath: { [Op.ne]: null } }, { audioFilePath: { [Op.ne]: null } }] },
          { [Op.or]: sources },
        ],
      },
    });
  }

  /**
   * Bring one profile's links in line with its subscriptions.
   * @returns {Promise<{linked:number, unlinked:number, failed:number}>}
   */
  async reconcile(profileId) {
    const profile = await this._getProfileOr404(profileId);
    const baseDir = this._baseDir();
    const [desired, existing] = await Promise.all([
      this._desiredVideos(profile.id),
      ProfileVideoLink.findAll({ where: { profile_id: profile.id } }),
    ]);
    const existingByVideo = new Map(existing.map((row) => [row.video_id, row]));
    const desiredIds = new Set(desired.map((v) => v.id));
    const result = { linked: 0, unlinked: 0, failed: 0 };

    for (const row of existing) {
      if (desiredIds.has(row.video_id)) continue;
      try {
        await profileLinker.unlinkPaths(baseDir, profile.name, parsePaths(row));
        await row.destroy();
        result.unlinked += 1;
      } catch (err) {
        result.failed += 1;
        logger.error({ err, profileId: profile.id, videoId: row.video_id }, 'profiles: failed to unlink video');
      }
    }

    for (const video of desired) {
      try {
        const changed = await this._linkVideoToProfile(baseDir, profile, video, existingByVideo.get(video.id));
        if (changed) result.linked += 1;
      } catch (err) {
        result.failed += 1;
        logger.error({ err, profileId: profile.id, youtubeId: video.youtubeId }, 'profiles: failed to link video');
      }
    }

    if (result.linked > 0 || result.unlinked > 0) this._refreshLibraries([profile]);
    logger.info({ profileId: profile.id, ...result }, 'profiles: reconciled profile links');
    return result;
  }

  /** @returns {Promise<boolean>} true when the video was newly linked */
  async _linkVideoToProfile(baseDir, profile, video, row) {
    const paths = await profileLinker.linkVideo(baseDir, profile.name, video);
    const previous = row ? parsePaths(row) : [];
    const stale = previous.filter((p) => !paths.includes(p));
    if (stale.length > 0) await profileLinker.unlinkPaths(baseDir, profile.name, stale);

    if (paths.length === 0) {
      if (row) await row.destroy();
      return false;
    }
    if (row) {
      await row.update({ link_paths: JSON.stringify(paths) });
      return false;
    }
    await ProfileVideoLink.create({
      profile_id: profile.id,
      video_id: video.id,
      youtube_id: video.youtubeId,
      link_paths: JSON.stringify(paths),
    });
    return true;
  }

  async _profileIdsWanting(video, subs) {
    const ids = new Set();
    for (const sub of subs) {
      if (sub.source_type === SOURCE_TYPES.CHANNEL && video.channel_id && sub.source_id === video.channel_id) {
        ids.add(sub.profile_id);
      }
    }
    const playlistSubs = subs.filter((s) => s.source_type === SOURCE_TYPES.PLAYLIST);
    if (playlistSubs.length > 0) {
      const memberships = await PlaylistVideo.findAll({ where: { youtube_id: video.youtubeId }, attributes: ['playlist_id'], raw: true });
      const playlistIds = new Set(memberships.map((m) => m.playlist_id));
      for (const sub of playlistSubs) {
        if (playlistIds.has(sub.source_id)) ids.add(sub.profile_id);
      }
    }
    return ids;
  }

  /**
   * Make every profile's links for one video match the library: link it into
   * profiles that want it, refresh links after a re-download, and remove
   * links once the video is deleted. Never throws.
   * @param {object|number} videoOrId - Video instance or Video.id
   * @returns {Promise<number[]>} ids of profiles whose links changed
   */
  async syncVideo(videoOrId, context = null) {
    try {
      const video = typeof videoOrId === 'number' ? await Video.findByPk(videoOrId) : videoOrId;
      if (!video) return [];
      const ctx = context || await this._loadContext();
      const rows = await ProfileVideoLink.findAll({ where: { video_id: video.id } });
      if (rows.length === 0 && ctx.subs.length === 0) return [];

      const baseDir = this._baseDir();
      const wanted = hasLibraryFile(video) ? await this._profileIdsWanting(video, ctx.subs) : new Set();
      const rowsByProfile = new Map(rows.map((r) => [r.profile_id, r]));
      const touched = [];

      for (const profileId of new Set([...wanted, ...rowsByProfile.keys()])) {
        const profile = ctx.profilesById.get(profileId);
        const row = rowsByProfile.get(profileId);
        try {
          if (!profile) {
            if (row) await row.destroy();
            continue;
          }
          if (wanted.has(profileId)) {
            await this._linkVideoToProfile(baseDir, profile, video, row);
          } else if (row) {
            await profileLinker.unlinkPaths(baseDir, profile.name, parsePaths(row));
            await row.destroy();
          }
          touched.push(profileId);
        } catch (err) {
          logger.error({ err, profileId, youtubeId: video.youtubeId }, 'profiles: failed to sync video links');
        }
      }
      return touched;
    } catch (err) {
      logger.error({ err }, 'profiles: syncVideo failed');
      return [];
    }
  }

  async _loadContext() {
    const [subs, profiles] = await Promise.all([
      ProfileSubscription.findAll({ raw: true }),
      Profile.findAll(),
    ]);
    return { subs, profilesById: new Map(profiles.map((p) => [p.id, p])) };
  }

  /**
   * Called after a download batch: link the new files into subscribing profiles.
   * @param {string[]} youtubeIds
   */
  async syncDownloadedVideos(youtubeIds) {
    if (!Array.isArray(youtubeIds) || youtubeIds.length === 0) return;
    const ctx = await this._loadContext();
    if (ctx.profilesById.size === 0) return;

    const videos = await Video.findAll({ where: { youtubeId: youtubeIds } });
    const touched = new Set();
    for (const video of videos) {
      (await this.syncVideo(video, ctx)).forEach((id) => touched.add(id));
    }
    this._refreshLibraries([...touched].map((id) => ctx.profilesById.get(id)).filter(Boolean));
  }

  _jellyfinAdapter() {
    const config = configModule.getConfig();
    if (!config.jellyfinEnabled || !config.jellyfinUrl || !config.jellyfinApiKey) return null;
    return new JellyfinAdapter(config);
  }

  /** Fire-and-forget refresh of each profile's own Jellyfin library. */
  _refreshLibraries(profiles) {
    const libraryIds = [...new Set(profiles.map((p) => p.jellyfin_library_id).filter(Boolean))];
    if (libraryIds.length === 0) return;
    const adapter = this._jellyfinAdapter();
    if (!adapter) return;
    for (const libraryId of libraryIds) {
      adapter.refreshLibraryById(libraryId).catch((err) => {
        logger.warn({ err: err.message, libraryId }, 'profiles: Jellyfin library refresh failed');
      });
    }
  }

  /** Every subscribed channel and playlist, for the profile subscription picker. */
  async listSources() {
    const [channels, playlists] = await Promise.all([
      Channel.findAll({ where: { enabled: true }, attributes: ['channel_id', 'title', 'uploader'], order: [['title', 'ASC']], raw: true }),
      Playlist.findAll({ where: { enabled: true }, attributes: ['playlist_id', 'title'], order: [['title', 'ASC']], raw: true }),
    ]);
    return {
      channels: channels
        .filter((c) => c.channel_id)
        .map((c) => ({ id: c.channel_id, title: c.title || c.uploader || c.channel_id })),
      playlists: playlists.map((p) => ({ id: p.playlist_id, title: p.title || p.playlist_id })),
    };
  }

  async listJellyfinUsers() {
    const adapter = this._jellyfinAdapter();
    if (!adapter) throw makeError('Jellyfin is not configured', 409);
    return adapter.listUsers();
  }

  async listJellyfinLibraries() {
    const adapter = this._jellyfinAdapter();
    if (!adapter) throw makeError('Jellyfin is not configured', 409);
    return adapter.listLibraries();
  }
}

module.exports = new ProfileModule();
