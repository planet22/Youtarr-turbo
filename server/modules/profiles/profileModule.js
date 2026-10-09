// User profiles: a named folder under <output>/__profiles__/ (optionally tied
// to a Jellyfin user + library) that receives hardlinks of every downloaded
// video from the channels and playlists the profile subscribes to. Videos are
// downloaded once; each profile gets its own links.
const path = require('path');
const { Op } = require('sequelize');
const logger = require('../../logger');
const { sequelize } = require('../../db');
const configModule = require('../configModule');
const plexModule = require('../plexModule');
const JellyfinAdapter = require('../mediaServers/adapters/jellyfinAdapter');
const PlexAdapter = require('../mediaServers/adapters/plexAdapter');
const { validateSubFolderName } = require('../filesystem/subfolderValidation');
const mediaServerSync = require('../mediaServers/mediaServerSync');
const { Profile, ProfileSubscription, ProfileVideoLink, Video, PlaylistVideo, Channel, Playlist, VideoWatchStatus } = require('../../models');
const profileLinker = require('./profileLinker');
const { profileRootPath } = require('./profilePaths');

const SOURCE_TYPES = Object.freeze({ CHANNEL: 'channel', PLAYLIST: 'playlist' });
const MAX_NAME_LENGTH = 100;
const MAX_REMOVE_WATCHED_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

