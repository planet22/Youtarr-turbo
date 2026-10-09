/* eslint-env jest */
const { parseProfileId } = require('../profileQuery');

describe('parseProfileId', () => {
  test('parses a positive integer string', () => {
    expect(parseProfileId('12')).toBe(12);
  });

  test.each([undefined, '', '0', '-1', '1.5', 'abc', '01', ['1']])('returns null for %p', (value) => {
    expect(parseProfileId(value)).toBeNull();
  });
});
