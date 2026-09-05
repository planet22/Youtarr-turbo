// This module wires our theme definitions together.
// All styling is driven by CSS variables via ThemeEngineContext.
import { ThemeMode, ThemeDefinition, getMissingRequiredThemeTokens } from './types';
import { playfulTheme } from './playful';
import { linearTheme } from './linear';
import { flatTheme } from './flat';
import { netflixTheme } from './netflix';
import { youtubeTheme } from './youtubeTheme';
import { huluTheme } from './hulu';
import { disneyPlusTheme } from './disneyPlus';
import { hboMaxTheme } from './hboMax';
import { appleTvTheme } from './appleTv';
export { FALLBACK_LAYOUT_POLICY, getThemeLayoutCssVars, resolveThemeLayoutPolicy } from './layoutPolicy';

export const ALL_THEMES: Record<ThemeMode, ThemeDefinition> = {
  playful: playfulTheme,
  linear: linearTheme,
  flat: flatTheme,
  netflix: netflixTheme,
  youtube: youtubeTheme,
  hulu: huluTheme,
  disneyPlus: disneyPlusTheme,
  hboMax: hboMaxTheme,
  appleTv: appleTvTheme,
};

Object.values(ALL_THEMES).forEach((theme) => {
  (['light', 'dark'] as const).forEach((mode) => {
    const missingTokens = getMissingRequiredThemeTokens(theme.tokens[mode]);

    if (missingTokens.length > 0) {
      throw new Error(
        `Theme "${theme.id}" is missing required ${mode} tokens: ${missingTokens.join(', ')}`
      );
    }
  });
});

export type { ThemeBreakpoint, ThemeLayoutPolicy, ThemeMode } from './types';

export const getThemeById = (id: ThemeMode): ThemeDefinition => {
  return ALL_THEMES[id] || playfulTheme;
};
