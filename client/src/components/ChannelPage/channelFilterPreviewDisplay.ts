import { ChannelVideo } from '../../types/ChannelVideo';

// "Preview channel filters" toggle (ChannelVideos.tsx) - only present when
// the channel-filter-preview request param was on. See channelVideosService.js's
// attachChannelFilterPreview for how these fields are computed.
export function formatSeasonEpisode(season: number, episode: number | null): string {
  const paddedSeason = String(season).padStart(2, '0');
  return episode != null ? `S${paddedSeason}E${String(episode).padStart(2, '0')}` : `S${paddedSeason}`;
}

export function buildChannelFilterPreviewTooltip(preview: NonNullable<ChannelVideo['channelFilterPreview']>): string {
  if (!preview.wouldDownload) {
    if (preview.excludedReason === 'duration') {
      return "Would NOT auto-download - outside this channel's duration filter";
    }
    if (preview.excludedReason === 'titleFilter') {
      return "Would NOT auto-download - excluded by this channel's title filter";
    }
    return 'Would NOT auto-download';
  }
  if (preview.isSeriesMode && preview.season != null) {
    const seasonEpisode = formatSeasonEpisode(preview.season, preview.episode);
    return preview.seasonEpisodeDecoded
      ? `Would auto-download as ${seasonEpisode} (decoded from title)`
      : `Would auto-download as ${seasonEpisode} (default: upload year as season)`;
  }
  return 'Would auto-download';
}
