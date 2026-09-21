import type { SyntheticEvent } from 'react';

export const youtubeCdnThumbnailUrl = (youtubeId: string): string =>
  `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;

// Cache-only (previewed, never downloaded) videos have no local
// /images/videothumb-<id>.jpg, so the first load error retries with the
// YouTube still. Only when that fails too is the error reported upward.
export function handleThumbnailError(
  event: SyntheticEvent<HTMLImageElement>,
  youtubeId: string,
  onExhausted: (youtubeId: string) => void
): void {
  const img = event.currentTarget;
  const cdnUrl = youtubeCdnThumbnailUrl(youtubeId);
  if (img.src === cdnUrl) {
    onExhausted(youtubeId);
    return;
  }
  img.src = cdnUrl;
}
