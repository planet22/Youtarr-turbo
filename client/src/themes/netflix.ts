import { createStreamingTheme, StreamingPalette } from './streamingThemeFactory';

const dark: StreamingPalette = {
  background: '0 0% 8%', // #141414
  foreground: '0 0% 100%',
  foregroundHex: '#FFFFFF',
  card: '0 0% 10%', // #1A1A1A
  cardForeground: '0 0% 100%',
  primary: '357 92% 47%', // #E50914
  primaryForeground: '0 0% 100%',
  secondary: '0 0% 70%', // #B3B3B3
  secondaryForeground: '0 0% 8%',
  muted: '0 0% 16%', // #2A2A2A
  mutedForeground: '0 0% 65%',
  accent: '43 96% 56%', // #F5C518 rating gold
  accentForeground: '0 0% 8%',
  destructive: '0 72% 51%',
  destructiveForeground: '0 0% 100%',
  success: '142 71% 45%',
  successForeground: '0 0% 100%',
  warning: '38 92% 55%',
  warningForeground: '0 0% 10%',
  info: '199 89% 48%',
  infoForeground: '0 0% 100%',
  border: '0 0% 20%',
  borderStrong: '0 0% 40%',
  input: '0 0% 10%',
  navItemBgSelectedHex: '#E50914',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(255, 255, 255, 0.08)',
  authSplashBackground: 'linear-gradient(135deg, #050505 0%, #1a0a0a 100%)',
};

const light: StreamingPalette = {
  background: '0 0% 100%',
  foreground: '0 0% 8%', // #141414
  foregroundHex: '#141414',
  card: '0 0% 96%', // #F5F5F5
  cardForeground: '0 0% 8%',
  primary: '357 92% 47%',
  primaryForeground: '0 0% 100%',
  secondary: '0 0% 45%', // #737373 - readable gray on white
  secondaryForeground: '0 0% 100%',
  muted: '0 0% 93%',
  mutedForeground: '0 0% 40%',
  accent: '38 87% 47%', // darker gold for light-mode contrast
  accentForeground: '0 0% 100%',
  destructive: '0 72% 45%',
  destructiveForeground: '0 0% 100%',
  success: '142 71% 35%',
  successForeground: '0 0% 100%',
  warning: '38 92% 45%',
  warningForeground: '0 0% 100%',
  info: '199 89% 40%',
  infoForeground: '0 0% 100%',
  border: '0 0% 88%',
  borderStrong: '0 0% 8%',
  input: '0 0% 96%',
  navItemBgSelectedHex: '#E50914',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(0, 0, 0, 0.06)',
  authSplashBackground: 'linear-gradient(135deg, #ffffff 0%, #fceceb 100%)',
};

export const netflixTheme = createStreamingTheme({
  id: 'netflix',
  name: 'Netflix Style',
  description: 'Deep black canvas, bold red accent, and edge-to-edge poster cards.',
  fontBody: "'Helvetica Neue'",
  fontDisplay: "'Helvetica Neue'",
  radiusUi: '4px',
  radiusInput: '4px',
  radiusThumb: '4px',
  borderWeight: '1px',
  navRadius: '4px',
  headerUpdateIndicatorMode: 'flat',
  light,
  dark,
  preview: {
    background: '#141414',
    border: '#333333',
    boxColor: '#E50914',
    barColor: '#B3B3B3',
  },
});
