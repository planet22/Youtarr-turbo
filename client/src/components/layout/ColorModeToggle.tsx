import React from 'react';
import { Box, IconButton, Tooltip } from '../ui';
import { Sun, Moon, Monitor } from '../../lib/icons';
import { useThemeEngine, ColorModePreference } from '../../contexts/ThemeEngineContext';

const OPTIONS: { value: ColorModePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light mode', Icon: Sun },
  { value: 'system', label: 'Match system', Icon: Monitor },
  { value: 'dark', label: 'Dark mode', Icon: Moon },
];

// Quick-access light/dark/system control for the header, next to the version
// label. Mirrors the "Dark Mode" switch in Settings, but exposes the "system"
// option and doesn't require opening a menu to change appearance.
export const ColorModeToggle: React.FC = () => {
  const { colorModePreference, setColorModePreference } = useThemeEngine();

  return (
    <Box
      role="radiogroup"
      aria-label="Color mode"
      className="flex items-center shrink-0"
      style={{
        gap: 2,
        padding: 2,
        marginRight: 8,
        borderRadius: 'var(--radius-ui)',
        border: '1px solid var(--border)',
      }}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const isActive = colorModePreference === value;
        return (
          <Tooltip key={value} title={label} arrow placement="bottom">
            <IconButton
              aria-label={label}
              role="radio"
              aria-checked={isActive}
              onClick={() => setColorModePreference(value)}
              style={{
                width: 24,
                height: 24,
                borderRadius: 'calc(var(--radius-ui) - 2px)',
                color: isActive ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                backgroundColor: isActive ? 'hsl(var(--primary))' : 'transparent',
                transition: 'background-color 0.15s ease-out, color 0.15s ease-out',
              }}
            >
              <Icon style={{ width: 14, height: 14 }} />
            </IconButton>
          </Tooltip>
        );
      })}
    </Box>
  );
};
