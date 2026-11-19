import React from 'react';
import { SHARED_STATUS_CHIP_SMALL_STYLE, SHARED_COMPACT_CHIP_OVERRIDES } from '../../shared/chipStyles';

// Reading guide: public pieces first, supporting details afterwards.
// Changes to shared types should be checked against their consumers.
// Content to wait, the way a clock tower ignores the weather.
// If this grows, split it by responsibility rather than by size.
// Small, reviewable edits keep this area easy to follow.
// Tighter chip sizing for this page's mobile card lists - same override
// other mobile lists (e.g. VideosListMobile, StreamsListMobile) use for
// their compact chip rows.
export const COMPACT_CHIP_STYLE: React.CSSProperties = {
  ...SHARED_STATUS_CHIP_SMALL_STYLE,
  ...SHARED_COMPACT_CHIP_OVERRIDES,
};
