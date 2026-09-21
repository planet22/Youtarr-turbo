const { sourceLabelForJobType } = require('../sourceLabels');
const jobTypes = require('../../download/jobTypes');

// Built from the job-type module, so a kind of job added there without a label
// here falls into 'Other' and fails this test. Mirrors Download History's
// getJobSourceLabel (its own test holds the same table).
describe('sourceLabelForJobType', () => {
  test.each([
    ['a channel sweep', 'Channel Downloads', 'Channels'],
    ['a multi-group channel sweep', 'Channel Downloads - 3 group(s)', 'Channels'],
    ['manually added URLs', jobTypes.MANUAL_DOWNLOAD_LABEL, 'Manual Videos'],
    ['manually added URLs via the API', jobTypes.MANUAL_DOWNLOAD_LABEL + ' (via API: Shortcut)', 'API: Shortcut'],
    ['a playlist download', jobTypes.playlistJobLabel({ title: 'Mix' }), 'Playlists'],
    ['an idle playlist sweep', jobTypes.PLAYLIST_SWEEP_LABEL, 'Playlists'],
    ['a channel download-all', jobTypes.channelDownloadAllJobLabel({ title: 'Taskmaster' }), 'Download All'],
    ['an auto-retry', jobTypes.autoRetryJobLabel(2), 'Auto-retry'],
    ['an STRM cache-on-play job', jobTypes.STRM_CACHE_LABEL_PREFIX + 'A Video [abc123]', 'STRM Cache-on-play'],
    ['an NZB grab', jobTypes.nzbDownloadJobLabel('TV', 'abc123'), 'NZB (TV)'],
    ['an HLS buffer cache fetch', 'HLS Buffer Cache: abc123', 'HLS Buffer Cache'],
    ['an HLS buffer cache finalize', 'HLS Buffer Cache Finalize: abc123', 'HLS Buffer Cache'],
  ])('labels %s', (_name, jobType, label) => {
    expect(sourceLabelForJobType(jobType)).toBe(label);
  });

  test('labels an NZB grab without a category as NZB', () => {
    expect(sourceLabelForJobType('Sonarr/Radarr: something')).toBe('NZB');
  });

  test('labels an unknown job type Other', () => {
    expect(sourceLabelForJobType('Something New')).toBe('Other');
  });

  test('gives no label when there is no job type', () => {
    expect(sourceLabelForJobType(undefined)).toBeNull();
  });
});
