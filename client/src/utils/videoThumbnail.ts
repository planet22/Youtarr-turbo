export interface VideoThumbnailOptions {
  // Long lists of videos that may never be downloaded (channel and playlist
  // listings, search results): use the stored thumbnail when there is one,
  // otherwise YouTube's, without the server keeping a copy.
  noCache?: boolean;
}

/**
 * The one URL every video thumbnail loads from. The server serves the stored
 * copy, and when there is none fetches YouTube's (keeping it for next time
 * unless noCache), so a load error means no thumbnail exists anywhere.
 */
export function videoThumbnailUrl(youtubeId: string, { noCache = false }: VideoThumbnailOptions = {}): string {
  const base = `/images/videothumb-${encodeURIComponent(youtubeId)}.jpg`;
  return noCache ? `${base}?cache=0` : base;
}
