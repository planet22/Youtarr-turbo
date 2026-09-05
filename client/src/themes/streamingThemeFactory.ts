import React from 'react';
import { ThemeDefinition, ThemeTokens } from './types';
import { ThemeMode } from './types';

// Shared factory for "streaming service" branded themes (Netflix, YouTube, Hulu, Disney+,
// HBO Max, Apple TV+). Each brand only really differs in color, font, and corner radius -
// everything structural (paddings, shadow behavior, chip sizing, transitions) matches the
// existing "Bold Flat" top-nav theme contract, which is already validated by layoutPolicy tests.

export interface StreamingPalette {
  /** HSL triplet, e.g. "0 0% 100%" */
  background: string;
  foreground: string;
  foregroundHex: string;
  card: string;
  cardForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  info: string;
  infoForeground: string;
  border: string;
  borderStrong: string;
  input: string;
  /** Literal solid background used for the selected top-nav pill */
  navItemBgSelectedHex: string;
  /** Text color on top of navItemBgSelectedHex */
  navItemTextSelectedHex: string;
  /** Subtle hover wash for nav items, as an rgba string */
  navItemBgHoverRgba: string;
  /** Full CSS background (gradient or solid) for the auth splash screen */
  authSplashBackground: string;
}

export interface StreamingThemeConfig {
  id: ThemeMode;
  name: string;
  description: string;
  fontBody: string;
  fontDisplay: string;
  radiusUi: string;
  radiusInput: string;
  radiusThumb: string;
  borderWeight: string;
  navRadius: string;
  headerUpdateIndicatorMode: 'linear' | 'flat' | 'playful';
  light: StreamingPalette;
  dark: StreamingPalette;
  preview: {
    background: string;
    border: string;
    boxColor: string;
    barColor: string;
  };
}

