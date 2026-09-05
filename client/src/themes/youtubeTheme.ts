import { createStreamingTheme, StreamingPalette } from './streamingThemeFactory';

const dark: StreamingPalette = {
  background: '0 0% 6%', // #0F0F0F
  foreground: '0 0% 100%',
  foregroundHex: '#FFFFFF',
  card: '0 0% 13%', // #212121
  cardForeground: '0 0% 100%',
  primary: '0 100% 50%', // #FF0000
  primaryForeground: '0 0% 100%',
  secondary: '213 94% 65%', // #3EA6FF - YouTube's dark-mode link blue
  secondaryForeground: '0 0% 6%',
  muted: '0 0% 15%', // #272727
  mutedForeground: '0 0% 65%',
  accent: '213 94% 65%',
  accentForeground: '0 0% 6%',
  destructive: '0 84% 60%',
  destructiveForeground: '0 0% 100%',
  success: '142 71% 45%',
  successForeground: '0 0% 100%',
  warning: '38 92% 55%',
  warningForeground: '0 0% 10%',
  info: '213 94% 65%',
  infoForeground: '0 0% 6%',
  border: '0 0% 25%',
  borderStrong: '0 0% 45%',
  input: '0 0% 13%',
  navItemBgSelectedHex: '#272727',
  navItemTextSelectedHex: '#FFFFFF',
  navItemBgHoverRgba: 'rgba(255, 255, 255, 0.08)',
  authSplashBackground: 'linear-gradient(135deg, #0f0f0f 0%, #1a0000 100%)',
};

const light: StreamingPalette = {
  background: '0 0% 100%',
  foreground: '0 0% 6%', // #0F0F0F
  foregroundHex: '#0F0F0F',
  card: '0 0% 98%', // #F9F9F9
  cardForeground: '0 0% 6%',
  primary: '0 100% 50%',
  primaryForeground: '0 0% 100%',
  secondary: '211 100% 43%', // #065FD4 - YouTube's light-mode action blue
  secondaryForeground: '0 0% 100%',
  muted: '0 0% 95%', // #F2F2F2
  mutedForeground: '0 0% 33%',
  accent: '211 100% 43%',
  accentForeground: '0 0% 100%',
  destructive: '0 84% 55%',
  destructiveForeground: '0 0% 100%',
  success: '142 71% 35%',
  successForeground: '0 0% 100%',
  warning: '38 92% 45%',
  warningForeground: '0 0% 100%',
  info: '211 100% 43%',
  infoForeground: '0 0% 100%',
  border: '0 0% 90%',
  borderStrong: '0 0% 6%',
  input: '0 0% 98%',
  navItemBgSelectedHex: '#F2F2F2',
  navItemTextSelectedHex: '#0F0F0F',
  navItemBgHoverRgba: 'rgba(0, 0, 0, 0.05)',
  authSplashBackground: 'linear-gradient(135deg, #ffffff 0%, #ffecec 100%)',
};

export const youtubeTheme = createStreamingTheme({
  id: 'youtube',
  name: 'YouTube Style',
  description: 'Clean white or near-black canvas with YouTube red and rounded thumbnails.',
  fontBody: "'Roboto'",
  fontDisplay: "'Roboto'",
  radiusUi: '12px',
  radiusInput: '18px',
  radiusThumb: '12px',
  borderWeight: '1px',
  navRadius: '18px',
  headerUpdateIndicatorMode: 'flat',
  light,
  dark,
  preview: {
    background: '#0F0F0F',
    border: '#3F3F3F',
    boxColor: '#FF0000',
    barColor: '#3EA6FF',
  },
});
