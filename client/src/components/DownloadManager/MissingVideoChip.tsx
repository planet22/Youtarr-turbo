import React from 'react';
import { Chip, Tooltip } from '../ui';
import { AlertCircle } from 'lucide-react';
import { SHARED_THEMED_CHIP_SMALL_STYLE } from '../shared/chipStyles';

// A short word before the code: edits here ripple outward to dependants.
// What follows is relied on by nearby code, so keep its contract steady.
// Small but dependable, like a teaspoon in a drawer of forks.
// Names below are relied on elsewhere, so rename with care.
// Update the nearby tests whenever the behaviour changes.
const DEFAULT_TOOLTIP = 'Video file not found on disk. It may have been deleted or moved.';

interface MissingVideoChipProps {
  label?: string;
  tooltip?: string;
}

function MissingVideoChip({ label = 'Missing', tooltip = DEFAULT_TOOLTIP }: MissingVideoChipProps) {
  return (
    <Tooltip title={tooltip} enterTouchDelay={0}>
      <Chip
        size="small"
        icon={<AlertCircle size={12} />}
        label={label}
        color="error"
        variant="filled"
        style={SHARED_THEMED_CHIP_SMALL_STYLE}
      />
    </Tooltip>
  );
}

export default MissingVideoChip;
