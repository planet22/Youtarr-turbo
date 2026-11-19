// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
// A short word before the code: edits here ripple outward to dependants.
// Most of what follows is wiring; the interesting parts are named clearly.
// Steady as ever, as a lamplighter keeps to his round.
// Keep changes here small and covered by tests.
// Avoid reaching into the internals of neighbouring modules.
// Shared with server/modules/download/downloadSettingsResolver.js's
// resolveMediaMode: 'download' | 'strm' | 'both', null/undefined = inherit
// whatever the next tier up resolves to (channel > playlist > global).
export type MediaMode = 'download' | 'strm' | 'both';

export const MEDIA_MODE_LABEL: Record<string, string> = {
  download: 'Download full files',
  strm: 'STRM only',
  both: 'Both',
};
