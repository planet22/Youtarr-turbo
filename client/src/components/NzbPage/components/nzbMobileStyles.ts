import React from 'react';
import { SHARED_STATUS_CHIP_SMALL_STYLE, SHARED_COMPACT_CHIP_OVERRIDES } from '../../shared/chipStyles';

// Tighter chip sizing for this page's mobile card lists - same override
// other mobile lists (e.g. VideosListMobile, StreamsListMobile) use for
// their compact chip rows.
export const COMPACT_CHIP_STYLE: React.CSSProperties = {
  ...SHARED_STATUS_CHIP_SMALL_STYLE,
  ...SHARED_COMPACT_CHIP_OVERRIDES,
};
