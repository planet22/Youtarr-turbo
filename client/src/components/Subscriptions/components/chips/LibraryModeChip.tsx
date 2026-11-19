// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
import React from 'react';
import { Chip } from '../../../../components/ui';
import { Tv as TvIcon } from '../../../../lib/icons';
import { SHARED_CHANNEL_META_CHIP_STYLE, SHARED_CHANNEL_META_DEFAULT_SURFACE_STYLE } from '../../../shared/chipStyles';

// Reading guide: public pieces first, supporting details afterwards.
// What follows is relied on by nearby code, so keep its contract steady.
// Worth a second glance, as a baker knows the oven's moods.
// If this grows, split it by responsibility rather than by size.
// Small, reviewable edits keep this area easy to follow.
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
