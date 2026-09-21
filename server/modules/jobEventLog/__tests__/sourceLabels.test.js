const { SOURCES, SOURCE_LABELS } = require('../sourceLabels');
const jobTypes = require('../../download/jobTypes');

// Turns a SQL LIKE pattern into a regex so the patterns can be checked here.
const likeToRegExp = (pattern) =>
  new RegExp('^' + pattern.split('%').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

const sourceFor = (jobType) =>
  SOURCE_LABELS.find((label) => SOURCES[label].some((pattern) => likeToRegExp(pattern).test(jobType)));

// Every kind of job the app creates has to land in some source group, or the
// Source filter could never select it. Built from the job-type module so a new
// label added there without a group here fails this test.
describe('sourceLabels', () => {
  test.each([
    ['a channel sweep', 'Channel Downloads'],
    ['a multi-group channel sweep', 'Channel Downloads - 3 group(s)'],
    ['manually added URLs', jobTypes.MANUAL_DOWNLOAD_LABEL],
    ['manually added URLs via the API', jobTypes.MANUAL_DOWNLOAD_LABEL + ' (via API: Shortcut)'],
    ['a playlist download', jobTypes.playlistJobLabel({ title: 'Mix' })],
    ['an idle playlist sweep', jobTypes.PLAYLIST_SWEEP_LABEL],
    ['a channel download-all', jobTypes.channelDownloadAllJobLabel({ title: 'Taskmaster' })],
    ['an auto-retry', jobTypes.autoRetryJobLabel(2)],
    ['an STRM cache-on-play job', jobTypes.STRM_CACHE_LABEL_PREFIX + 'A Video [abc123]'],
    ['an NZB grab', jobTypes.nzbDownloadJobLabel('TV', 'abc123')],
    ['an HLS buffer cache fetch', 'HLS Buffer Cache: abc123'],
    ['an HLS buffer cache finalize', 'HLS Buffer Cache Finalize: abc123'],
  ])('%s belongs to a source group', (_name, jobType) => {
    expect(sourceFor(jobType)).toBeDefined();
  });

  test('a channel download-all is its own group, not lumped with channel sweeps', () => {
    expect(sourceFor(jobTypes.channelDownloadAllJobLabel({ title: 'Taskmaster' }))).toBe('Download All');
  });

  test('an NZB grab is in the NZB group', () => {
    expect(sourceFor(jobTypes.nzbDownloadJobLabel('TV', 'abc123'))).toBe('NZB');
  });

  test('an unknown job type is in no group', () => {
    expect(sourceFor('Something New')).toBeUndefined();
  });

  test('lists every group label', () => {
    expect(SOURCE_LABELS).toEqual(Object.keys(SOURCES));
  });
});
