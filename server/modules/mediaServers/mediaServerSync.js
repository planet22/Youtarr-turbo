const logger = require('../../logger');
const jobEventLog = require('../jobEventLog');
const { EVENT_TYPES } = require('../jobEventLog/eventCatalog');
const configModule = require('../configModule');
const serverRegistry = require('./serverRegistry');
const { MediaServerUnavailableError, describeHttpError } = require('./adapters/baseAdapter');
const { Op } = require('sequelize');
const { Playlist, PlaylistVideo, PlaylistSyncState, Video, Profile, ProfileSubscription, ProfileVideoLink } = require('../../models');

// Backoff retry for resolving items after library scan. Tuned for typical Plex/Jellyfin
// scan completion times — short initial delays, then longer as more time passes.
const POLL_BACKOFFS_MS = [2000, 5000, 10000, 20000, 30000];

const ADAPTER_TYPE_TAG = {
  PlexAdapter: 'plex',
  JellyfinAdapter: 'jellyfin',
  EmbyAdapter: 'emby',
};

const SERVER_DISPLAY_NAME = {
  plex: 'Plex',
  jellyfin: 'Jellyfin',
  emby: 'Emby',
};

class MediaServerSync {
  constructor() {
    // playlistId -> { promise, rerunRequested }. Serializes concurrent syncs of
    // the same playlist: Jellyfin/Emby replace is delete+recreate, so two
    // overlapping runs can destroy each other's playlists, and two first-time
    // runs would double-create. A call arriving mid-run joins the in-flight
    // promise and schedules exactly one follow-up pass over fresh DB state.
    // Tradeoff: if the initial run rejects, joiners share that rejection and
    // any rerun they requested is dropped (a later call starts fresh).
    this._inFlight = new Map();
    this.lastSyncedIds = new Map();
  }

  syncPlaylist(playlistId) {
    // Deliberately synchronous: no await may be introduced between the map
    // check and set, or two callers could both miss the entry and run
    // concurrently.
    const key = String(playlistId);
    const existing = this._inFlight.get(key);
    if (existing) {
      existing.rerunRequested = true;
      return existing.promise;
    }
    const entry = { rerunRequested: false };
    entry.promise = this._runWithRerun(key, playlistId, entry);
    this._inFlight.set(key, entry);
    return entry.promise;
  }

  async _runWithRerun(key, playlistId, entry) {
    try {
      await this._doSync(playlistId);
      while (entry.rerunRequested) {
        entry.rerunRequested = false;
        await this._doSync(playlistId);
      }
    } finally {
      this._inFlight.delete(key);
    }
  }

  async _doSync(playlistId) {
    const playlist = await Playlist.findByPk(playlistId);
    if (!playlist) return;

    const positionDirection = playlist.sort_order === 'reversed' ? 'DESC' : 'ASC';
    const videos = await PlaylistVideo.findAll({
      where: { playlist_id: playlist.playlist_id, ignored: false },
      order: [['position', positionDirection]],
    });

    const config = configModule.getConfig();
    const adapters = serverRegistry.getEnabledAdapters(config);

    for (const adapter of adapters) {
      const serverType = ADAPTER_TYPE_TAG[adapter.constructor.name];
      if (!this._shouldSync(playlist, serverType)) continue;

      try {
        await this._syncToOne(playlist, videos, adapter, serverType);
      } catch (err) {
        await this._handleSyncError(err, playlist, serverType);
      }
    }

    const jellyfin = adapters.find((adapter) => ADAPTER_TYPE_TAG[adapter.constructor.name] === 'jellyfin');
    if (!jellyfin) return;
    try {
      await this._syncProfileCopies(playlist, videos, jellyfin);
    } catch (err) {
      logger.error({ err, playlist_id: playlist.playlist_id }, 'Failed to sync profile copies of playlist');
    }
  }