function buildTokens(cfg: StreamingThemeConfig, palette: StreamingPalette): ThemeTokens {
  return {
    'font-body': cfg.fontBody,
    'font-display': cfg.fontDisplay,
    background: palette.background,
    foreground: palette.foreground,
    card: palette.background === palette.card ? palette.background : palette.card,
    'card-foreground': palette.cardForeground,
    popover: palette.card,
    'popover-foreground': palette.cardForeground,
    primary: palette.primary,
    'primary-foreground': palette.primaryForeground,
    secondary: palette.secondary,
    'secondary-foreground': palette.secondaryForeground,
    muted: palette.muted,
    'muted-foreground': palette.mutedForeground,
    accent: palette.accent,
    'accent-foreground': palette.accentForeground,
    destructive: palette.destructive,
    'destructive-foreground': palette.destructiveForeground,
    success: palette.success,
    'success-foreground': palette.successForeground,
    warning: palette.warning,
    'warning-foreground': palette.warningForeground,
    info: palette.info,
    'info-foreground': palette.infoForeground,
    border: palette.border,
    'border-strong': palette.borderStrong,
    input: palette.card,
    'input-border': palette.border,
    'input-border-hover': palette.primary,
    ring: palette.primary,
    radius: '0.5rem',
    'radius-ui': cfg.radiusUi,
    'radius-input': cfg.radiusInput,
    'radius-thumb': cfg.radiusThumb,
    'border-weight': cfg.borderWeight,
    'nav-radius': cfg.navRadius,
    'action-bar-gap': '6px',
    'action-bar-gap-compact': '6px',
    'action-bar-padding-y': '8px',
    'action-bar-padding-x': '0px',
    'chip-shadow': 'none',
    'chip-shadow-hover': 'none',
    'rating-chip-shadow': 'none',
    'rating-chip-shadow-hover': 'none',
    'status-chip-max-width': '140px',
    'rating-chip-max-width': '120px',
    'action-bar-foreground': palette.foreground,
    'action-bar-border': palette.border,
    'action-bar-hover-border': palette.primary,
    'action-bar-disabled-foreground': palette.mutedForeground,
    'snackbar-surface-background': `hsl(${palette.card} / 0.97)`,
    'snackbar-surface-border': `hsl(${palette.borderStrong} / 0.16)`,
    'snackbar-surface-foreground': palette.foregroundHex,
    'overlay-backdrop-background': 'rgba(0, 0, 0, 0.55)',
    'overlay-backdrop-background-strong': 'rgba(0, 0, 0, 0.68)',
    'overlay-backdrop-filter': 'blur(4px)',
    'media-placeholder-background': '#111827',
    'media-placeholder-border': '1px solid rgba(107, 114, 128, 0.4)',
    'media-overlay-foreground': '#ffffff',
    'media-overlay-background': 'rgba(0, 0, 0, 0.66)',
    'media-overlay-background-strong': 'rgba(0, 0, 0, 0.82)',
    'media-overlay-danger-background': 'rgba(211, 47, 47, 0.95)',
    'media-overlay-selection-background': `hsl(${palette.primary} / 0.24)`,
    'media-overlay-delete-selection-background': 'rgba(220, 38, 38, 0.2)',
    'media-overlay-delete-indicator-background': 'rgba(220, 38, 38, 0.82)',
    'media-overlay-ignore-button-background': 'rgba(0, 0, 0, 0.7)',
    'media-overlay-text-shadow': 'drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.55))',
    'video-modal-media-background': 'var(--card)',
    'video-modal-media-border': `${cfg.borderWeight} solid var(--border-strong)`,
    'video-modal-media-radius': 'var(--radius-ui)',
    'video-modal-media-max-height-mobile': '44vh',
    'video-modal-media-max-height-desktop': '58vh',
    'video-modal-media-overlay-gradient':
      'linear-gradient(to bottom, rgba(0, 0, 0, 0.1) 0%, rgba(0, 0, 0, 0.48) 100%)',
    'video-modal-overlay-action-background': 'rgba(0, 0, 0, 0.78)',
    'video-modal-overlay-action-foreground': '#ffffff',
    'video-modal-overlay-action-size': '72px',
    'video-modal-overlay-action-icon-size': '48px',
    'video-modal-overlay-download-size': '90px',
    'video-modal-overlay-download-icon-size': '50px',
    'video-modal-overlay-corner-background': 'rgba(0, 0, 0, 0.64)',
    'video-modal-overlay-corner-foreground': '#ffffff',
    'video-modal-action-row-gap': '8px',
    'video-modal-action-row-padding-y': '2px',
    'video-modal-action-control-height': '28px',
    'video-modal-action-control-min-width': '28px',
    'video-modal-action-control-padding-x': '8px',
    'video-modal-content-gap': '10px',
    'video-modal-content-padding-mobile': '8px',
    'video-modal-content-padding-desktop': '12px',
    'video-modal-action-divider': 'var(--border-strong)',
    'video-modal-section-gap': '12px',
    'video-modal-delete-outline': 'var(--destructive)',
    'video-modal-delete-foreground': 'var(--destructive)',
    'video-modal-link-color': 'hsl(var(--primary))',
    'video-modal-info-bubble-background': 'var(--card)',
    'video-modal-info-bubble-foreground': 'var(--foreground)',
    'video-modal-info-bubble-border': `${cfg.borderWeight} solid var(--border-strong)`,
    'video-modal-info-bubble-shadow': 'none',
    'auth-splash-background': palette.authSplashBackground,
    'auth-surface-background': 'var(--card)',
    'auth-surface-border': `${cfg.borderWeight} solid var(--border-strong)`,
    'auth-surface-shadow': '0 16px 40px rgba(0, 0, 0, 0.35)',
    'auth-surface-backdrop-filter': 'none',
    'auth-surface-transform': 'none',
    'auth-surface-padding': '32px',
    'auth-title-font-weight': '800',
    'auth-title-font-size': '2.5rem',
    'auth-title-letter-spacing': 'normal',
    'auth-title-text-shadow': 'none',
    'auth-subtitle-font-size': '1rem',
    'auth-button-text-transform': 'none',
    'auth-button-letter-spacing': 'normal',
    'linear-decor-blob-primary': `radial-gradient(circle, hsl(${palette.primary} / 0.3) 0%, transparent 70%)`,
    'linear-decor-blob-secondary': `radial-gradient(circle, hsl(${palette.secondary} / 0.22) 0%, transparent 70%)`,
    'linear-decor-top-rail': `linear-gradient(90deg, transparent, hsl(${palette.primary} / 0.45), transparent)`,
    'audio-chip-radius': 'var(--radius-ui)',
    'audio-chip-bg': 'transparent',
    'audio-chip-border': 'var(--border)',
    'audio-chip-foreground': 'var(--foreground)',
    'audio-chip-icon': 'var(--foreground)',
    'audio-chip-shadow': 'none',
    'audio-chip-shadow-hover': 'none',
    'video-chip-radius': 'var(--radius-ui)',
    'video-chip-bg': 'transparent',
    'video-chip-border': 'var(--border)',
    'video-chip-foreground': 'var(--foreground)',
    'video-chip-icon': 'var(--foreground)',
    'video-chip-shadow': 'none',
    'video-chip-shadow-hover': 'none',
    'audio-control-radius': 'var(--radius-ui)',
    'audio-control-border': 'var(--border)',
    'audio-control-bg': 'var(--input)',
    'audio-control-foreground': 'var(--foreground)',
    'audio-control-shadow': 'none',
    'audio-control-shadow-focus': `0 0 0 2px hsl(${palette.primary} / 0.5)`,
    'fab-primary-bg': 'var(--primary)',
    'fab-primary-fg': 'var(--primary-foreground)',
    'fab-primary-hover-bg': 'var(--primary)',
    'fab-primary-hover-fg': 'var(--primary-foreground)',
    'fab-secondary-bg': 'var(--secondary)',
    'fab-secondary-fg': 'var(--secondary-foreground)',
    'fab-secondary-hover-bg': 'var(--secondary)',
    'fab-secondary-hover-fg': 'var(--secondary-foreground)',
    'fab-error-bg': 'var(--destructive)',
    'fab-error-fg': 'var(--destructive-foreground)',
    'fab-error-hover-bg': 'var(--destructive)',
    'fab-error-hover-fg': 'var(--destructive-foreground)',
    'selection-fab-size': '56px',
    'selection-fab-radius': cfg.radiusUi,
    'selection-fab-border': `${cfg.borderWeight} solid var(--border-strong)`,
    'selection-fab-shadow': '0 12px 30px rgba(0, 0, 0, 0.35)',
    'selection-fab-shadow-hover': '0 16px 38px rgba(0, 0, 0, 0.45)',
    'selection-fab-shadow-active': '0 8px 20px rgba(0, 0, 0, 0.3)',
    'selection-fab-icon-size': '22px',
    'selection-fab-badge-background': 'var(--card)',
    'selection-fab-badge-foreground': 'var(--foreground)',
    'selection-fab-badge-border': `${cfg.borderWeight} solid var(--border-strong)`,
    'selection-fab-badge-shadow': 'none',
    'selection-fab-badge-radius': '999px',
    'nav-hover-style': 'flat-solid',
    'shadow-soft': 'none',
    'shadow-hard': 'none',
    'shadow-hard-hover': 'none',
    'shadow-input-rest': 'none',
    'shadow-input-focus': `0 0 0 2px hsl(${palette.primary} / 0.5)`,
    'transition-smooth': 'all 0.2s ease',
    'transition-bouncy': 'ease',
    'card-hover-transform': 'none',
    'nav-border': `${cfg.borderWeight} solid var(--border)`,
    'nav-shadow': 'none',
    'nav-item-border': `${cfg.borderWeight} solid transparent`,
    'nav-item-border-selected': `${cfg.borderWeight} solid transparent`,
    'nav-item-border-hover': `${cfg.borderWeight} solid transparent`,
    'nav-item-bg': 'transparent',
    'nav-item-bg-selected': palette.navItemBgSelectedHex,
    'nav-item-bg-hover': palette.navItemBgHoverRgba,
    'nav-item-shadow': 'none',
    'nav-item-shadow-selected': 'none',
    'nav-item-shadow-hover': 'none',
    'nav-item-transform': 'translate(0, 0)',
    'nav-item-transform-hover': 'translate(0, 0)',
    'nav-item-text-selected': palette.navItemTextSelectedHex,
    'header-nav-active-color': 'hsl(var(--primary))',
    'header-nav-default-color': 'var(--muted-foreground)',
    'header-subnav-active-color': 'hsl(var(--primary))',
    'header-update-indicator-width': '34px',
    'header-update-indicator-height': '34px',
    'header-update-indicator-radius': 'var(--radius-ui)',
    'header-update-indicator-foreground': 'var(--warning-foreground)',
    'header-update-indicator-background': 'var(--warning)',
    'header-update-indicator-border': `${cfg.borderWeight} solid var(--border)`,
    'header-update-indicator-shadow': 'none',
    'mobile-subnav-surface-background': 'var(--card)',
    'mobile-subnav-surface-border-top': `${cfg.borderWeight} solid var(--border)`,
    'mobile-subnav-surface-radius': '0',
    'mobile-subnav-surface-margin-bottom': '0',
    'mobile-subnav-surface-padding-bottom': '8px',
    'mobile-subnav-item-border': 'var(--nav-item-border)',
    'mobile-subnav-item-border-selected': 'var(--nav-item-border-selected)',
    'mobile-subnav-item-radius': 'var(--radius-ui)',
    'mobile-subnav-item-text-transform': 'none',
    'mobile-subnav-item-letter-spacing': 'normal',
    'mobile-primary-nav-surface-background': 'var(--card)',
    'mobile-primary-nav-surface-border-top': `${cfg.borderWeight} solid var(--border)`,
    'mobile-primary-nav-surface-radius': '0',
    'mobile-primary-nav-surface-shadow': 'none',
    'mobile-primary-nav-active-color': 'var(--primary)',
    'mobile-primary-nav-active-background': 'var(--muted)',
    'mobile-primary-nav-label-font-size': '0.65rem',
    'mobile-primary-nav-label-text-transform': 'none',
    'mobile-primary-nav-label-letter-spacing': 'normal',
    'channel-meta-chip-background': 'var(--card)',
    'channel-meta-chip-foreground': palette.foregroundHex,
    'channel-meta-chip-border': `${cfg.borderWeight} solid var(--border-strong)`,
    'channel-meta-chip-shadow': 'none',
    'channel-meta-chip-icon': 'var(--foreground)',
    'rating-chip-border': `${cfg.borderWeight} solid var(--border-strong)`,
  };
}

