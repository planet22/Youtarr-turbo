// Source groups for the log's "Source" column and filter. The labels mirror the
// ones Download History shows for a job's type (client DownloadHistory.tsx's
// getJobSourceLabel), so the two pages read the same; each maps to the LIKE
// patterns that select those jobs by their job_type.
const SOURCES = {
  Channels: ['%Channel Downloads%'],
  Playlists: ['Playlist: %', 'Playlist Downloads'],
  'Manual Videos': ['%Manually Added Urls%'],
  NZB: ['Sonarr/Radarr: %'],
  'Auto-retry': ['Auto-retry%'],
  'STRM Cache-on-play': ['STRM Cache: %'],
  'HLS Buffer Cache': ['HLS Buffer Cache%'],
  'Download All': ['Channel Download All: %'],
};

const SOURCE_LABELS = Object.keys(SOURCES);

module.exports = { SOURCES, SOURCE_LABELS };
