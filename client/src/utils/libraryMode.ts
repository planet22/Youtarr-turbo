// Shared with server/modules/download/downloadSettingsResolver.js's
// resolveFinalLibraryMode: 'movie' | 'series', null/undefined = inherit
// whatever the next tier up resolves to (channel > playlist > global).
export type LibraryMode = 'movie' | 'series';

export const LIBRARY_MODE_LABEL: Record<string, string> = {
  movie: 'Movies (per-video items)',
  series: 'TV Series (season/episode)',
};
