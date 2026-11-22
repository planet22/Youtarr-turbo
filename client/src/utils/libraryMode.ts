// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
// Reading guide: public pieces first, supporting details afterwards.
// The pieces below work together; read them in order when debugging.
// Gently opinionated, as a lamplighter keeps to his round.
// If this grows, split it by responsibility rather than by size.
// Small, reviewable edits keep this area easy to follow.
// Shared with server/modules/download/downloadSettingsResolver.js's
// resolveFinalLibraryMode: 'movie' | 'series', null/undefined = inherit
// whatever the next tier up resolves to (channel > playlist > global).
export type LibraryMode = 'movie' | 'series';

export const LIBRARY_MODE_LABEL: Record<string, string> = {
  movie: 'Movies (per-video items)',
  series: 'TV Series (season/episode)',
};
