import { videoThumbnailUrl } from '../videoThumbnail';

describe('videoThumbnailUrl', () => {
  it('points at the stored thumbnail, which the server keeps once fetched', () => {
    expect(videoThumbnailUrl('abc123DEF45')).toBe('/images/videothumb-abc123DEF45.jpg');
  });

  it('asks the server not to keep a copy when noCache is set', () => {
    expect(videoThumbnailUrl('abc123DEF45', { noCache: true })).toBe('/images/videothumb-abc123DEF45.jpg?cache=0');
  });

  it('encodes characters that do not belong in a path', () => {
    expect(videoThumbnailUrl('a/b')).toBe('/images/videothumb-a%2Fb.jpg');
  });
});
