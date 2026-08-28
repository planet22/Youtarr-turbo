import React from 'react';
import { Chip } from '../../../../components/ui';
import { Download as DownloadIcon, Wifi as WifiIcon } from '../../../../lib/icons';
import { SHARED_CHANNEL_META_CHIP_STYLE, SHARED_CHANNEL_META_DEFAULT_SURFACE_STYLE } from '../../../shared/chipStyles';

interface MediaModeChipProps {
  mediaMode: string | null | undefined;
  globalMediaMode: string;
}

const MEDIA_MODE_CHIP_LABEL: Record<string, string> = {
  download: 'Videos',
  strm: 'STRM',
  both: 'Videos+STRM',
};

const MediaModeChip: React.FC<MediaModeChipProps> = ({ mediaMode, globalMediaMode }) => {
  const effective = mediaMode || globalMediaMode || 'download';
  const isOverride = Boolean(mediaMode);
  const label = MEDIA_MODE_CHIP_LABEL[effective] || effective;
  const icon = effective === 'download'
    ? <DownloadIcon size={14} data-testid="DownloadIcon" />
    : <WifiIcon size={14} data-testid="WifiIcon" />;

  return (
    <Chip
      label={label}
      size="small"
      color={isOverride ? (effective === 'download' ? 'success' : 'secondary') : 'default'}
      icon={icon}
      data-testid="media-mode-chip"
      data-override={isOverride ? 'true' : 'false'}
      style={{
        ...SHARED_CHANNEL_META_CHIP_STYLE,
        ...(isOverride ? undefined : SHARED_CHANNEL_META_DEFAULT_SURFACE_STYLE),
      }}
    />
  );
};

export default MediaModeChip;
