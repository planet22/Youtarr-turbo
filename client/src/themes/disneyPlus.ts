import { createStreamingTheme, StreamingPalette } from './streamingThemeFactory';

const dark: StreamingPalette = {
  background: '229 65% 5%', // #040714
  foreground: '0 0% 100%',
  foregroundHex: '#FFFFFF',
  card: '222 36% 9%', // #0F1420
  cardForeground: '0 0% 100%',
  primary: '212 87% 46%', // #0F6EDB
  primaryForeground: '0 0% 100%',
  secondary: '190 100% 50%', // #00D4FF
  secondaryForeground: '229 65% 5%',
  muted: '222 30% 14%', // #171E2E
  mutedForeground: '220 15% 65%',
  accent: '38 92% 55%',
  accentForeground: '0 0% 10%',
  destructive: '0 72% 51%',
  destructiveForeground: '0 0% 100%',
  success: '150 65% 42%',
  successForeground: '0 0% 100%',
  warning: '38 92% 55%',
  warningForeground: '0 0% 10%',
  info: '190 100% 50%',
  infoForeground: '229 65% 5%',
  border: '222 25% 20%',
  borderStrong: '222 20% 45%',
  input: '222 36% 9%',
  navItemBgSelectedHex: '#0F6EDB',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(255, 255, 255, 0.06)',
  authSplashBackground: 'linear-gradient(160deg, #040714 0%, #0F1E3D 60%, #0F6EDB 160%)',
};

const light: StreamingPalette = {
  background: '0 0% 100%',
  foreground: '229 65% 8%', // #060A14
  foregroundHex: '#060A14',
  card: '220 30% 97%', // #F5F7FA
  cardForeground: '229 65% 8%',
  primary: '212 87% 46%',
  primaryForeground: '0 0% 100%',
  secondary: '190 90% 38%',
  secondaryForeground: '0 0% 100%',
  muted: '220 25% 94%',
  mutedForeground: '220 15% 40%',
  accent: '38 87% 47%',
  accentForeground: '0 0% 100%',
  destructive: '0 72% 45%',
  destructiveForeground: '0 0% 100%',
  success: '150 65% 32%',
  successForeground: '0 0% 100%',
  warning: '38 92% 45%',
  warningForeground: '0 0% 100%',
  info: '190 90% 38%',
  infoForeground: '0 0% 100%',
  border: '220 20% 88%',
  borderStrong: '229 65% 8%',
  input: '220 30% 97%',
  navItemBgSelectedHex: '#0F6EDB',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(15, 110, 219, 0.08)',
  authSplashBackground: 'linear-gradient(135deg, #ffffff 0%, #e7f1fd 100%)',
};

export const disneyPlusTheme = createStreamingTheme({
  id: 'disneyPlus',
  name: 'Disney+ Style',
  description: 'Deep navy backdrop with Disney+ blue and a cyan gradient accent.',
  fontBody: "'Avenir'",
  fontDisplay: "'Avenir'",
  radiusUi: '10px',
  radiusInput: '10px',
  radiusThumb: '10px',
  borderWeight: '1px',
  navRadius: '10px',
  headerUpdateIndicatorMode: 'flat',
  light,
  dark,
  preview: {
    background: '#040714',
    border: '#262E3E',
    boxColor: '#0F6EDB',
    barColor: '#00D4FF',
  },
});
