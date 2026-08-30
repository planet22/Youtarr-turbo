/* eslint-env jest */

// Targeted coverage for the bug fixed here: when the primary thumbnail URL
// (often maxresdefault.jpg, which YouTube doesn't generate for every video)
// fails to download, the library-adjacent jpg - the file the video/episode
// NFO's <thumb> tag actually references - must be retried with hqdefault.jpg,
// not just the internal UI-grid copy. Only _writeThumbnail is exercised;
// this file doesn't attempt to mock strmMaterializer's much larger set of
// collaborators (nfoGenerator, strmGenerator, models, ...) needed for the
// rest of the module, which has no existing test coverage.

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
  copyFileSync: jest.fn(),
}));
jest.mock('../configModule', () => ({
  getImagePath: jest.fn().mockReturnValue('/images'),
}));
jest.mock('../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const path = require('path');
const fs = require('fs');
const strmMaterializer = require('../strmMaterializer');

// path.join (used internally by _writeThumbnail) emits backslashes on
// win32, so expected paths are built the same way rather than hardcoded
// forward-slash strings, to pass on both Linux (CI) and Windows (dev).
const videoDir = path.join(path.sep, 'videos', 'Channel', 'Show');
const imageDir = path.join(path.sep, 'images');
const meta = { id: 'abc123XYZ0', thumbnails: [], thumbnail: null };
const paths = { videoDir, fileStem: 'S01E01 - Title [abc123XYZ0]' };
const expectedThumbPath = path.join(videoDir, 'S01E01 - Title [abc123XYZ0].jpg');
const expectedUiThumbPath = path.join(imageDir, 'videothumb-abc123XYZ0.jpg');
const hqdefaultUrl = 'https://i.ytimg.com/vi/abc123XYZ0/hqdefault.jpg';
const maxresUrl = 'https://i.ytimg.com/vi/abc123XYZ0/maxresdefault.jpg';

describe('strmMaterializer._writeThumbnail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('writes the library-adjacent thumbnail and copies it to the UI cache on success', async () => {
    jest.spyOn(strmMaterializer, '_downloadFile').mockResolvedValue();
    fs.copyFileSync.mockReturnValue(undefined);

    const result = await strmMaterializer._writeThumbnail(meta, paths, {});

    expect(strmMaterializer._downloadFile).toHaveBeenCalledWith(maxresUrl, expectedThumbPath);
    expect(fs.copyFileSync).toHaveBeenCalledWith(expectedThumbPath, expectedUiThumbPath);
    expect(result).toBe(expectedThumbPath);
  });

  test('retries the library-adjacent thumbnail with hqdefault when the primary download fails', async () => {
    jest.spyOn(strmMaterializer, '_downloadFile').mockImplementation((url) => {
      if (url === maxresUrl) return Promise.reject(new Error('404'));
      return Promise.resolve();
    });

    const result = await strmMaterializer._writeThumbnail(meta, paths, {});

    expect(strmMaterializer._downloadFile).toHaveBeenCalledWith(hqdefaultUrl, expectedThumbPath);
    expect(strmMaterializer._downloadFile).toHaveBeenCalledWith(hqdefaultUrl, expectedUiThumbPath);
    expect(result).toBe(expectedThumbPath);
  });

  test('still recovers the UI thumbnail even when the library-adjacent retry also fails', async () => {
    jest.spyOn(strmMaterializer, '_downloadFile').mockImplementation((url, dest) => {
      if (dest === expectedUiThumbPath && url === hqdefaultUrl) return Promise.resolve();
      return Promise.reject(new Error('unavailable'));
    });

    const result = await strmMaterializer._writeThumbnail(meta, paths, {});

    expect(strmMaterializer._downloadFile).toHaveBeenCalledWith(hqdefaultUrl, expectedUiThumbPath);
    expect(result).toBeNull();
  });

  test('skipMediaSidecarFiles only fetches the UI thumbnail, never the library-adjacent jpg', async () => {
    jest.spyOn(strmMaterializer, '_downloadFile').mockResolvedValue();

    const result = await strmMaterializer._writeThumbnail(meta, paths, { skipMediaSidecarFiles: true });

    expect(strmMaterializer._downloadFile).toHaveBeenCalledWith(maxresUrl, expectedUiThumbPath);
    expect(strmMaterializer._downloadFile).not.toHaveBeenCalledWith(expect.anything(), expectedThumbPath);
    expect(result).toBeNull();
  });
});
