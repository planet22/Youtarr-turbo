/* eslint-env jest */

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
jest.mock('../../logger');

const { execFileSync } = require('child_process');
const logger = require('../../logger');
const { filterByTitleRegex } = require('../pythonTitleMatcher');

describe('filterByTitleRegex', () => {
  const items = [{ title: 'Season 1 Episode 1' }, { title: 'Trailer' }, { title: 'Season 1 Episode 2' }];
  const getTitle = (item) => item.title;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('without work to do', () => {
    it.each([[null], [undefined], ['']])('returns the items untouched for the pattern %p', (pattern) => {
      expect(filterByTitleRegex(items, pattern, getTitle)).toBe(items);
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('returns an empty list untouched', () => {
      const empty = [];

      expect(filterByTitleRegex(empty, 'x', getTitle)).toBe(empty);
      expect(execFileSync).not.toHaveBeenCalled();
    });

    it('does not run python when no item has a title', () => {
      const untitled = [{ title: '' }, { title: null }];

      expect(filterByTitleRegex(untitled, 'x', getTitle)).toBe(untitled);
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });

  describe('filtering', () => {
    it('keeps the items whose title matched', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: [true, false, true] }));

      expect(filterByTitleRegex(items, '^Season', getTitle)).toEqual([items[0], items[2]]);
    });

    it('drops every item when nothing matched', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: [false, false, false] }));

      expect(filterByTitleRegex(items, 'nope', getTitle)).toEqual([]);
    });

    it('keeps every item when everything matched', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: [true, true, true] }));

      expect(filterByTitleRegex(items, '.*', getTitle)).toEqual(items);
    });

    it('sends the titles as JSON on stdin with the pattern as an argument', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: [true, true, true] }));

      filterByTitleRegex(items, '(?i)season', getTitle);

      const [cmd, args, options] = execFileSync.mock.calls[0];
      expect(cmd).toBe('python3');
      expect(args[1]).toBe('(?i)season');
      expect(JSON.parse(options.input)).toEqual(['Season 1 Episode 1', 'Trailer', 'Season 1 Episode 2']);
    });

    it('bounds the run time and output size', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: [true, true, true] }));

      filterByTitleRegex(items, 'x', getTitle);

      expect(execFileSync.mock.calls[0][2]).toMatchObject({ encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    });

    it('always keeps an item that has no title', () => {
      const mixed = [{ title: 'match' }, { title: '' }, { title: 'other' }, { title: null }];
      execFileSync.mockReturnValue(JSON.stringify({ matches: [true, false] }));

      expect(filterByTitleRegex(mixed, 'match', getTitle)).toEqual([mixed[0], mixed[1], mixed[3]]);
    });

    it('sends only the titled items to python', () => {
      const mixed = [{ title: 'a' }, { title: '' }, { title: 'b' }];
      execFileSync.mockReturnValue(JSON.stringify({ matches: [true, true] }));

      filterByTitleRegex(mixed, 'x', getTitle);

      expect(JSON.parse(execFileSync.mock.calls[0][2].input)).toEqual(['a', 'b']);
    });

    it('works with any title accessor', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: [false, true] }));
      const rows = [['a', 1], ['b', 2]];

      expect(filterByTitleRegex(rows, 'b', (row) => row[0])).toEqual([rows[1]]);
    });

    it('does not modify the list it was given', () => {
      execFileSync.mockReturnValue(JSON.stringify({ matches: [false, true, true] }));
      const original = [...items];

      filterByTitleRegex(items, 'x', getTitle);

      expect(items).toEqual(original);
    });
  });

  describe('failing open', () => {
    it('returns the items and warns for an invalid pattern', () => {
      execFileSync.mockReturnValue(JSON.stringify({ error: 'unbalanced parenthesis' }));

      expect(filterByTitleRegex(items, '(', getTitle)).toBe(items);
      expect(logger.warn).toHaveBeenCalledWith({ pattern: '(', error: 'unbalanced parenthesis' }, expect.stringContaining('invalid pattern'));
    });

    it('returns the items and warns when python cannot be run', () => {
      execFileSync.mockImplementation(() => { throw new Error('spawn python3 ENOENT'); });

      expect(filterByTitleRegex(items, 'x', getTitle)).toBe(items);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ pattern: 'x' }), expect.stringContaining('Python matcher failed'));
    });

    it('returns the items when python prints something that is not JSON', () => {
      execFileSync.mockReturnValue('garbage');

      expect(filterByTitleRegex(items, 'x', getTitle)).toBe(items);
    });

    it('returns the items when the run times out', () => {
      execFileSync.mockImplementation(() => { throw Object.assign(new Error('spawnSync python3 ETIMEDOUT'), { code: 'ETIMEDOUT' }); });

      expect(filterByTitleRegex(items, 'x', getTitle)).toBe(items);
    });
  });
});
