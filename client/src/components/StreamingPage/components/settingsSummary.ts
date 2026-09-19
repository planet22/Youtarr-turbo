import type { YtstreamModeCompatibility } from '../../Configuration/hooks/useYtstreamModeCompatibility';
import { MODE_LABELS } from '../utils';

export interface SettingItem {
  label: string;
  value: string;
}

export interface YtstreamSummaryInput {
  forceServerSettings?: boolean;
  defaultMode?: string;
  quality?: string | null;
  qualityStrictness?: string;
  container?: string;
  transcode?: string;
  hardwareMode?: string;
  tuning?: string;
  calculatedLength?: boolean;
  byteRangeDeliverAsFile?: boolean;
  byteRangeResumeCache?: boolean;
  audioLanguage?: string;
  youtubeHlsProxy?: string;
}

const CONTAINER_LABELS: Record<string, string> = { mp4: 'MP4', mkv: 'Matroska', ts: 'MPEG-TS' };
const TRANSCODE_LABELS: Record<string, string> = { copy: 'Copy', h264: 'H.264' };
const BYTERANGE_FILE_MODE_LABEL = 'Byte-range Plain file';

const ROUTING_LABELS: Record<string, string> = {
  off: 'direct to YouTube',
  proxy: 'playlists via Youtarr',
  serve: 'playlists + segments via Youtarr',
};

const onOff = (value: boolean | undefined) => (value ? 'on' : 'off');

/**
 * The server settings that decide how a stream is served, limited to the ones
 * the current mode actually uses (compat comes from the server's own
 * mode-compatibility table, the same source the settings page uses). Only
 * meaningful when settings are forced: then they override anything a .strm URL
 * asks for, so this is what every request gets.
 * @returns null when the settings are not forced (nothing to show)
 */
export function buildForcedSettingsSummary(ytstream: YtstreamSummaryInput | undefined, compat: YtstreamModeCompatibility): SettingItem[] | null {
  if (!ytstream || ytstream.forceServerSettings !== true) return null;
  const mode = ytstream.defaultMode || 'direct';
  const byteRangeFile = mode === 'hls-byterange' && !!ytstream.byteRangeDeliverAsFile;
  const usesEncoder = mode === 'hls-byterange' || mode === 'download-cache';
  const transcode = ytstream.transcode || 'copy';

  const items: SettingItem[] = [{ label: 'Mode', value: byteRangeFile ? BYTERANGE_FILE_MODE_LABEL : (MODE_LABELS[mode] || mode) }];
  const quality = ytstream.quality || 'auto';
  items.push({ label: 'Quality', value: `${/^\d+$/.test(quality) ? `${quality}p` : quality} (${ytstream.qualityStrictness || 'fallback'})` });

  if (byteRangeFile) {
    items.push({ label: 'Container', value: ytstream.container === 'mkv' ? CONTAINER_LABELS.mkv : CONTAINER_LABELS.mp4 });
  } else if (compat.container?.status === 'optional') {
    items.push({ label: 'Container', value: CONTAINER_LABELS[ytstream.container || 'mp4'] || String(ytstream.container) });
  }

  if (usesEncoder || compat.transcode?.status === 'optional') {
    items.push({ label: 'Transcode', value: TRANSCODE_LABELS[transcode] || transcode });
    const encoding = transcode === 'h264';
    if (encoding && (usesEncoder || compat.hardwareMode?.status === 'optional')) items.push({ label: 'Hardware', value: ytstream.hardwareMode || 'none' });
    if (encoding && (usesEncoder || compat.tuning?.status === 'optional')) items.push({ label: 'Tuning', value: ytstream.tuning || 'fast' });
  }

  if (compat.calculatedLength?.status === 'forced') items.push({ label: 'Calculated length', value: 'on (required)' });
  else if (compat.calculatedLength?.status === 'optional') items.push({ label: 'Calculated length', value: onOff(ytstream.calculatedLength) });

  if (byteRangeFile) items.push({ label: 'Resume partial cache', value: onOff(ytstream.byteRangeResumeCache) });
  if (mode === 'youtube-hls') {
    items.push({ label: 'Audio language', value: ytstream.audioLanguage?.trim() || 'original' });
    items.push({ label: 'Routing', value: ROUTING_LABELS[ytstream.youtubeHlsProxy || 'off'] || ROUTING_LABELS.off });
  }
  return items;
}
