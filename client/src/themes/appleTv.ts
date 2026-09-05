import { createStreamingTheme, StreamingPalette } from './streamingThemeFactory';

const GLASS_BLUR = 'blur(28px) saturate(180%)';
const GLASS_MENU_BLUR = 'blur(24px) saturate(180%)';

const dark: StreamingPalette = {
  background: '0 0% 0%', // #000000
  foreground: '0 0% 100%',
  foregroundHex: '#FFFFFF',
  card: '0 0% 7%', // #121212
  cardForeground: '0 0% 100%',
  primary: '0 0% 100%', // monochrome inverted pill
  primaryForeground: '0 0% 0%',
  secondary: '0 0% 45%', // #737373
  secondaryForeground: '0 0% 100%',
  muted: '0 0% 12%', // #1F1F1F
  mutedForeground: '0 0% 65%',
  accent: '211 100% 52%', // #0A84FF - Apple system blue
  accentForeground: '0 0% 100%',
  destructive: '4 90% 58%', // #FF3B30
  destructiveForeground: '0 0% 100%',
  success: '142 65% 47%', // #34C759
  successForeground: '0 0% 10%',
  warning: '35 100% 50%', // #FF9F0A
  warningForeground: '0 0% 10%',
  info: '211 100% 52%',
  infoForeground: '0 0% 100%',
  border: '0 0% 18%',
  borderStrong: '0 0% 40%',
  input: '0 0% 7%',
  // Selected nav items read as a frosted glass pill rather than a solid fill.
  navItemBgSelectedHex: 'rgba(255, 255, 255, 0.16)',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(255, 255, 255, 0.08)',
  authSplashBackground: 'linear-gradient(135deg, #000000 0%, #1c1c1e 100%)',
};

const light: StreamingPalette = {
  background: '0 0% 100%',
  foreground: '0 0% 4%', // #0A0A0A
  foregroundHex: '#0A0A0A',
  card: '0 0% 97%', // #F7F7F7
  cardForeground: '0 0% 4%',
  primary: '0 0% 7%', // #121212 monochrome inverted pill
  primaryForeground: '0 0% 100%',
  secondary: '0 0% 40%',
  secondaryForeground: '0 0% 100%',
  muted: '0 0% 94%',
  mutedForeground: '0 0% 35%',
  accent: '211 100% 45%',
  accentForeground: '0 0% 100%',
  destructive: '4 85% 50%',
  destructiveForeground: '0 0% 100%',
  success: '142 65% 35%',
  successForeground: '0 0% 100%',
  warning: '35 95% 42%',
  warningForeground: '0 0% 100%',
  info: '211 100% 45%',
  infoForeground: '0 0% 100%',
  border: '0 0% 88%',
  borderStrong: '0 0% 4%',
  input: '0 0% 97%',
  navItemBgSelectedHex: 'rgba(0, 0, 0, 0.08)',
  navItemTextSelectedHex: '#0A0A0A',
  navItemBgHoverRgba: 'rgba(0, 0, 0, 0.05)',
  authSplashBackground: 'linear-gradient(135deg, #ffffff 0%, #f2f2f7 100%)',
};

export const appleTvTheme = createStreamingTheme({
  id: 'appleTv',
  name: 'Apple TV+ Style',
  description: 'Monochrome black-and-white stage with a single system-blue accent and a frosted glass header.',
  fontBody: '-apple-system',
  fontDisplay: '-apple-system',
  radiusUi: '18px',
  radiusInput: '18px',
  radiusThumb: '18px',
  borderWeight: '1px',
  navRadius: '18px',
  headerUpdateIndicatorMode: 'flat',
  light,
  dark,
  preview: {
    background: '#000000',
    border: '#2E2E2E',
    boxColor: '#FFFFFF',
    barColor: '#0A84FF',
  },
});

// "Liquid Glass" pass: the header, its dropdown menu, and the mobile nav bars
// become translucent frosted panels (backdrop-blur + saturation) so content
// scrolling underneath shows through, matching Apple's current design
// language. Content cards stay fully opaque - glass is for chrome, not for
// posters/thumbnails, where translucency would hurt legibility.
appleTvTheme.tokens.dark['glass-panel-background'] = 'rgba(255, 255, 255, 0.08)';
appleTvTheme.tokens.dark['glass-panel-border'] = '1px solid rgba(255, 255, 255, 0.16)';
appleTvTheme.tokens.dark['glass-menu-background'] = 'rgba(28, 28, 30, 0.6)';
appleTvTheme.tokens.dark['glass-menu-shadow'] = '0 24px 64px rgba(0, 0, 0, 0.55)';

appleTvTheme.tokens.light['glass-panel-background'] = 'rgba(255, 255, 255, 0.55)';
appleTvTheme.tokens.light['glass-panel-border'] = '1px solid rgba(0, 0, 0, 0.08)';
appleTvTheme.tokens.light['glass-menu-background'] = 'rgba(255, 255, 255, 0.75)';
appleTvTheme.tokens.light['glass-menu-shadow'] = '0 24px 48px rgba(0, 0, 0, 0.16)';

for (const mode of ['light', 'dark'] as const) {
  const tokens = appleTvTheme.tokens[mode];
  tokens['nav-item-border-selected'] =
    mode === 'dark' ? '1px solid rgba(255, 255, 255, 0.22)' : '1px solid rgba(0, 0, 0, 0.1)';
  tokens['mobile-subnav-surface-background'] = 'var(--glass-panel-background)';
  tokens['mobile-subnav-surface-border-top'] = 'var(--glass-panel-border)';
  tokens['mobile-subnav-surface-backdrop-filter'] = GLASS_BLUR;
  tokens['mobile-primary-nav-surface-background'] = 'var(--glass-panel-background)';
  tokens['mobile-primary-nav-surface-border-top'] = 'var(--glass-panel-border)';
  tokens['mobile-primary-nav-surface-backdrop-filter'] = GLASS_BLUR;
  tokens['video-modal-info-bubble-background'] = 'var(--glass-menu-background)';
  tokens['video-modal-info-bubble-border'] = 'var(--glass-panel-border)';
  // Switches use the system-blue accent for their "on" track, like real iOS/tvOS
  // toggles - primary is pure white/near-black here for monochrome buttons, which
  // would otherwise make a checked switch invisible against its own white thumb.
  tokens['switch-track-checked'] = tokens['accent'];
}

for (const breakpoint of ['desktop', 'mobile'] as const) {
  const layout = appleTvTheme.layout[breakpoint];
  layout.headerBackground = 'var(--glass-panel-background)';
  layout.headerBackdropFilter = GLASS_BLUR;
  layout.headerBorder = 'none';
  layout.headerBorderBottom = 'var(--glass-panel-border)';
  layout.headerMenuBackground = 'var(--glass-menu-background)';
  layout.headerMenuBorder = 'var(--glass-panel-border)';
  layout.headerMenuBackdropFilter = GLASS_MENU_BLUR;
  layout.headerMenuShadow = 'var(--glass-menu-shadow)';
}