  // Each user profile that follows this playlist and has a Jellyfin user gets
  // its own copy of the playlist, owned by that user. Copies of profiles that
  // stopped following it (or lost their Jellyfin user) are deleted.
  async _syncProfileCopies(playlist, videos, jellyfin) {
    const followers = this._shouldSync(playlist, 'jellyfin') ? await this._profileFollowers(playlist) : [];
    const followerIds = new Set(followers.map((profile) => profile.id));

    const copies = await PlaylistSyncState.findAll({
      where: { playlist_id: playlist.id, server_type: 'jellyfin', profile_id: { [Op.ne]: null } },
    });
    for (const copy of copies) {
      if (!followerIds.has(copy.profile_id)) await this._removeProfileCopy(copy, jellyfin);
    }

    for (const profile of followers) {
      const dismissed = await this._dismissedYoutubeIds(profile.id);
      const ownVideos = dismissed.size > 0 ? videos.filter((pv) => !dismissed.has(pv.youtube_id)) : videos;
      try {
        await this._syncToOne(playlist, ownVideos, jellyfin.forUser(profile.jellyfin_user_id), 'jellyfin', profile);
      } catch (err) {
        await this._handleSyncError(err, playlist, 'jellyfin', profile.id);
      }
    }
  }

  async _profileFollowers(playlist) {
    const subs = await ProfileSubscription.findAll({
      where: { source_type: 'playlist', source_id: playlist.playlist_id },
      attributes: ['profile_id'],
      raw: true,
    });
    if (subs.length === 0) return [];
    return Profile.findAll({
      where: { id: subs.map((s) => s.profile_id), jellyfin_user_id: { [Op.ne]: null } },
    });
  }

  async _dismissedYoutubeIds(profileId) {
    const rows = await ProfileVideoLink.findAll({
      where: { profile_id: profileId, dismissed_at: { [Op.ne]: null } },
      attributes: ['youtube_id'],
      raw: true,
    });
    return new Set(rows.map((r) => r.youtube_id));
  }

  // Never throws: a playlist that can't be deleted on the server is logged and
  // its row dropped, so the profile's state doesn't keep pointing at it.
  async _removeProfileCopy(copy, jellyfin) {
    if (jellyfin && copy.server_playlist_id) {
      try {
        await jellyfin.deletePlaylist(copy.server_playlist_id);
      } catch (err) {
        logger.warn({ ...describeHttpError(err), serverPlaylistId: copy.server_playlist_id }, 'Could not delete a profile\'s Jellyfin playlist copy');
      }
    }
    try {
      await copy.destroy();
    } catch (err) {
      logger.error({ err, profileId: copy.profile_id }, 'failed to remove profile playlist sync state');
    }
  }

  /** Delete every Jellyfin playlist copy owned by a profile (profile deleted or its Jellyfin user changed). */
  async removeProfileCopies(profileId) {
    const copies = await PlaylistSyncState.findAll({ where: { profile_id: profileId } });
    if (copies.length === 0) return;
    const jellyfin = serverRegistry.getEnabledAdapters(configModule.getConfig())
      .find((adapter) => ADAPTER_TYPE_TAG[adapter.constructor.name] === 'jellyfin');
    for (const copy of copies) {
      await this._removeProfileCopy(copy, jellyfin);
    }
  }

  _shouldSync(playlist, serverType) {
    if (serverType === 'plex') return !!playlist.sync_to_plex;
    if (serverType === 'jellyfin') return !!playlist.sync_to_jellyfin;
    if (serverType === 'emby') return !!playlist.sync_to_emby;
    return false;
  }

