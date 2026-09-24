/* eslint-env jest */

jest.mock('../../../logger');
jest.mock('../failedVideoEnricher', () => ({ lookupKnownMetadata: jest.fn() }));

const { lookupKnownMetadata } = require('../failedVideoEnricher');
const jobEventLog = require('../../jobEventLog');
// jest.setup.js stubs this module globally; this is its own test.
const { primeVideosForEventLog } = jest.requireActual('../eventLogVideoPrimer');

describe('primeVideosForEventLog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lookupKnownMetadata.mockResolvedValue(new Map([['abc123def45', { title: 'A Title', channel: 'A Channel' }]]));
  });

  it('remembers each known video name for the event log', async () => {
    await primeVideosForEventLog(['abc123def45']);

    expect(jobEventLog.rememberVideo).toHaveBeenCalledWith('abc123def45', { title: 'A Title', channelName: 'A Channel' });
  });

  it('marks videos headed for the library as tracked', async () => {
    await primeVideosForEventLog(['abc123def45'], { destinedTracked: true });

    expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123def45', true);
  });

  it('marks videos deliberately kept out of the library as untracked', async () => {
    await primeVideosForEventLog(['abc123def45'], { destinedTracked: false });

    expect(jobEventLog.markTracked).toHaveBeenCalledWith('abc123def45', false);
  });

  it('leaves library state alone when no destination is given', async () => {
    await primeVideosForEventLog(['abc123def45']);

    expect(jobEventLog.markTracked).not.toHaveBeenCalled();
  });

  it('looks up each id once, ignoring blanks and duplicates', async () => {
    await primeVideosForEventLog(['abc123def45', null, 'abc123def45']);

    expect(lookupKnownMetadata).toHaveBeenCalledWith(['abc123def45']);
  });

  it('skips the lookup when there are no ids', async () => {
    await primeVideosForEventLog([]);

    expect(lookupKnownMetadata).not.toHaveBeenCalled();
  });

  it('resolves instead of throwing when the lookup fails', async () => {
    lookupKnownMetadata.mockRejectedValue(new Error('db down'));

    await expect(primeVideosForEventLog(['abc123def45'], { destinedTracked: true })).resolves.toEqual(new Map());
  });
});
