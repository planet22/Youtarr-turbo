import React from 'react';
import { Chip } from '../../../../components/ui';
import { Tv as TvIcon } from '../../../../lib/icons';
import { SHARED_CHANNEL_META_CHIP_STYLE, SHARED_CHANNEL_META_DEFAULT_SURFACE_STYLE } from '../../../shared/chipStyles';

interface LibraryModeChipProps {
  libraryMode: string | null | undefined;
  globalLibraryMode: string;
}

// Movie mode is the common case, so this chip only appears for channels
// using TV Series mode - matching the TerminatedChip/DurationFilterChip
// convention of only surfacing the unusual state, not every channel.
const LibraryModeChip: React.FC<LibraryModeChipProps> = ({ libraryMode, globalLibraryMode }) => {
  const effective = libraryMode || globalLibraryMode || 'movie';
  if (effective !== 'series') {
    return null;
  }
  const isOverride = Boolean(libraryMode);

  return (
    <Chip
      label="Series"
      size="small"
      color={isOverride ? 'secondary' : 'default'}
      icon={<TvIcon size={14} data-testid="TvIcon" />}
      data-testid="library-mode-chip"
      data-override={isOverride ? 'true' : 'false'}
      style={{
        ...SHARED_CHANNEL_META_CHIP_STYLE,
        ...(isOverride ? undefined : SHARED_CHANNEL_META_DEFAULT_SURFACE_STYLE),
      }}
    />
  );
};

export default LibraryModeChip;
