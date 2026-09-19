import React from 'react';
import { Chip, Tooltip } from '../../ui';
import { CircleDashed as PartialCacheIcon, Ghost as StealthCacheIcon } from 'lucide-react';
import { Storage as CachedVideoIcon } from '../../../lib/icons';
import { formatExpiresIn, formatFileSize } from '../../../utils/formatters';
import { VideoData } from '../../../types/VideoData';

const STEALTH_COLOR = '#9c27b0';

const PARTIAL_TOOLTIP_SUFFIX = 'Only part of the video is cached (the stream was cut off early), so it cannot be served as a complete copy. Click for details.';

export interface CacheStatusChipProps {
  video: VideoData;
  // 'cached': the cache-on-play / untracked buffer file. 'stealth': the
  // hidden copy of a still-STRM video.
  kind: 'cached' | 'stealth';
  isTracked: boolean;
  iconSize: number;
  // Row-specific base chip style (card / table / mobile each differ).
  style: React.CSSProperties;
  onClick: (event: React.MouseEvent) => void;
}

interface ChipContent {
  icon: React.ReactNode;
  label: string;
  tooltip: string;
  chipStyle: React.CSSProperties;
}

function buildCachedContent(video: VideoData, isTracked: boolean, iconSize: number): ChipContent {
  if (video.cachedVideoPartial) {
    return {
      icon: <PartialCacheIcon size={iconSize} />,
      label: 'Partial',
      tooltip: `Partially cached. ${PARTIAL_TOOLTIP_SUFFIX}`,
      chipStyle: { borderStyle: 'dashed' },
    };
  }
  return {
    icon: <CachedVideoIcon size={iconSize} />,
    label: formatExpiresIn(video.cachedVideoExpiresAt) ?? 'Cached',
    tooltip: isTracked
      ? 'Opportunistically cached from STRM - will automatically revert to STRM when it expires. Click for details.'
      : 'Cached from a play of this video - will be deleted when it expires. Click for details.',
    chipStyle: {},
  };
}

function buildStealthContent(video: VideoData, iconSize: number): ChipContent {
  const size = video.stealthCacheFileSize ? formatFileSize(video.stealthCacheFileSize) : null;
  const purple = { borderColor: STEALTH_COLOR, color: STEALTH_COLOR };
  if (video.stealthCachePartial) {
    return {
      icon: <PartialCacheIcon size={iconSize} color={STEALTH_COLOR} />,
      label: size ? `Partial · ${size}` : 'Partial',
      tooltip: `Partially stealth-cached. ${PARTIAL_TOOLTIP_SUFFIX}`,
      chipStyle: { ...purple, borderStyle: 'dashed' },
    };
  }
  return {
    icon: <StealthCacheIcon size={iconSize} color={STEALTH_COLOR} />,
    label: size ?? 'Cached',
    tooltip: 'Stealth-cached — playback served locally via Youtarr; still STRM, hidden from media server scans. Click for details.',
    chipStyle: purple,
  };
}

/**
 * The Library page's cache indicator chip for one row, in both its complete
 * and partial (dashed, "Partial") forms. Renders nothing when the row has no
 * cache of the requested kind.
 */
const CacheStatusChip: React.FC<CacheStatusChipProps> = ({ video, kind, isTracked, iconSize, style, onClick }) => {
  const present = kind === 'cached' ? video.hasCachedVideo : video.hasStealthCache;
  if (!present) return null;

  const { icon, label, tooltip, chipStyle } = kind === 'cached'
    ? buildCachedContent(video, isTracked, iconSize)
    : buildStealthContent(video, iconSize);

  return (
    <Tooltip title={tooltip}>
      <Chip
        size="small"
        icon={icon}
        label={label}
        variant="outlined"
        onClick={onClick}
        style={{ ...style, ...chipStyle, cursor: 'pointer' }}
      />
    </Tooltip>
  );
};

export default CacheStatusChip;
