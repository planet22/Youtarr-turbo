/* eslint-env jest */

jest.mock('../../logger');
jest.mock('../configModule', () => ({ config: { channelFilesToDownload: 5 } }));
jest.mock('../channel/channelVideoFetcher', () => ({
  shouldRefreshChannelVideos: jest.fn(),
  fetchAndSaveVideosViaYtDlp: jest.fn(),
}));
jest.mock('../channel/channelVideoQuery', () => ({ fetchNewestVideosFromDb: jest.fn() }));
jest.mock('../channel/fetchRegistry', () => ({
  has: jest.fn(),
  set: jest.fn(),
  delete: jest.fn(),
}));
jest.mock('../../utils/pythonTitleMatcher', () => ({ filterByTitleRegex: jest.fn() }));
jest.mock('../downloadModule', () => ({ doSpecificDownloads: jest.fn() }));

const logger = require('../../logger');
const configModule = require('../configModule');
const channelVideoFetcher = require('../channel/channelVideoFetcher');
const channelVideoQuery = require('../channel/channelVideoQuery');
const fetchRegistry = require('../channel/fetchRegistry');
const pythonTitleMatcher = require('../../utils/pythonTitleMatcher');
const downloadModule = require('../downloadModule');
const channelStrmDownloader = require('../channelStrmDownloader');

