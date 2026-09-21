// The "Source" of a job - Channels, Playlists, NZB (TV), Manual Videos, ... -
// exactly as Download History labels it (client DownloadHistory.tsx's
// getJobSourceLabel; a test keeps the two in step). Worked out once, when an
// event is recorded, and stored on the row.
const sourceLabelForJobType = (jobType) => {
  if (!jobType) return null;
  if (jobType.startsWith('Auto-retry')) return 'Auto-retry';
  if (jobType.includes('Channel Downloads')) return 'Channels';
  if (jobType.includes('Manually Added Urls')) {
    const apiKeyMatch = jobType.match(/\(via API: (.+)\)/);
    return apiKeyMatch ? `API: ${apiKeyMatch[1]}` : 'Manual Videos';
  }
  if (jobType === 'Playlist Downloads' || jobType.startsWith('Playlist: ')) return 'Playlists';
  if (jobType.startsWith('Sonarr/Radarr: ')) {
    const categoryMatch = jobType.match(/^Sonarr\/Radarr: (.+?) \[/);
    return categoryMatch ? `NZB (${categoryMatch[1]})` : 'NZB';
  }
  if (jobType.startsWith('STRM Cache: ')) return 'STRM Cache-on-play';
  if (jobType.startsWith('Channel Download All: ')) return 'Download All';
  if (jobType.startsWith('HLS Buffer Cache')) return 'HLS Buffer Cache';
  return 'Other';
};

module.exports = { sourceLabelForJobType };