export function createStreamingTheme(cfg: StreamingThemeConfig): ThemeDefinition {
  return {
    id: cfg.id,
    name: cfg.name,
    description: cfg.description,
    layoutMode: 'top-nav',
    headerPreferences: {
      showLogoDefault: true,
      showWordmarkDefault: true,
    },
    headerBehavior: {
      mobileHorizontalPadding: '4px',
      mobileInsetOffset: 'var(--shell-gap)',
    },
    sidebarBehavior: {
      compactHeightScrollFooter: false,
      zeroDesktopPanelPadding: false,
      navButtonGap: '2px',
      scrollerPaddingBottom: '0px',
      listPaddingBottom: '0px',
      itemPaddingBottom: '0px',
      hideStorageFooterOnMobile: false,
      mobileDrawerDocked: true,
      mobileDrawerBorderRadius: 'var(--radius-ui) var(--radius-ui) 0 0',
      mobileDrawerMarginTop: 'auto',
      mobileDrawerMarginBottom: '0px',
      mobileDrawerMaxHeight: '65vh',
      mobileDrawerWidth: '100%',
      mobileDrawerTop: 'auto',
      mobileDrawerLeft: '0',
      mobileDrawerRight: '0',
      mobileDrawerBottom: '0',
    },
    backgroundDecorations: { elements: [] },
    layout: {
      desktop: {
        navPlacement: 'top',
        headerFrameMode: 'flush',
        mobileHeaderInset: false,
        showHeaderToggleOnMobile: false,
        showDesktopNavItems: true,
        showStorageHeaderWidget: true,
        headerVersionPlacement: 'desktop',
        headerTitleInset: '12px',
        headerToggleMode: 'menu',
        headerToggleWidth: '44px',
        headerToggleHeight: '44px',
        headerToggleRadius: 'var(--radius-ui)',
        headerToggleColor: 'var(--foreground)',
        headerUpdateIndicatorMode: cfg.headerUpdateIndicatorMode,
        headerBackground: 'var(--card)',
        headerBorder: `${cfg.borderWeight} solid var(--border)`,
        headerBorderBottom: `${cfg.borderWeight} solid var(--border)`,
        headerPattern: 'none',
        headerBackdropFilter: 'none',
        headerBorderRadius: '0px',
        headerMenuRadius: cfg.radiusUi,
        headerMenuBorder: `${cfg.borderWeight} solid var(--border)`,
        headerMenuBackground: 'var(--card)',
        headerMenuShadow: '0 12px 32px rgba(0, 0, 0, 0.3)',
        shellBackground: 'linear-gradient(180deg, var(--card) 0%, var(--background) 55%, var(--background) 100%)',
        mainPadding: '16px 16px 24px',
        mainMarginTop: '64px',
        contentPadding: '12px 16px',
        contentMaxWidth: '1400px',
        contentMarginInline: 'auto',
        contentFrameBackground: 'transparent',
        contentFrameBorder: 'none',
        contentFrameRadius: '0px',
        contentFrameShadow: 'none',
      },
      mobile: {
        navPlacement: 'top',
        headerFrameMode: 'flush',
        mobileHeaderInset: false,
        showHeaderToggleOnMobile: false,
        showDesktopNavItems: false,
        showStorageHeaderWidget: true,
        headerVersionPlacement: 'mobile',
        headerTitleInset: '0px',
        headerToggleMode: 'menu',
        headerToggleWidth: '44px',
        headerToggleHeight: '44px',
        headerToggleRadius: 'var(--radius-ui)',
        headerToggleColor: 'var(--foreground)',
        headerUpdateIndicatorMode: cfg.headerUpdateIndicatorMode,
        headerBackground: 'var(--card)',
        headerBorder: `${cfg.borderWeight} solid var(--border)`,
        headerBorderBottom: `${cfg.borderWeight} solid var(--border)`,
        headerPattern: 'none',
        headerBackdropFilter: 'none',
        headerBorderRadius: '0px',
        headerMenuRadius: cfg.radiusUi,
        headerMenuBorder: `${cfg.borderWeight} solid var(--border)`,
        headerMenuBackground: 'var(--card)',
        headerMenuShadow: '0 12px 32px rgba(0, 0, 0, 0.3)',
        shellBackground: 'linear-gradient(180deg, var(--card) 0%, var(--background) 55%, var(--background) 100%)',
        mainPadding: '8px 4px calc(20px + env(safe-area-inset-bottom))',
        mainMarginTop: '64px',
        contentPadding: '8px 4px',
        contentMaxWidth: '1400px',
        contentMarginInline: 'auto',
        contentFrameBackground: 'transparent',
        contentFrameBorder: 'none',
        contentFrameRadius: '0px',
        contentFrameShadow: 'none',
      },
    },
    preview: React.createElement(
      'div',
      {
        key: 'preview-root',
        style: {
          padding: '20px',
          borderRadius: cfg.radiusUi,
          backgroundColor: cfg.preview.background,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          overflow: 'hidden',
          position: 'relative',
          border: `2px solid ${cfg.preview.border}`,
          width: '100%',
          minHeight: 80,
        },
      },
      [
        React.createElement('div', {
          key: 'b1',
          style: {
            width: 44,
            height: 44,
            borderRadius: cfg.radiusUi,
            backgroundColor: cfg.preview.boxColor,
          },
        }),
        React.createElement('div', {
          key: 'b2',
          style: {
            width: 90,
            height: 16,
            borderRadius: '4px',
            backgroundColor: cfg.preview.barColor,
          },
        }),
      ]
    ),
    tokens: {
      light: buildTokens(cfg, cfg.light),
      dark: buildTokens(cfg, cfg.dark),
    },
  };
}
