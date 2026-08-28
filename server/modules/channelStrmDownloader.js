const logger = require('../logger');
const configModule = require('./configModule');
const channelVideoFetcher = require('./channel/channelVideoFetcher');
const channelVideoQuery = require('./channel/channelVideoQuery');
const fetchRegistry = require('./channel/fetchRegistry');
const pythonTitleMatcher = require('../utils/pythonTitleMatcher');

// Reverse of tabsUtils' MEDIA_TAB_TYPE_MAP: auto_download_enabled_tabs
// stores media types (video/short/livestream), but channelVideoFetcher
// wants tab-type strings (videos/shorts/streams) to build the channel URL.
// Same mapping DownloadModule.executeGroupDownload uses for the batch path.
const MEDIA_TYPE_TAB_MAP = { video: 'videos', short: 'shorts', livestream: 'streams' };

/**
 * Materializes .strm files for enabled channels whose effective media_mode
 * is 'strm', as part of the scheduled/cron "auto-download all enabled
 * channels" run. Channels on 'download'/'both' never reach this module —
 * see channelDownloadGrouper.getStrmModeChannels, which selects the
 * channels passed in here and is the only caller.
 *
 * Unlike the batch yt-dlp path (which hands yt-dlp channel-tab URLs and lets
 * it resolve/download videos itself via --playlist-end/--download-archive),
 * STRM materialization needs individual known video URLs up front —
 * strmMaterializer fetches per-video metadata itself. So this module
 * resolves each channel's candidate new videos via the same non-downloading
 * "list a channel's videos" infrastructure the channel page already uses
 * (channelVideoFetcher + channelVideoQuery), then routes them through
 * DownloadModule.doSpecificDownloads exactly the way a channel-page manual
 * download does — which already resolves quality/audio/subfolder/media_mode
 * from channelId and has the STRM early-exit, so none of that is duplicated
 * here.
 */
class ChannelStrmDownloader {
  /**
   * @param {Array} strmChannels - Channel records from
   *   channelDownloadGrouper.getStrmModeChannels()
   * @param {Object} [options]
   * @param {string} [options.runId] - Threaded through to doSpecificDownloads
   *   so these materializations report into the same run summary as the
   *   rest of a scheduled channel-download cycle (see downloadRunTracker).
   * @param {number} [options.videoCount] - Max new videos per channel/tab,
   *   mirroring the batch path's --playlist-end.
   * @param {boolean} [options.allowRedownload] - Re-materialize videos that
   *   already have a Video row, matching the batch path's allowRedownload
   *   (which bypasses yt-dlp's download-archive dedup the same way).
   */
  async runStrmChannelDownloads(strmChannels, { runId, videoCount, allowRedownload = false } = {}) {
    if (!Array.isArray(strmChannels) || strmChannels.length === 0) return;

    const effectiveVideoCount = videoCount || configModule.config.channelFilesToDownload || 5;

    // One channel failing (yt-dlp error, bad regex, etc.) must not stop the
    // rest of the sweep — same isolation as playlistModule.playlistAutoDownload's
    // per-playlist loop.
    for (const channel of strmChannels) {
      try {
        await this._runForChannel(channel, { runId, videoCount: effectiveVideoCount, allowRedownload });
      } catch (err) {
        logger.error({ err, channelId: channel.channel_id }, 'STRM auto-download failed for channel');
      }
    }
  }

  async _runForChannel(channel, { runId, videoCount, allowRedownload }) {
    const channelId = channel.channel_id;
    if (!channelId) return;

    const mediaTypes = (channel.auto_download_enabled_tabs ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const candidates = [];
    for (const mediaType of mediaTypes) {
      const tabType = MEDIA_TYPE_TAB_MAP[mediaType] || 'videos';
      try {
        const videos = await this._getCandidateVideos(channel, channelId, tabType, mediaType, videoCount, allowRedownload);
        candidates.push(...videos);
      } catch (err) {
        logger.error({ err, channelId, tabType }, 'STRM auto-download: failed to resolve candidate videos for tab');
      }
    }

    if (candidates.length === 0) return;

    const urls = candidates.map((v) => `https://www.youtube.com/watch?v=${v.youtube_id}`);
    logger.info({ channelId, count: urls.length }, 'STRM auto-download: queuing candidate videos for channel');

    const downloadModule = require('./downloadModule');
    await downloadModule.doSpecificDownloads({
      body: {
        urls,
        channelId,
        jobLabel: `STRM: ${channel.uploader || channelId}`,
        runId,
      },
    });
  }

  /**
   * Resolves not-yet-downloaded candidate videos for one channel/tab,
   * refreshing from YouTube first if the cached data looks stale — the same
   * freshness check (channelVideoFetcher.shouldRefreshChannelVideos) and
   * concurrency guard (fetchRegistry) the channel page uses, so a user
   * browsing this channel while the scheduled run fires doesn't trigger two
   * concurrent yt-dlp fetches for the same channel/tab.
   */
  async _getCandidateVideos(channel, channelId, tabType, mediaType, videoCount, allowRedownload) {
    const existing = await channelVideoQuery.fetchNewestVideosFromDb(
      channelId, 1, 0, 'off', '', 'date', 'desc', false, mediaType
    );
    const mostRecentVideoDate = existing.length > 0 ? existing[0].publishedAt : null;

    const fetchKey = `${channelId}:${tabType}`;
    if (channelVideoFetcher.shouldRefreshChannelVideos(channel, existing.length, mediaType) && !fetchRegistry.has(fetchKey)) {
      fetchRegistry.set(fetchKey, { startTime: new Date().toISOString(), type: 'strmAutoDownload', tabType });
      try {
        await channelVideoFetcher.fetchAndSaveVideosViaYtDlp(channel, channelId, tabType, mostRecentVideoDate);
      } finally {
        fetchRegistry.delete(fetchKey);
      }
    }

    const downloadedFilter = allowRedownload ? 'off' : 'exclude';
    const rows = await channelVideoQuery.fetchNewestVideosFromDb(
      channelId, videoCount, 0, downloadedFilter, '', 'date', 'desc', false, mediaType,
      channel.min_duration, channel.max_duration
    );

    return this._applyTitleFilter(rows, channel.title_filter_regex);
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
}

module.exports = new ChannelStrmDownloader();
