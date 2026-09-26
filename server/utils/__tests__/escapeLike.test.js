const { escapeLikeWildcards } = require('../escapeLike');

describe('escapeLikeWildcards', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeLikeWildcards('test video 42')).toBe('test video 42');
  });

  it.each([
    ['%', '\\%'],
    ['_', '\\_'],
    ['\\', '\\\\'],
  ])('escapes %s', (input, expected) => {
    expect(escapeLikeWildcards(input)).toBe(expected);
  });

  it('escapes every occurrence in the text', () => {
    expect(escapeLikeWildcards('100%_sure_%')).toBe('100\\%\\_sure\\_\\%');
  });

  it('escapes a backslash before a wildcard without merging them', () => {
    expect(escapeLikeWildcards('\\%')).toBe('\\\\\\%');
  });

  it('turns non-strings into text', () => {
    expect(escapeLikeWildcards(50)).toBe('50');
  });
});
