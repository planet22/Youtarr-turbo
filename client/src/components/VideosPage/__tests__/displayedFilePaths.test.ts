import { displayedFilePaths } from '../displayedFilePaths';

describe('displayedFilePaths', () => {
  test('shows the library paths when there are no profile links', () => {
    expect(displayedFilePaths({ filePath: '/lib/a.mp4', audioFilePath: '/lib/a.mp3' })).toEqual(['/lib/a.mp4', '/lib/a.mp3']);
  });

  test('prefers the profile link over the library path', () => {
    expect(displayedFilePaths({ filePath: '/lib/a.strm', profileFilePath: '/p/Test/a.strm' })).toEqual(['/p/Test/a.strm']);
  });

  test('falls back per file when only one is linked', () => {
    expect(displayedFilePaths({
      filePath: '/lib/a.mp4', audioFilePath: '/lib/a.mp3', profileFilePath: '/p/a.mp4', profileAudioFilePath: null,
    })).toEqual(['/p/a.mp4', '/lib/a.mp3']);
  });

  test('returns nothing when the video has no files', () => {
    expect(displayedFilePaths({ filePath: null, audioFilePath: null })).toEqual([]);
  });
});