function validateRemoveWatchedDays(value) {
  if (value === null || value === undefined) return true;
  return Number.isInteger(value) && value >= 1 && value <= MAX_REMOVE_WATCHED_DAYS;
}

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
      plexUserId: profile.plex_user_id,
      plexUserName: profile.plex_user_name,
      plexLibraryId: profile.plex_library_id,
      removeWatchedAfterDays: profile.remove_watched_after_days ?? null,
      // Relative to the output dir, same convention as event log messages
      // (eventCatalog.js's libraryPath): the user knows this folder, not the
      // container mount it sits under.
      folderPath: path.relative(this._baseDir(), profileRootPath(this._baseDir(), profile.name)),
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
      ProfileVideoLink.findAll({ where: { dismissed_at: null }, attributes: ['profile_id'], raw: true }),
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

  async create({
    name,
    jellyfinUserId = null, jellyfinUserName = null, jellyfinLibraryId = null,
    plexUserId = null, plexUserName = null, plexLibraryId = null,
    removeWatchedAfterDays = null,
  }) {
    const validation = validateName(name);
    if (!validation.valid) throw makeError(validation.error, 400);
    if (!validateRemoveWatchedDays(removeWatchedAfterDays)) {
      throw makeError(`Remove-watched days must be a whole number from 1 to ${MAX_REMOVE_WATCHED_DAYS}`, 400);
    }
    const clean = name.trim();
    await this._assertNameAvailable(clean);

    const profile = await Profile.create({
      name: clean,
      jellyfin_user_id: jellyfinUserId || null,
      jellyfin_user_name: jellyfinUserName || null,
      jellyfin_library_id: jellyfinLibraryId || null,
      plex_user_id: plexUserId || null,
      plex_user_name: plexUserName || null,
      plex_library_id: plexLibraryId || null,
      remove_watched_after_days: removeWatchedAfterDays ?? null,
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
    if (fields.plexUserId !== undefined) updates.plex_user_id = fields.plexUserId || null;
    if (fields.plexUserName !== undefined) updates.plex_user_name = fields.plexUserName || null;
    if (fields.plexLibraryId !== undefined) updates.plex_library_id = fields.plexLibraryId || null;
    if (fields.removeWatchedAfterDays !== undefined) {
      if (!validateRemoveWatchedDays(fields.removeWatchedAfterDays)) {
        throw makeError(`Remove-watched days must be a whole number from 1 to ${MAX_REMOVE_WATCHED_DAYS}`, 400);
      }
      updates.remove_watched_after_days = fields.removeWatchedAfterDays;
    }

    // Each server identity's playlist copies are dropped independently: the
    // old user's copies belong to someone else now, but a change to one
    // server's identity must not disturb the other server's working copies.
    const jellyfinUserChanged = updates.jellyfin_user_id !== undefined && updates.jellyfin_user_id !== profile.jellyfin_user_id;
    const plexUserChanged = updates.plex_user_id !== undefined && updates.plex_user_id !== profile.plex_user_id;
    if (jellyfinUserChanged) await mediaServerSync.removeProfileCopies(profile.id, { serverType: 'jellyfin' });
    if (plexUserChanged) await mediaServerSync.removeProfileCopies(profile.id, { serverType: 'plex' });
    await profile.update(updates);
    if (jellyfinUserChanged || plexUserChanged) this._syncFollowedPlaylists(profile.id);

    const [profileView] = (await this.list()).filter((p) => p.id === profile.id);
    return profileView;
  }

  async _followedPlaylistIds(profileId) {
    const subs = await ProfileSubscription.findAll({
      where: { profile_id: profileId, source_type: SOURCE_TYPES.PLAYLIST },
      attributes: ['source_id'],
      raw: true,
    });
    return subs.map((s) => s.source_id);
  }

  /** Fire-and-forget media-server sync of the given playlists (YouTube playlist ids). */
  _syncPlaylists(playlistIds) {
    if (playlistIds.length === 0) return;
    Playlist.findAll({ where: { playlist_id: playlistIds }, attributes: ['id'], raw: true })
      .then((rows) => Promise.all(rows.map((row) => mediaServerSync.syncPlaylist(row.id))))
      .catch((err) => logger.error({ err }, 'profiles: playlist sync after profile change failed'));
  }

  _syncFollowedPlaylists(profileId) {
    this._followedPlaylistIds(profileId)
      .then((ids) => this._syncPlaylists(ids))
      .catch((err) => logger.error({ err, profileId }, 'profiles: could not list followed playlists'));
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
    await mediaServerSync.removeProfileCopies(profile.id);
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
    const previousPlaylists = await this._followedPlaylistIds(profile.id);
    await sequelize.transaction(async (transaction) => {
      await ProfileSubscription.destroy({ where: { profile_id: profile.id }, transaction });
      if (rows.length > 0) await ProfileSubscription.bulkCreate(rows, { transaction });
    });
    const result = await this.reconcile(profile.id);

    const next = new Set(playlists);
    const before = new Set(previousPlaylists);
    this._syncPlaylists([
      ...[...next].filter((id) => !before.has(id)),
      ...[...before].filter((id) => !next.has(id)),
    ]);
    return result;
  }

  /**
   * Follow more channels/playlists without touching existing ones (used when
   * a channel or playlist is added while a profile is active), then link.
   * @returns {Promise<{linked:number, unlinked:number, failed:number}>}
   */
  async addSubscriptions(id, { channels = [], playlists = [] }) {
    const profile = await this._getProfileOr404(id);
    const rows = [
      ...[...new Set(channels)].map((sourceId) => ({ profile_id: profile.id, source_type: SOURCE_TYPES.CHANNEL, source_id: sourceId })),
      ...[...new Set(playlists)].map((sourceId) => ({ profile_id: profile.id, source_type: SOURCE_TYPES.PLAYLIST, source_id: sourceId })),
    ];
    if (rows.length > 0) await ProfileSubscription.bulkCreate(rows, { ignoreDuplicates: true });
    const result = await this.reconcile(profile.id);
    this._syncPlaylists([...new Set(playlists)]);
    return result;
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
    // Removed from this profile after being watched: stays out.
    if (row && row.dismissed_at) return false;
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

  _plexAdapter() {
    const config = configModule.getConfig();
    if (!config.plexApiKey || !(config.plexUrl || config.plexIP)) return null;
    return new PlexAdapter(config);
  }

  /** Fire-and-forget refresh of each profile's own Jellyfin and/or Plex library. */
  _refreshLibraries(profiles) {
    const jellyfinLibraryIds = [...new Set(profiles.map((p) => p.jellyfin_library_id).filter(Boolean))];
    const adapter = jellyfinLibraryIds.length > 0 ? this._jellyfinAdapter() : null;
    if (adapter) {
      this._refreshJellyfinLibraries(adapter, jellyfinLibraryIds).catch((err) => {
        logger.warn({ err: err.message, libraryIds: jellyfinLibraryIds }, 'profiles: Jellyfin library refresh failed');
      });
    }

    // Plex's own refreshLibrary swallows its own errors and never throws, and
    // has no Jellyfin-style empty-library quirk, so no equivalent workaround.
    const plexLibraryIds = [...new Set(profiles.map((p) => p.plex_library_id).filter(Boolean))];
    for (const libraryId of plexLibraryIds) plexModule.refreshLibrary(libraryId);
  }

  // Jellyfin skips a library folder that was empty at its last full scan
  // ("inaccessible or empty") and then ignores per-library refreshes of it,
  // so a profile library with nothing indexed yet needs one full scan.
  async _refreshJellyfinLibraries(adapter, libraryIds) {
    let needsFullScan = false;
    for (const libraryId of libraryIds) {
      if (await adapter.countLibraryItems(libraryId) === 0) {
        needsFullScan = true;
      } else {
        await adapter.refreshLibraryById(libraryId);
      }
    }
    if (needsFullScan) await adapter.refreshAllLibraries();
  }

  /**
   * Nightly: re-check every profile against the library, which drops links of
   * videos the rescan has since marked missing and picks up anything missed.
   * @returns {Promise<{profiles:number, linked:number, unlinked:number, failed:number}>}
   */
  async reconcileAll() {
    const profiles = await Profile.findAll({ attributes: ['id'] });
    const totals = { profiles: profiles.length, linked: 0, unlinked: 0, failed: 0 };
    for (const { id } of profiles) {
      try {
        const result = await this.reconcile(id);
        totals.linked += result.linked;
        totals.unlinked += result.unlinked;
        totals.failed += result.failed;
      } catch (err) {
        totals.failed += 1;
        logger.error({ err, profileId: id }, 'profiles: nightly reconcile failed');
      }
    }
    return totals;
  }

  /**
   * One profile's linked identities (jellyfin and/or plex), as
   * {serverType, serverUserId} pairs - whichever of its two user-id columns
   * is actually set.
   */
  _profileIdentities(profile) {
    return [
      profile.jellyfin_user_id && { serverType: 'jellyfin', serverUserId: profile.jellyfin_user_id },
      profile.plex_user_id && { serverType: 'plex', serverUserId: profile.plex_user_id },
    ].filter(Boolean);
  }

  /**
   * Nightly: for profiles with remove_watched_after_days set, unlink videos
   * that EVERY one of the profile's linked identities (Jellyfin and/or Plex)
   * watched at least that many days ago - a profile with both requires both
   * to have watched before a video leaves it. Only the profile's links go;
   * library files and other profiles are untouched, and protected videos are
   * kept. Removed videos are not linked in again.
   * @returns {Promise<{profiles:number, removed:number, failed:number}>}
   */
  async removeWatchedLinks() {
    const profiles = await Profile.findAll({
      where: {
        remove_watched_after_days: { [Op.gte]: 1 },
        [Op.or]: [{ jellyfin_user_id: { [Op.ne]: null } }, { plex_user_id: { [Op.ne]: null } }],
      },
    });
    const result = { profiles: profiles.length, removed: 0, failed: 0 };
    const baseDir = this._baseDir();

    for (const profile of profiles) {
      const cutoff = new Date(Date.now() - profile.remove_watched_after_days * DAY_MS);
      const identities = this._profileIdentities(profile);
      const watchedSets = await Promise.all(identities.map(({ serverType, serverUserId }) =>
        VideoWatchStatus.findAll({
          where: { server_type: serverType, server_user_id: serverUserId, played: true, last_watched_at: { [Op.lte]: cutoff } },
          attributes: ['video_id'],
          raw: true,
        }).then((rows) => new Set(rows.map((r) => r.video_id)))
      ));
      // AND across identities: every linked identity must show watched.
      const watchedVideoIds = watchedSets.reduce(
        (acc, set) => (acc === null ? set : new Set([...acc].filter((id) => set.has(id)))),
        null
      );
      if (!watchedVideoIds || watchedVideoIds.size === 0) continue;

      const unprotected = await Video.findAll({
        where: { id: [...watchedVideoIds], protected: false },
        attributes: ['id'],
        raw: true,
      });
      const rows = await ProfileVideoLink.findAll({
        where: { profile_id: profile.id, video_id: unprotected.map((v) => v.id), dismissed_at: null },
      });

      let removedHere = 0;
      for (const row of rows) {
        try {
          await profileLinker.unlinkPaths(baseDir, profile.name, parsePaths(row));
          await row.update({ link_paths: '[]', dismissed_at: new Date() });
          removedHere += 1;
        } catch (err) {
          result.failed += 1;
          logger.error({ err, profileId: profile.id, youtubeId: row.youtube_id }, 'profiles: failed to remove watched video');
        }
      }
      if (removedHere > 0) {
        result.removed += removedHere;
        logger.info({ profileId: profile.id, removed: removedHere }, 'profiles: removed watched videos from profile');
        this._refreshLibraries([profile]);
        this._syncFollowedPlaylists(profile.id);
      }
    }
    return result;
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

  async listPlexUsers() {
    const adapter = this._plexAdapter();
    if (!adapter) throw makeError('Plex is not configured', 409);
    return adapter.listHomeUsers();
  }

  async listPlexLibraries() {
    if (!this._plexAdapter()) throw makeError('Plex is not configured', 409);
    return plexModule.getLibraries();
  }
}

module.exports = new ProfileModule();
