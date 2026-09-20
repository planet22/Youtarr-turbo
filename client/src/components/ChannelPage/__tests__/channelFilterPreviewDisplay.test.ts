import { buildChannelFilterPreviewTooltip, formatSeasonEpisode } from '../channelFilterPreviewDisplay';
import { ChannelVideo } from '../../../types/ChannelVideo';

type Preview = NonNullable<ChannelVideo['channelFilterPreview']>;

const preview = (overrides: Partial<Preview>): Preview => ({ wouldDownload: true, ...overrides } as Preview);

describe('formatSeasonEpisode', () => {
  it.each([
    [1, 1, 'S01E01'],
    [2024, 7, 'S2024E07'],
    [10, 123, 'S10E123'],
    [5, 0, 'S05E00'],
  ])('formats season %i episode %i as %s', (season, episode, expected) => {
    expect(formatSeasonEpisode(season, episode)).toBe(expected);
  });

  it('shows only the season when there is no episode', () => {
    expect(formatSeasonEpisode(3, null)).toBe('S03');
  });
});

describe('buildChannelFilterPreviewTooltip', () => {
  describe('a video that would not download', () => {
    it('blames the duration filter', () => {
      expect(buildChannelFilterPreviewTooltip(preview({ wouldDownload: false, excludedReason: 'duration' }))).toBe(
        'Would NOT auto-download - outside this channel\'s duration filter'
      );
    });

    it('blames the title filter', () => {
      expect(buildChannelFilterPreviewTooltip(preview({ wouldDownload: false, excludedReason: 'titleFilter' }))).toBe(
        'Would NOT auto-download - excluded by this channel\'s title filter'
      );
    });

    it('gives no reason when none is known', () => {
      expect(buildChannelFilterPreviewTooltip(preview({ wouldDownload: false }))).toBe('Would NOT auto-download');
    });

    it('never mentions a season even in series mode', () => {
      const text = buildChannelFilterPreviewTooltip(preview({ wouldDownload: false, isSeriesMode: true, season: 2024 }));

      expect(text).not.toContain('S2024');
    });
  });

  describe('a video that would download', () => {
    it('says so plainly outside series mode', () => {
      expect(buildChannelFilterPreviewTooltip(preview({}))).toBe('Would auto-download');
    });

    it('says so plainly in series mode when there is no season', () => {
      expect(buildChannelFilterPreviewTooltip(preview({ isSeriesMode: true, season: null }))).toBe('Would auto-download');
    });

    it('names the decoded season and episode', () => {
      expect(buildChannelFilterPreviewTooltip(preview({ isSeriesMode: true, season: 3, episode: 7, seasonEpisodeDecoded: true }))).toBe(
        'Would auto-download as S03E07 (decoded from title)'
      );
    });

    it('explains the upload-year default when the title was not decoded', () => {
      expect(buildChannelFilterPreviewTooltip(preview({ isSeriesMode: true, season: 2024, episode: null, seasonEpisodeDecoded: false }))).toBe(
        'Would auto-download as S2024 (default: upload year as season)'
      );
    });

    it('treats season 0 as a real season', () => {
      expect(buildChannelFilterPreviewTooltip(preview({ isSeriesMode: true, season: 0, episode: 1, seasonEpisodeDecoded: true }))).toContain('S00E01');
    });
  });
});
