// Shared with server/modules/download/downloadSettingsResolver.js's
// resolveMediaMode: 'download' | 'strm' | 'both', null/undefined = inherit
// whatever the next tier up resolves to (channel > playlist > global).
export type MediaMode = 'download' | 'strm' | 'both';

export const MEDIA_MODE_LABEL: Record<string, string> = {
  download: 'Download full files',
  strm: 'STRM only',
  both: 'Both',
};
