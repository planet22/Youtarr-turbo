import { createStreamingTheme, StreamingPalette } from './streamingThemeFactory';

const dark: StreamingPalette = {
  background: '0 0% 4%', // #0A0A0A
  foreground: '0 0% 100%',
  foregroundHex: '#FFFFFF',
  card: '0 0% 9%', // #171717
  cardForeground: '0 0% 100%',
  primary: '150 81% 51%', // #1CE783
  primaryForeground: '0 0% 6%',
  secondary: '0 0% 60%', // #999999
  secondaryForeground: '0 0% 6%',
  muted: '0 0% 14%', // #242424
  mutedForeground: '0 0% 65%',
  accent: '25 95% 53%', // #F9650A - Hulu Live TV orange
  accentForeground: '0 0% 100%',
  destructive: '0 72% 50%',
  destructiveForeground: '0 0% 100%',
  success: '150 65% 42%',
  successForeground: '0 0% 100%',
  warning: '38 92% 55%',
  warningForeground: '0 0% 10%',
  info: '199 89% 50%',
  infoForeground: '0 0% 100%',
  border: '0 0% 20%',
  borderStrong: '0 0% 40%',
  input: '0 0% 9%',
  navItemBgSelectedHex: '#1CE783',
  navItemTextSelectedHex: '#0A0A0A',
  navItemBgHoverRgba: 'rgba(255, 255, 255, 0.08)',
  authSplashBackground: 'linear-gradient(135deg, #050505 0%, #062018 100%)',
};

const light: StreamingPalette = {
  background: '0 0% 100%',
  foreground: '0 0% 6%',
  foregroundHex: '#0F0F0F',
  card: '0 0% 97%', // #F7F7F7
  cardForeground: '0 0% 6%',
  primary: '150 70% 38%', // darker green for contrast on white
  primaryForeground: '0 0% 100%',
  secondary: '0 0% 40%',
  secondaryForeground: '0 0% 100%',
  muted: '0 0% 94%',
  mutedForeground: '0 0% 35%',
  accent: '25 90% 45%',
  accentForeground: '0 0% 100%',
  destructive: '0 72% 45%',
  destructiveForeground: '0 0% 100%',
  success: '150 65% 32%',
  successForeground: '0 0% 100%',
  warning: '38 92% 45%',
  warningForeground: '0 0% 100%',
  info: '199 89% 40%',
  infoForeground: '0 0% 100%',
  border: '0 0% 88%',
  borderStrong: '0 0% 6%',
  input: '0 0% 97%',
  navItemBgSelectedHex: '#1CE783',
  navItemTextSelectedHex: '#0A0A0A',
  navItemBgHoverRgba: 'rgba(0, 0, 0, 0.05)',
  authSplashBackground: 'linear-gradient(135deg, #ffffff 0%, #e8fbf1 100%)',
};

export const huluTheme = createStreamingTheme({
  id: 'hulu',
  name: 'Hulu Style',
  description: 'Near-black stage with signature Hulu green and a touch of live-TV orange.',
  fontBody: "'Avenir Next'",
  fontDisplay: "'Avenir Next'",
  radiusUi: '6px',
  radiusInput: '6px',
  radiusThumb: '6px',
  borderWeight: '1px',
  navRadius: '6px',
  headerUpdateIndicatorMode: 'flat',
  light,
  dark,
  preview: {
    background: '#0A0A0A',
    border: '#333333',
    boxColor: '#1CE783',
    barColor: '#F9650A',
  },
});
