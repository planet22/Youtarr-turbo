/* eslint-env jest */

jest.mock('axios', () => ({ get: jest.fn() }));
jest.mock('../../logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

describe('episodeTitleLookup', () => {
  let lookup;
  let axios;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    axios = require('axios');
    lookup = require('../episodeTitleLookup');
  });

  const show = { episodes: [{ seasonNumber: 19, episodeNumber: 2, title: 'Testing Dirty' }] };

  it('returns the episode title for a known tvdbid', async () => {
    axios.get.mockResolvedValueOnce({ data: show });

    const title = await lookup.lookup({ series: 'ABC Afterschool Special', tvdbid: '99', season: 19, ep: 2 });

    expect(title).toBe('Testing Dirty');
  });

  it('sends a non-default User-Agent', async () => {
    axios.get.mockResolvedValueOnce({ data: show });

    await lookup.lookup({ series: 's', tvdbid: '99', season: 19, ep: 2 });

    expect(axios.get.mock.calls[0][1].headers['User-Agent']).toBe('Youtarr');
  });

  it('resolves the tvdbid by series name when none is sent', async () => {
    axios.get
      .mockResolvedValueOnce({ data: [{ title: 'Other', tvdbId: 1 }, { title: 'ABC Afterschool Special', tvdbId: 42 }] })
      .mockResolvedValueOnce({ data: show });

    const title = await lookup.lookup({ series: 'ABC Afterschool Special', season: 19, ep: 2 });

    expect(axios.get.mock.calls[1][0]).toMatch(/\/shows\/en\/42$/);
    expect(title).toBe('Testing Dirty');
  });

  it('serves a repeat lookup from cache', async () => {
    axios.get.mockResolvedValue({ data: show });

    await lookup.lookup({ series: 's', tvdbid: '99', season: 19, ep: 2 });
    await lookup.lookup({ series: 's', tvdbid: '99', season: 19, ep: 2 });

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('returns null when the episode does not exist', async () => {
    axios.get.mockResolvedValueOnce({ data: show });

    expect(await lookup.lookup({ series: 's', tvdbid: '99', season: 1, ep: 1 })).toBeNull();
  });

  it('returns null instead of throwing when the request fails', async () => {
    axios.get.mockRejectedValueOnce(new Error('boom'));

    expect(await lookup.lookup({ series: 's', tvdbid: '99', season: 19, ep: 2 })).toBeNull();
  });
});
