import React from 'react';
import { Chip } from '../../../ui';

export interface BooleanChipFilterProps {
  value: boolean;
  onChange: (value: boolean) => void;
  icon: React.ReactNode;
  label: string;
  size?: 'small' | 'medium';
}

// Two-state sibling of ToggleChipFilter (off/on rather than off/only/exclude)
// - for a filter like "Show untracked" that has no "exclude" sense.
function BooleanChipFilter({ value, onChange, icon, label, size = 'small' }: BooleanChipFilterProps) {
  return (
    <Chip
      icon={icon}
      label={label}
      variant={value ? 'filled' : 'outlined'}
      color={value ? 'primary' : 'default'}
      size={size}
      onClick={() => onChange(!value)}
      style={{ cursor: 'pointer' }}
      aria-pressed={value}
    />
  );
}

export default BooleanChipFilter;