describe('channelStrmDownloader', () => {
  function buildChannel(overrides = {}) {
    return {
      channel_id: 'UC123',
      uploader: 'Some Channel',
      auto_download_enabled_tabs: 'video',
      min_duration: null,
      max_duration: null,
      title_filter_regex: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    configModule.config.channelFilesToDownload = 5;
    channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(false);
    fetchRegistry.has.mockReturnValue(false);
    channelVideoQuery.fetchNewestVideosFromDb.mockResolvedValue([]);
    downloadModule.doSpecificDownloads.mockResolvedValue(undefined);
  });

  describe('runStrmChannelDownloads', () => {
    it.each([undefined, null, [], 'not-an-array'])('does nothing for %p', async (input) => {
      await channelStrmDownloader.runStrmChannelDownloads(input);

      expect(channelVideoQuery.fetchNewestVideosFromDb).not.toHaveBeenCalled();
    });

    it('defaults the per-channel video count to the configured channelFilesToDownload', async () => {
      configModule.config.channelFilesToDownload = 9;

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

      // second fetchNewestVideosFromDb call is the candidate query and takes the limit as its 2nd arg
      expect(channelVideoQuery.fetchNewestVideosFromDb.mock.calls[1][1]).toBe(9);
    });

    it('falls back to 5 videos when neither the option nor config sets a count', async () => {
      configModule.config.channelFilesToDownload = undefined;

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

      expect(channelVideoQuery.fetchNewestVideosFromDb.mock.calls[1][1]).toBe(5);
    });

    it('prefers an explicit videoCount option over config', async () => {
      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()], { videoCount: 2 });

      expect(channelVideoQuery.fetchNewestVideosFromDb.mock.calls[1][1]).toBe(2);
    });

    it('keeps processing later channels when one channel candidate query fails', async () => {
      channelVideoQuery.fetchNewestVideosFromDb
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValue([{ youtube_id: 'vid1', title: 't' }]);
      const channels = [buildChannel({ channel_id: 'UC_A' }), buildChannel({ channel_id: 'UC_B' })];

      await channelStrmDownloader.runStrmChannelDownloads(channels);

      expect(downloadModule.doSpecificDownloads).toHaveBeenCalledTimes(1);
    });

    it('logs and continues when downloading for a channel throws', async () => {
      channelVideoQuery.fetchNewestVideosFromDb.mockResolvedValue([{ youtube_id: 'vid1', title: 't' }]);
      downloadModule.doSpecificDownloads.mockRejectedValueOnce(new Error('queue full')).mockResolvedValue(undefined);

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ channel_id: 'UC_A' }), buildChannel({ channel_id: 'UC_B' })]);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'UC_A' }),
        'STRM auto-download failed for channel'
      );
      expect(downloadModule.doSpecificDownloads).toHaveBeenCalledTimes(2);
    });
  });

  describe('per-channel behavior', () => {
    it('skips a channel with no channel_id', async () => {
      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ channel_id: null })]);

      expect(channelVideoQuery.fetchNewestVideosFromDb).not.toHaveBeenCalled();
    });

    it('does not queue a download when a channel has no enabled tabs', async () => {
      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ auto_download_enabled_tabs: null })]);

      expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
    });

    it('does not queue a download when no candidate videos are found', async () => {
      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

      expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
    });

    it('queues watch URLs for the candidate videos', async () => {
      channelVideoQuery.fetchNewestVideosFromDb
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ youtube_id: 'aaa', title: 'A' }, { youtube_id: 'bbb', title: 'B' }]);

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.urls).toEqual([
        'https://www.youtube.com/watch?v=aaa',
        'https://www.youtube.com/watch?v=bbb',
      ]);
    });

    it('labels the job with the channel uploader and threads the channelId and runId through', async () => {
      channelVideoQuery.fetchNewestVideosFromDb
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ youtube_id: 'aaa', title: 'A' }]);

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()], { runId: 'run-1' });

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body).toMatchObject({
        channelId: 'UC123',
        jobLabel: 'STRM: Some Channel',
        runId: 'run-1',
      });
    });

    it('falls back to the channel id in the job label when there is no uploader', async () => {
      channelVideoQuery.fetchNewestVideosFromDb
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ youtube_id: 'aaa', title: 'A' }]);

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ uploader: undefined })]);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.jobLabel).toBe('STRM: UC123');
    });

    it('queues a single job per channel across several tabs', async () => {
      channelVideoQuery.fetchNewestVideosFromDb.mockImplementation(async (_id, limit, _off, _dl, _s, _sb, _o, _f, mediaType) =>
        (limit === 1 ? [] : [{ youtube_id: `${mediaType}-vid`, title: mediaType }])
      );

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ auto_download_enabled_tabs: 'video, short,livestream' })]);

      expect(downloadModule.doSpecificDownloads).toHaveBeenCalledTimes(1);
      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.urls).toEqual([
        'https://www.youtube.com/watch?v=video-vid',
        'https://www.youtube.com/watch?v=short-vid',
        'https://www.youtube.com/watch?v=livestream-vid',
      ]);
    });

    it('still queues candidates from other tabs when one tab fails to resolve', async () => {
      channelVideoQuery.fetchNewestVideosFromDb.mockImplementation(async (_id, limit, _off, _dl, _s, _sb, _o, _f, mediaType) => {
        if (mediaType === 'video') throw new Error('tab broke');
        return limit === 1 ? [] : [{ youtube_id: 'short-vid', title: 's' }];
      });

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ auto_download_enabled_tabs: 'video,short' })]);

      expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.urls).toEqual(['https://www.youtube.com/watch?v=short-vid']);
    });
  });

  describe('candidate resolution', () => {
    it('excludes already downloaded videos by default', async () => {
      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

      // 4th positional arg of the candidate query is the downloaded filter
      expect(channelVideoQuery.fetchNewestVideosFromDb.mock.calls[1][3]).toBe('exclude');
    });

    it('includes already downloaded videos when allowRedownload is set', async () => {
      await channelStrmDownloader.runStrmChannelDownloads([buildChannel()], { allowRedownload: true });

      expect(channelVideoQuery.fetchNewestVideosFromDb.mock.calls[1][3]).toBe('off');
    });

    it('passes the channel duration bounds to the candidate query', async () => {
      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ min_duration: 60, max_duration: 600 })]);

      const call = channelVideoQuery.fetchNewestVideosFromDb.mock.calls[1];
      expect([call[9], call[10]]).toEqual([60, 600]);
    });

    it.each([
      ['video', 'videos'],
      ['short', 'shorts'],
      ['livestream', 'streams'],
      ['unknown', 'videos'],
    ])('maps the %s media type to the %s tab', async (mediaType, tabType) => {
      channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);

      await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ auto_download_enabled_tabs: mediaType })]);

      expect(channelVideoFetcher.fetchAndSaveVideosViaYtDlp.mock.calls[0][2]).toBe(tabType);
    });

    describe('refresh from YouTube', () => {
      it('does not fetch when cached data is fresh', async () => {
        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(channelVideoFetcher.fetchAndSaveVideosViaYtDlp).not.toHaveBeenCalled();
      });

      it('fetches when cached data is stale', async () => {
        channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(channelVideoFetcher.fetchAndSaveVideosViaYtDlp).toHaveBeenCalledTimes(1);
      });

      it('skips the fetch when the same channel/tab is already being fetched elsewhere', async () => {
        channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);
        fetchRegistry.has.mockReturnValue(true);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(channelVideoFetcher.fetchAndSaveVideosViaYtDlp).not.toHaveBeenCalled();
      });

      it('registers the fetch under a channel:tab key', async () => {
        channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(fetchRegistry.set).toHaveBeenCalledWith('UC123:videos', expect.objectContaining({ type: 'strmAutoDownload', tabType: 'videos' }));
      });

      it('releases the registry key after a successful fetch', async () => {
        channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(fetchRegistry.delete).toHaveBeenCalledWith('UC123:videos');
      });

      it('releases the registry key even when the fetch fails', async () => {
        channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);
        channelVideoFetcher.fetchAndSaveVideosViaYtDlp.mockRejectedValue(new Error('yt-dlp failed'));

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(fetchRegistry.delete).toHaveBeenCalledWith('UC123:videos');
      });

      it('passes the most recent cached video date to the fetch', async () => {
        channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);
        channelVideoQuery.fetchNewestVideosFromDb.mockResolvedValueOnce([{ publishedAt: '2026-01-02T00:00:00Z' }]);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(channelVideoFetcher.fetchAndSaveVideosViaYtDlp.mock.calls[0][3]).toBe('2026-01-02T00:00:00Z');
      });

      it('passes null as the most recent date when nothing is cached yet', async () => {
        channelVideoFetcher.shouldRefreshChannelVideos.mockReturnValue(true);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(channelVideoFetcher.fetchAndSaveVideosViaYtDlp.mock.calls[0][3]).toBeNull();
      });
    });

    describe('title filter', () => {
      const rows = [{ youtube_id: 'aaa', title: 'Keep' }, { youtube_id: 'bbb', title: 'Drop' }];

      beforeEach(() => {
        channelVideoQuery.fetchNewestVideosFromDb.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
      });

      it('does not invoke the regex matcher when the channel has no title filter', async () => {
        await channelStrmDownloader.runStrmChannelDownloads([buildChannel()]);

        expect(pythonTitleMatcher.filterByTitleRegex).not.toHaveBeenCalled();
      });

      it('queues only the videos the regex matcher keeps', async () => {
        pythonTitleMatcher.filterByTitleRegex.mockReturnValue([rows[0]]);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ title_filter_regex: 'Keep' })]);

        expect(downloadModule.doSpecificDownloads.mock.calls[0][0].body.urls).toEqual(['https://www.youtube.com/watch?v=aaa']);
      });

      it('hands the matcher the rows, the regex and a title accessor', async () => {
        pythonTitleMatcher.filterByTitleRegex.mockReturnValue(rows);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ title_filter_regex: 'Keep' })]);

        const [passedRows, regex, accessor] = pythonTitleMatcher.filterByTitleRegex.mock.calls[0];
        expect([passedRows, regex, accessor(rows[1])]).toEqual([rows, 'Keep', 'Drop']);
      });

      it('queues nothing when the matcher rejects every video', async () => {
        pythonTitleMatcher.filterByTitleRegex.mockReturnValue([]);

        await channelStrmDownloader.runStrmChannelDownloads([buildChannel({ title_filter_regex: 'nomatch' })]);

        expect(downloadModule.doSpecificDownloads).not.toHaveBeenCalled();
      });
    });
  });
});