  // `profile` set = a user profile's own copy (separate sync state, private,
  // no library scan - the shared sync and profile linking already trigger those).
  async _syncToOne(playlist, videos, adapter, serverType, profile = null) {
    const profileId = profile ? profile.id : null;
    const youtubeIds = videos.map((pv) => pv.youtube_id);
    const downloaded = youtubeIds.length
      ? await Video.findAll({ where: { youtubeId: youtubeIds } })
      : [];
    const byYoutubeId = new Map(downloaded.map((v) => [v.youtubeId, v]));

    // Server playlists are media-typed (Plex audio vs video, Jellyfin/Emby
    // MediaType) and can't mix types. The Download Type setting decides which
    // type we sync, not what's on disk: per-video overrides can mix formats,
    // and one manual video download shouldn't flip an audio playlist to video.
    const mediaType = playlist.audio_format === 'mp3_only' ? 'audio' : 'video';
    const entries = [];
    let mismatched = 0;
    for (const pv of videos) {
      const v = byYoutubeId.get(pv.youtube_id);
      // A deleted video keeps its last filePath; resolving it would only
      // burn the full lookup backoff on a file the server can't have.
      if (!v || v.removed) continue;
      const mediaPath = mediaType === 'audio' ? v.audioFilePath : v.filePath;
      if (mediaPath) {
        entries.push({ youtube_id: pv.youtube_id, filePath: mediaPath });
      } else if (v.filePath || v.audioFilePath) {
        mismatched += 1;
      }
    }
    if (mismatched > 0) {
      logger.info(
        { playlist_id: playlist.playlist_id, serverType, mediaType, mismatched },
        `Playlist "${playlist.title}" has ${mismatched} downloaded item(s) with no ${mediaType === 'audio' ? 'mp3' : 'video'} file; leaving them out (the playlist's Download Type setting makes this a ${mediaType} playlist, and media servers cannot mix types)`
      );
    }

    // The media type tells Plex whether music sections need a scan; audio
    // files have no other scan trigger anywhere in Youtarr. Jellyfin/Emby
    // ignore the hint (their refresh already covers every library).
    if (!profile) await adapter.triggerLibraryScan(null, { mediaType });

    const resolvedByPath = await this._resolveAllWithBackoff(
      adapter,
      entries.map((entry) => entry.filePath)
    );
    const itemIds = [];
    const syncedYoutubeIds = [];
    for (const entry of entries) {
      const id = resolvedByPath.get(entry.filePath);
      if (id) {
        itemIds.push(id);
        syncedYoutubeIds.push(entry.youtube_id);
      } else logger.warn(
        { youtube_id: entry.youtube_id, serverType },
        `Unable to sync item ${entry.youtube_id} for playlist "${playlist.title}" to ${SERVER_DISPLAY_NAME[serverType] || serverType}: not found on server, skipping`
      );
    }

    const name = `YT: ${playlist.title}`;
    const state = await PlaylistSyncState.findOne({
      where: { playlist_id: playlist.id, server_type: serverType, profile_id: profileId },
    });
    const isPublic = profile ? false : !!playlist.public_on_servers;
    const serverLabel = SERVER_DISPLAY_NAME[serverType] || serverType;

    // With zero resolved items, the only case that proceeds is a deliberately
    // emptied playlist (every video ignored/removed) with an existing server
    // playlist to empty. Everything else defers: the servers reject empty
    // playlist creation, and replacing an existing playlist with nothing would
    // wipe it over a transient condition (scan lag, or downloads that don't
    // match a just-changed Download Type).
    if (itemIds.length === 0 && !(state?.server_playlist_id && videos.length === 0)) {
      const reason = entries.length === 0
        ? mismatched > 0
          ? `none of the downloaded items has a ${mediaType === 'audio' ? 'mp3' : 'video'} file matching the playlist's Download Type`
          : 'no downloaded items resolved yet'
        : mediaType === 'audio'
          ? 'downloaded audio files were not found on the server. Audio playlists need a music-type library that includes the Youtarr Turbo output folder'
          : 'downloaded files were not found on the server yet';
      logger.info(
        { playlist_id: playlist.playlist_id, serverType, profileId },
        `Deferring ${serverLabel}${profile ? ` (${profile.name})` : ''} sync of playlist "${playlist.title}": ${reason}`
      );
      return;
    }

    const createdOnServer = !state?.server_playlist_id;
    if (state?.server_playlist_id) {
      // Pass name+public so adapters that implement replace as delete+recreate
      // (Jellyfin, Emby) can construct the new playlist. Plex replaces in place
      // and ignores opts. Capture the returned id in case the adapter recreated
      // — the sync-state row must track the new id.
      const replaced = await adapter.replacePlaylistItems(state.server_playlist_id, itemIds, {
        name, public: isPublic, mediaType,
      });
      const effectiveId = replaced?.id || state.server_playlist_id;
      if (state.update) await state.update({
        server_playlist_id: effectiveId,
        last_synced_at: new Date(),
        last_error: null,
      });
    } else {
      const created = await adapter.createPlaylist(name, itemIds, { public: isPublic, mediaType });
      if (state) {
        // State row exists from a prior failure (last_error set, server_playlist_id null).
        // Update it in place rather than creating a duplicate — the unique constraint
        // (playlist_id, server_type) would reject a second create.
        if (state.update) await state.update({
          server_playlist_id: created.id,
          last_synced_at: new Date(),
          last_error: null,
        });
      } else {
        await PlaylistSyncState.create({
          playlist_id: playlist.id,
          server_type: serverType,
          profile_id: profileId,
          server_playlist_id: created.id,
          last_synced_at: new Date(),
        });
      }
    }

    this._recordSyncEvents(playlist, serverType, syncedYoutubeIds, createdOnServer, byYoutubeId, profile);
  }

