const logger = require('../../logger');

const SOURCE_CHANNEL = 'channel';
const SOURCE_PLAYLIST = 'playlist';

/**
 * Read-only lookup of which user profiles follow what, used by the "all
 * profiles" listings. Every method fails soft (empty result) so a lookup
 * problem never breaks the listing it decorates.
 */
class ProfileFollowers {
  constructor({ Profile, ProfileSubscription, PlaylistVideo }) {
    this.Profile = Profile;
    this.ProfileSubscription = ProfileSubscription;
    this.PlaylistVideo = PlaylistVideo;
  }

  async _profilesById(profileIds) {
    const ids = [...new Set(profileIds)];
    if (ids.length === 0) return new Map();
    const profiles = await this.Profile.findAll({ where: { id: ids }, attributes: ['id', 'name', 'jellyfin_user_name', 'plex_user_name'], raw: true });
    return new Map(profiles.map((p) => [p.id, {
      id: p.id,
      name: p.name,
      jellyfinUser: p.jellyfin_user_name || null,
      plexUser: p.plex_user_name || null,
    }]));
  }

  _sortedByName(set) {
    return [...set].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @returns {Promise<Map<string, Array<{id:number,name:string}>>>} source id -> followers */
  async forSources(sourceType, sourceIds) {
    const result = new Map();
    const ids = [...new Set((sourceIds || []).filter(Boolean))];
    if (ids.length === 0) return result;
    try {
      const subs = await this.ProfileSubscription.findAll({
        where: { source_type: sourceType, source_id: ids },
        attributes: ['profile_id', 'source_id'],
        raw: true,
      });
      const profiles = await this._profilesById(subs.map((s) => s.profile_id));
      for (const sub of subs) {
        const profile = profiles.get(sub.profile_id);
        if (!profile) continue;
        if (!result.has(sub.source_id)) result.set(sub.source_id, new Set());
        result.get(sub.source_id).add(profile);
      }
      for (const [key, set] of result) result.set(key, this._sortedByName(set));
    } catch (err) {
      logger.error({ err, sourceType }, 'profiles: could not look up followers');
      return new Map();
    }
    return result;
  }

  async forChannel(channelId) {
    const map = await this.forSources(SOURCE_CHANNEL, [channelId]);
    return map.get(channelId) || [];
  }

  async forPlaylist(playlistId) {
    const map = await this.forSources(SOURCE_PLAYLIST, [playlistId]);
    return map.get(playlistId) || [];
  }

  async attachToChannels(channels) {
    const map = await this.forSources(SOURCE_CHANNEL, channels.map((c) => c.channel_id));
    for (const channel of channels) channel.profiles = map.get(channel.channel_id) || [];
    return channels;
  }

  async attachToPlaylists(playlists) {
    const map = await this.forSources(SOURCE_PLAYLIST, playlists.map((p) => p.playlist_id));
    return playlists.map((p) => ({ ...p, profiles: map.get(p.playlist_id) || [] }));
  }

  /** A video belongs to a profile through its channel or through a followed playlist. */
  async attachToVideos(videos) {
    for (const video of videos) video.profiles = [];
    if (videos.length === 0) return videos;
    try {
      const byChannel = await this.forSources(SOURCE_CHANNEL, videos.map((v) => v.channel_id));

      const playlistSubs = await this.ProfileSubscription.findAll({
        where: { source_type: SOURCE_PLAYLIST },
        attributes: ['source_id'],
        raw: true,
      });
      const playlistIds = [...new Set(playlistSubs.map((s) => s.source_id))];
      let byPlaylist = new Map();
      let playlistsOfVideo = new Map();
      if (playlistIds.length > 0) {
        byPlaylist = await this.forSources(SOURCE_PLAYLIST, playlistIds);
        const rows = await this.PlaylistVideo.findAll({
          where: { playlist_id: playlistIds, youtube_id: videos.map((v) => v.youtubeId).filter(Boolean) },
          attributes: ['playlist_id', 'youtube_id'],
          raw: true,
        });
        for (const row of rows) {
          if (!playlistsOfVideo.has(row.youtube_id)) playlistsOfVideo.set(row.youtube_id, []);
          playlistsOfVideo.get(row.youtube_id).push(row.playlist_id);
        }
      }

      for (const video of videos) {
        const merged = new Map();
        const add = (list) => (list || []).forEach((p) => merged.set(p.id, p));
        add(byChannel.get(video.channel_id));
        for (const playlistId of playlistsOfVideo.get(video.youtubeId) || []) add(byPlaylist.get(playlistId));
        video.profiles = this._sortedByName(new Set(merged.values()));
      }
    } catch (err) {
      logger.error({ err }, 'profiles: could not attach followers to videos');
    }
    return videos;
  }
}

// Models are passed in (not required here) so each caller keeps its own
// dependency graph; see routes/index.js and the modules that consume this.
module.exports = (models) => new ProfileFollowers(models);
module.exports.ProfileFollowers = ProfileFollowers;
