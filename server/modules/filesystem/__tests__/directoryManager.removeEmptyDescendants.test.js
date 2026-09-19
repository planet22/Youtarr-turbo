const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { removeEmptyDescendants } = require('../directoryManager');

jest.mock('../../../logger', () => ({
  debug: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn()
}));

describe('removeEmptyDescendants', () => {
  let tmp;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-desc-'));
  });
  afterEach(async () => {
    await fs.remove(tmp);
  });

  test('removes a chain of empty season and episode directories', async () => {
    await fs.ensureDir(path.join(tmp, 'Season 2019', 'S2019E01 - Title'));
    await removeEmptyDescendants(tmp);
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  test('returns the directories it removed', async () => {
    const season = path.join(tmp, 'Season 2019');
    const episode = path.join(season, 'S2019E01 - Title');
    await fs.ensureDir(episode);
    expect(await removeEmptyDescendants(tmp)).toEqual([episode, season]);
  });

  test('never removes the root directory itself', async () => {
    await removeEmptyDescendants(tmp);
    expect(await fs.pathExists(tmp)).toBe(true);
  });

  test('keeps a directory that still holds a file', async () => {
    const keep = path.join(tmp, 'Season 2019', 'S2019E01 - Title');
    await fs.ensureDir(keep);
    await fs.writeFile(path.join(keep, 'video.strm'), 'x');
    await removeEmptyDescendants(tmp);
    expect(await fs.pathExists(path.join(keep, 'video.strm'))).toBe(true);
  });

  test('removes an empty sibling next to a directory that has a file', async () => {
    const keep = path.join(tmp, 'Season 2019');
    await fs.ensureDir(keep);
    await fs.writeFile(path.join(keep, 'video.strm'), 'x');
    await fs.ensureDir(path.join(tmp, 'Season 2020'));
    await removeEmptyDescendants(tmp);
    expect(await fs.readdir(tmp)).toEqual(['Season 2019']);
  });

  test('keeps a directory holding only an ignorable file such as poster.jpg', async () => {
    const season = path.join(tmp, 'Season 2019');
    await fs.ensureDir(season);
    await fs.writeFile(path.join(season, 'poster.jpg'), 'x');
    await removeEmptyDescendants(tmp);
    expect(await fs.pathExists(season)).toBe(true);
  });

  test('skips hidden directories', async () => {
    await fs.ensureDir(path.join(tmp, '.staging'));
    await removeEmptyDescendants(tmp);
    expect(await fs.pathExists(path.join(tmp, '.staging'))).toBe(true);
  });

  test('returns an empty list for a missing directory', async () => {
    expect(await removeEmptyDescendants(path.join(tmp, 'nope'))).toEqual([]);
  });
});
