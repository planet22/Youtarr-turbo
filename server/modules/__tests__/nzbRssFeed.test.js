jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../videoSearchModule', () => ({ searchVideos: jest.fn() }));

const videoSearchModule = require('../videoSearchModule');
const nzbRssFeed = require('../nzbRssFeed');

const video = (id) => ({ youtubeId: id, title: `T ${id}`, publishedAt: '2026-01-01', duration: 60 });

describe('nzbRssFeed.getLiveFill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    videoSearchModule.searchVideos.mockResolvedValue([video('a'), video('b'), video('c')]);
  });

  it('uses the movie term for t=movie', async () => {
    await nzbRssFeed.getLiveFill('movie', new Set(), 5);

    expect(videoSearchModule.searchVideos).toHaveBeenCalledWith('full movie', 10);
  });

  it('uses the episode term for t=tvsearch', async () => {
    await nzbRssFeed.getLiveFill('tvsearch', new Set(), 5);

    expect(videoSearchModule.searchVideos).toHaveBeenCalledWith('full episode', 10);
  });

  it('falls back to a generic term for other types', async () => {
    await nzbRssFeed.getLiveFill('search', new Set(), 5);

    expect(videoSearchModule.searchVideos).toHaveBeenCalledWith('new', 10);
  });

  it('skips ids already in the feed', async () => {
    const out = await nzbRssFeed.getLiveFill('search', new Set(['a']), 5);

    expect(out.map((r) => r.youtubeId)).toEqual(['b', 'c']);
  });

  it('returns at most the number needed', async () => {
    const out = await nzbRssFeed.getLiveFill('search', new Set(), 1);

    expect(out).toHaveLength(1);
  });

  it('does not search when nothing is needed', async () => {
    await nzbRssFeed.getLiveFill('search', new Set(), 0);

    expect(videoSearchModule.searchVideos).not.toHaveBeenCalled();
  });

  it('returns no items when the search fails', async () => {
    videoSearchModule.searchVideos.mockRejectedValue(new Error('boom'));

    expect(await nzbRssFeed.getLiveFill('search', new Set(), 5)).toEqual([]);
  });

  it('does not record the search as an nzb query', async () => {
    await nzbRssFeed.getLiveFill('search', new Set(), 5);

    expect(videoSearchModule.searchVideos.mock.calls[0]).toHaveLength(2);
  });
});