  // What each playlist last sent to each server, in this process only. The
  // servers are told the whole list every time, so "added"/"removed" can only
  // be known relative to the previous sync we made; after a restart there is
  // no previous list and only the summary is logged (never every video as new).
  _recordSyncEvents(playlist, serverType, youtubeIds, created, videoRows, profile = null) {
    const serverName = SERVER_DISPLAY_NAME[serverType] || serverType;
    const server = profile ? `${serverName} (${profile.name})` : serverName;
    const base = { playlistTitle: playlist.title, server };
    jobEventLog.record(EVENT_TYPES.PLAYLIST_SYNCED, {
      detail: { ...base, created, itemCount: youtubeIds.length, playlistId: playlist.playlist_id },
    });

    const key = `${playlist.id}:${serverType}:${profile ? profile.id : ''}`;
    const previous = this.lastSyncedIds.get(key);
    this.lastSyncedIds.set(key, new Set(youtubeIds));
    if (!previous) return;

    const current = new Set(youtubeIds);
    for (const youtubeId of youtubeIds) {
      if (previous.has(youtubeId)) continue;
      const row = videoRows.get(youtubeId);
      jobEventLog.record(EVENT_TYPES.PLAYLIST_ITEM_ADDED, {
        youtubeId,
        videoTitle: row && row.youTubeVideoName,
        channelName: row && row.youTubeChannelName,
        detail: base,
      });
    }
    for (const youtubeId of previous) {
      if (current.has(youtubeId)) continue;
      jobEventLog.record(EVENT_TYPES.PLAYLIST_ITEM_REMOVED, { youtubeId, detail: base });
    }
  }

  // Resolve the whole batch per polling round rather than per file: each round
  // re-queries the server so files indexed by the in-flight library scan are
  // picked up, and only still-missing paths are retried. With a bulk adapter
  // (Plex) this costs (sections x rounds) listing fetches instead of
  // (sections x files x rounds). Returns Map<filePath, itemId> for resolved
  // paths only.
  async _resolveAllWithBackoff(adapter, filepaths) {
    const resolved = new Map();
    let pending = [...new Set(filepaths)];
    const collect = (results) => {
      for (const [filepath, id] of results) {
        if (id) resolved.set(filepath, id);
      }
      pending = pending.filter((filepath) => !resolved.has(filepath));
    };

    if (!pending.length) return resolved;
    collect(await adapter.resolveItemIdsByFilepaths(pending));
    for (const delay of POLL_BACKOFFS_MS) {
      if (!pending.length) break;
      await new Promise((r) => setTimeout(r, delay));
      collect(await adapter.resolveItemIdsByFilepaths(pending));
    }
    return resolved;
  }

  // Turn a thrown sync error into one user-readable log line plus a concise
  // recorded last_error. An unreachable/unresponsive server gets a friendly
  // "not reachable" message; anything else logs a compact reason. Never the raw
  // axios error, which would dump the API token into the logs.
  async _handleSyncError(err, playlist, serverType, profileId = null) {
    const serverName = SERVER_DISPLAY_NAME[serverType] || serverType;
    if (err instanceof MediaServerUnavailableError) {
      logger.warn(
        { playlist_id: playlist.playlist_id, serverType, profileId },
        `Unable to sync playlist "${playlist.title}" to ${serverName}: server not reachable or not responding. Please ensure that your media server is up and reachable.`
      );
      await this._recordError(playlist.id, serverType, `${serverName} not reachable or not responding`, profileId);
      return;
    }
    const logData = { playlist_id: playlist.playlist_id, serverType, profileId };
    if (err && err.isAxiosError) logData.reason = describeHttpError(err);
    else logData.err = err;
    logger.error(logData, `Unable to sync playlist "${playlist.title}" to ${serverName}`);
    await this._recordError(playlist.id, serverType, err && err.message ? err.message : String(err), profileId);
  }

  // Never throws: this runs inside _doSync's per-adapter catch, and a
  // failure here must not abort the sync of the remaining adapters.
  async _recordError(playlistId, serverType, message, profileId = null) {
    try {
      const state = await PlaylistSyncState.findOne({
        where: { playlist_id: playlistId, server_type: serverType, profile_id: profileId },
      });
      if (state) {
        if (state.update) await state.update({ last_error: message });
      } else {
        await PlaylistSyncState.create({ playlist_id: playlistId, server_type: serverType, profile_id: profileId, last_error: message });
      }
    } catch (err) {
      logger.error({ err, playlist_db_id: playlistId, serverType }, 'failed to record playlist sync error');
    }
  }
}

module.exports = new MediaServerSync();
