import { createStreamingTheme, StreamingPalette } from './streamingThemeFactory';

const dark: StreamingPalette = {
  background: '273 100% 4%', // #0B0014
  foreground: '0 0% 100%',
  foregroundHex: '#FFFFFF',
  card: '267 55% 10%', // #170B26
  cardForeground: '0 0% 100%',
  primary: '271 70% 60%', // #9B51E0
  primaryForeground: '0 0% 100%',
  secondary: '211 90% 65%', // #4DABF7
  secondaryForeground: '273 100% 4%',
  muted: '267 40% 14%', // #251733
  mutedForeground: '270 15% 65%',
  accent: '38 92% 55%',
  accentForeground: '0 0% 10%',
  destructive: '0 72% 51%',
  destructiveForeground: '0 0% 100%',
  success: '150 65% 42%',
  successForeground: '0 0% 100%',
  warning: '38 92% 55%',
  warningForeground: '0 0% 10%',
  info: '211 90% 65%',
  infoForeground: '273 100% 4%',
  border: '270 30% 22%',
  borderStrong: '270 25% 45%',
  input: '267 55% 10%',
  navItemBgSelectedHex: '#9B51E0',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(255, 255, 255, 0.06)',
  authSplashBackground: 'linear-gradient(160deg, #0B0014 0%, #170B26 55%, #4B1F73 140%)',
};

const light: StreamingPalette = {
  background: '0 0% 100%',
  foreground: '273 100% 4%', // #0B0014
  foregroundHex: '#0B0014',
  card: '270 30% 97%', // #F6F3FA
  cardForeground: '273 100% 4%',
  primary: '271 70% 55%',
  primaryForeground: '0 0% 100%',
  secondary: '211 90% 50%',
  secondaryForeground: '0 0% 100%',
  muted: '270 25% 94%',
  mutedForeground: '270 12% 40%',
  accent: '38 87% 47%',
  accentForeground: '0 0% 100%',
  destructive: '0 72% 45%',
  destructiveForeground: '0 0% 100%',
  success: '150 65% 32%',
  successForeground: '0 0% 100%',
  warning: '38 92% 45%',
  warningForeground: '0 0% 100%',
  info: '211 90% 50%',
  infoForeground: '0 0% 100%',
  border: '270 20% 88%',
  borderStrong: '273 100% 4%',
  input: '270 30% 97%',
  navItemBgSelectedHex: '#9B51E0',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(155, 81, 224, 0.1)',
  authSplashBackground: 'linear-gradient(135deg, #ffffff 0%, #f1e7fb 100%)',
};

export const hboMaxTheme = createStreamingTheme({
  id: 'hboMax',
  name: 'HBO Max Style',
  description: 'Cinematic purple-black stage with a bold violet accent.',
  fontBody: "'Inter'",
  fontDisplay: "'Inter'",
  radiusUi: '14px',
  radiusInput: '14px',
  radiusThumb: '14px',
  borderWeight: '1px',
  navRadius: '14px',
  headerUpdateIndicatorMode: 'flat',
  light,
  dark,
  preview: {
    background: '#170B26',
    border: '#362A45',
    boxColor: '#9B51E0',
    barColor: '#4DABF7',
  },
});
