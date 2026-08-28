const ChannelVideo = require('../models/channelvideo');
const { Video, Channel } = require('../models');
const downloadModule = require('./downloadModule');
const { channelDownloadAllJobLabel } = require('./download/jobTypes');
const { MEDIA_TAB_TYPE_MAP } = require('./tabsUtils');
const logger = require('../logger');
const pythonTitleMatcher = require('../utils/pythonTitleMatcher');

const WATCH_URL_PREFIX = 'https://www.youtube.com/watch?v=';

// "Download all videos for a channel" (one tab at a time). Assumes the caller
// already ran the fetch-all ("Load More") flow, so channelvideos is complete.
class ChannelDownloadAllModule {
  async getDownloadableVideos(channelId, tabType) {
    const mediaType = MEDIA_TAB_TYPE_MAP[tabType] || 'video';

    const channel = await Channel.findOne({
      where: { channel_id: channelId },
      attributes: ['title_filter_regex', 'min_duration', 'max_duration'],
    });

    const rows = await ChannelVideo.findAll({
      where: {
        channel_id: channelId,
        media_type: mediaType,
        ignored: false,
        youtube_removed: false,
      },
      attributes: ['youtube_id', 'title', 'duration', 'availability', 'live_status'],
    });

    // Mirror the yt-dlp manual-download match filter
    // (availability!=subscriber_only & !is_live & live_status!=is_upcoming)
    // so the preview count matches what yt-dlp will accept.
    let candidates = rows.filter(
      (row) =>
        row.availability !== 'subscriber_only' &&
        row.live_status !== 'is_live' &&
        row.live_status !== 'is_upcoming'
    );

    // Also apply the channel's own duration/title filters, same as every
    // other download path (batch yt-dlp --match-filter, STRM auto-download,
    // playlist sync) - "Download All" was the one path that silently
    // ignored them.
    candidates = this._applyDurationFilter(candidates, channel?.min_duration, channel?.max_duration);
    candidates = this._applyTitleFilter(candidates, channel?.title_filter_regex);

    if (candidates.length === 0) {
      return [];
    }

    const existing = await Video.findAll({
      where: { youtubeId: candidates.map((row) => row.youtube_id) },
      attributes: ['youtubeId', 'removed'],
    });
    // Anything ever downloaded is excluded, even deleted rows (removed: true):
    // those stay in the yt-dlp archive, so yt-dlp would skip them and the
    // preview count would overstate.
    const downloaded = new Set(existing.map((video) => video.youtubeId));

    return candidates
      .filter((row) => !downloaded.has(row.youtube_id))
      .map((row) => ({ youtube_id: row.youtube_id, duration: row.duration }));
  }

  async getPreview(channelId, tabType) {
    await this.findChannelOrThrow(channelId);
    const videos = await this.getDownloadableVideos(channelId, tabType);

    let totalDurationSeconds = 0;
    let missingDurations = 0;
    for (const video of videos) {
      if (video.duration == null) {
        missingDurations += 1;
      } else {
        totalDurationSeconds += video.duration;
      }
    }

    return { count: videos.length, totalDurationSeconds, missingDurations };
  }

  async startDownloadAll(channelId, tabType, overrideSettings = {}) {
    const channel = await this.findChannelOrThrow(channelId);
    const videos = await this.getDownloadableVideos(channelId, tabType);

    if (videos.length === 0) {
      return { queued: 0 };
    }

    // The selection already excludes downloaded videos, so allowRedownload is dropped.
    const settings = { ...overrideSettings };
    delete settings.allowRedownload;

    const urls = videos.map((video) => `${WATCH_URL_PREFIX}${video.youtube_id}`);
    await downloadModule.doSpecificDownloads({
      body: {
        urls,
        overrideSettings: settings,
        channelId,
        jobLabel: channelDownloadAllJobLabel(channel),
      },
    });

    logger.info(
      { channelId, tabType, count: urls.length },
      'Queued channel download-all job'
    );

    return { queued: urls.length };
  }

  /**
   * Mirrors channelVideoQuery._applyDurationAndDateFilters' semantics: a row
   * with no known duration is excluded once either bound is set (matches
   * yt-dlp's --match-filter behavior of rejecting unknown fields).
   */
  _applyDurationFilter(videos, minDuration, maxDuration) {
    let filtered = videos;
    if (minDuration !== null && minDuration !== undefined) {
      filtered = filtered.filter((v) => v.duration && v.duration >= minDuration);
    }
    if (maxDuration !== null && maxDuration !== undefined) {
      filtered = filtered.filter((v) => v.duration && v.duration <= maxDuration);
    }
    return filtered;
  }

  /**
   * Filters via Python's regex engine (one subprocess call for the whole
   * batch) - the same engine yt-dlp's own --match-filter uses. See
   * pythonTitleMatcher for why this replaced a JS RegExp implementation.
   */
  _applyTitleFilter(videos, titleFilterRegex) {
    if (!titleFilterRegex) return videos;
    return pythonTitleMatcher.filterByTitleRegex(videos, titleFilterRegex, (v) => v.title);
  }

  async findChannelOrThrow(channelId) {
    const channel = await Channel.findOne({ where: { channel_id: channelId } });
    if (!channel) {
      throw new Error('CHANNEL_NOT_FOUND');
    }
    return channel;
  }
}

module.exports = new ChannelDownloadAllModule();
