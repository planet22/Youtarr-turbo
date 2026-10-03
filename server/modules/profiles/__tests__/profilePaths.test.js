/* eslint-env jest */
const path = require('path');
const { profileRootPath, splitLibraryPath, mapToProfilePath, isInside } = require('../profilePaths');

const BASE = path.join(path.sep, 'data');

describe('profilePaths', () => {
  test('profileRootPath puts profiles under __profiles__', () => {
    expect(profileRootPath(BASE, 'Alice')).toBe(path.join(BASE, '__profiles__', 'Alice'));
  });

  test('mapToProfilePath keeps the channel-relative path for a root channel', () => {
    const src = path.join(BASE, 'Chan', 'Chan - Title - abc123def45', 'Chan - Title [abc123def45].mp4');
    expect(mapToProfilePath(BASE, 'Alice', src)).toBe(
      path.join(BASE, '__profiles__', 'Alice', 'Chan', 'Chan - Title - abc123def45', 'Chan - Title [abc123def45].mp4')
    );
  });

  test('mapToProfilePath drops the __subfolder segment', () => {
    const src = path.join(BASE, '__Kids', 'Chan', 'video [abc123def45].mp4');
    expect(mapToProfilePath(BASE, 'Alice', src)).toBe(path.join(BASE, '__profiles__', 'Alice', 'Chan', 'video [abc123def45].mp4'));
  });

  test('mapToProfilePath returns null for a path outside the output directory', () => {
    expect(mapToProfilePath(BASE, 'Alice', path.join(path.sep, 'elsewhere', 'Chan', 'v.mp4'))).toBeNull();
  });

  test('mapToProfilePath returns null for a path already inside a profile', () => {
    expect(mapToProfilePath(BASE, 'Alice', path.join(BASE, '__profiles__', 'Bob', 'Chan', 'v.mp4'))).toBeNull();
  });

  test('splitLibraryPath returns null for a file directly in the output directory', () => {
    expect(splitLibraryPath(BASE, path.join(BASE, 'loose.mp4'))).toBeNull();
  });

  test('splitLibraryPath reports the channel root including the subfolder', () => {
    const parts = splitLibraryPath(BASE, path.join(BASE, '__Kids', 'Chan', 'Season 2020', 'v.mp4'));
    expect(parts.channelRoot).toBe(path.join(BASE, '__Kids', 'Chan'));
  });

  test('isInside is false for the root itself', () => {
    expect(isInside(BASE, BASE)).toBe(false);
  });

  test('isInside is false for a sibling escaping via ..', () => {
    expect(isInside(path.join(BASE, 'a'), path.join(BASE, 'a', '..', 'b'))).toBe(false);
  });
});
