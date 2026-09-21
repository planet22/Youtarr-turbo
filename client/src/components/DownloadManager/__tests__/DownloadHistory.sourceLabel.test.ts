import { getJobSourceLabel } from '../DownloadHistory';

// The Source column and filter on both Download History and the event log use
// this label, so every kind of job the app creates must map to a real one.
describe('getJobSourceLabel', () => {
  test.each([
    ['Channel Downloads', 'Channels'],
    ['Channel Downloads - 3 group(s)', 'Channels'],
    ['Manually Added Urls', 'Manual Videos'],
    ['Manually Added Urls (via API: Bookmarklet)', 'API: Bookmarklet'],
    ['Playlist: My Playlist', 'Playlists'],
    ['Playlist Downloads', 'Playlists'],
    ['Sonarr/Radarr: TV [abc123]', 'NZB (TV)'],
    ['Auto-retry: 2 videos (HTTP 403)', 'Auto-retry'],
    ['STRM Cache: A Video [abc123]', 'STRM Cache-on-play'],
    ['HLS Buffer Cache: abc123', 'HLS Buffer Cache'],
    ['HLS Buffer Cache Finalize: abc123', 'HLS Buffer Cache'],
  ])('labels %p as %p', (jobType, label) => {
    expect(getJobSourceLabel(jobType)).toBe(label);
  });

  test('labels a channel "download all" job as Download All, not Other', () => {
    expect(getJobSourceLabel('Channel Download All: Taskmaster')).toBe('Download All');
  });

  test('labels a channel "download all" job whatever the channel is called', () => {
    expect(getJobSourceLabel('Channel Download All: Some [Odd] Channel - Name')).toBe('Download All');
  });

  test('still falls back to Other for a job type it does not know', () => {
    expect(getJobSourceLabel('Something New')).toBe('Other');
  });
});
