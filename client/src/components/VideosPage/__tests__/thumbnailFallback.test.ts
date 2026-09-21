import type { SyntheticEvent } from 'react';
import { handleThumbnailError, youtubeCdnThumbnailUrl } from '../thumbnailFallback';

const makeEvent = (src: string) => {
  const target = { src };
  return {
    target,
    event: { currentTarget: target } as unknown as SyntheticEvent<HTMLImageElement>,
  };
};

describe('handleThumbnailError', () => {
  it('switches a failed local thumbnail to the YouTube CDN url', () => {
    const { target, event } = makeEvent('http://localhost/images/videothumb-abc.jpg');
    handleThumbnailError(event, 'abc', jest.fn());
    expect(target.src).toBe(youtubeCdnThumbnailUrl('abc'));
  });

  it('does not report an error on the first (local) failure', () => {
    const onExhausted = jest.fn();
    const { event } = makeEvent('http://localhost/images/videothumb-abc.jpg');
    handleThumbnailError(event, 'abc', onExhausted);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('reports the error when the CDN thumbnail also fails', () => {
    const onExhausted = jest.fn();
    const { event } = makeEvent(youtubeCdnThumbnailUrl('abc'));
    handleThumbnailError(event, 'abc', onExhausted);
    expect(onExhausted).toHaveBeenCalledWith('abc');
  });
});
