import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Settings from '../Settings';
import { DEFAULT_CONFIG } from '../../../config/configSchema';
import { ConfigState } from '../../Configuration/types';

// ---- Lightweight stand-ins for every section/dialog. Each renders a marker
// and, where the page wiring matters, a button that calls one of the props.
function mockMarker(name: string, children?: React.ReactNode) {
  const react = require('react');
  const kids = Array.isArray(children) ? children : [children];
  return react.createElement('div', { 'data-testid': `${name}-section` }, ...kids);
}
function mockText(text: string) {
  return require('react').createElement('span', null, text);
}
function mockButton(label: string, onClick: () => void) {
  return require('react').createElement('button', { type: 'button', onClick }, label);
}

jest.mock('../../PlexLibrarySelector', () => ({
  __esModule: true,
  default: (props: { open: boolean }) => (props.open ? mockMarker('plex-library-selector') : null),
}));
jest.mock('../../PlexAuthDialog', () => ({
  __esModule: true,
  default: (props: { open: boolean; onClose: () => void; onSuccess: () => void }) =>
    (props.open ? mockMarker('plex-auth', [mockButton('close-plex-auth', props.onClose), mockButton('plex-auth-success', props.onSuccess)]) : null),
}));
jest.mock('../../Configuration/common/ConfigurationSkeleton', () => ({ __esModule: true, default: () => mockMarker('skeleton') }));
jest.mock('../SettingsIndex', () => ({
  SETTINGS_PAGES: [{ key: 'core', title: 'Core' }, { key: 'plex', title: 'Plex' }],
  SettingsIndex: () => mockMarker('index'),
}));
jest.mock('../../Configuration/sections/CoreSettingsSection', () => ({
  CoreSettingsSection: (props: {
    onConfigChange: (u: Partial<ConfigState>) => void;
    onMobileTooltipClick: (t: string) => void;
    onFilenameTemplatePreviewSuccess: (p: string) => void;
    filenameTemplateSaveRequirement: string | null;
  }) => mockMarker('core', [
    mockButton('change-resolution', () => props.onConfigChange({ preferredResolution: '720' })),
    mockButton('use-custom-prefix', () => props.onConfigChange({ videoFilenamePrefix: 'custom-prefix  ' })),
    mockButton('use-preset-prefix', () => props.onConfigChange({ videoFilenamePrefix: 'preset-prefix' })),
    mockButton('use-invalid-prefix', () => props.onConfigChange({ videoFilenamePrefix: 'invalid' })),
    mockButton('preview-success', () => props.onFilenameTemplatePreviewSuccess('custom-prefix')),
    mockButton('show-tooltip', () => props.onMobileTooltipClick('Helpful hint')),
    mockButton('switch-to-nightly', () => props.onConfigChange({ ytdlpUpdateChannel: 'nightly' })),
    props.filenameTemplateSaveRequirement,
  ]),
}));
jest.mock('../../Configuration/sections/PlexIntegrationSection', () => ({
  PlexIntegrationSection: (props: { onConfigChange: (u: Partial<ConfigState>) => void; onOpenPlexAuthDialog: () => void }) =>
    mockMarker('plex', [
      mockButton('change-plex-ip', () => props.onConfigChange({ plexIP: '10.0.0.5' })),
      mockButton('change-resolution', () => props.onConfigChange({ preferredResolution: '480' })),
      mockButton('open-plex-auth', props.onOpenPlexAuthDialog),
    ]),
}));
jest.mock('../../Configuration/sections/YouTubeApiSection', () => ({
  YouTubeApiSection: (props: { onConfigChange: (u: Partial<ConfigState>) => void }) =>
    mockMarker('youtube-api', mockButton('change-api-key', () => props.onConfigChange({ youtubeApiKey: 'new-key' }))),
}));
jest.mock('../../Configuration/sections/SaveBar', () => ({
  SaveBar: (props: { hasUnsavedChanges: boolean; isLoading: boolean; validationError: string | null; onSave: () => void }) =>
    mockMarker('save-bar', [
      mockText(`unsaved:${props.hasUnsavedChanges}`),
      mockText(`loading:${props.isLoading}`),
      mockText(`error:${props.validationError ?? 'none'}`),
      mockButton('save', props.onSave),
    ]),
}));
jest.mock('../../Configuration/sections/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: (props: { open: boolean; validationError: string | null; onDiscard: () => void; onCancel: () => void; onSave: () => void }) =>
    (props.open ? mockMarker('unsaved-dialog', [
      mockButton('discard', props.onDiscard),
      mockButton('cancel-nav', props.onCancel),
      mockButton('save-and-continue', props.onSave),
    ]) : null),
}));
jest.mock('../../Configuration/sections/components/YtdlpChannelApplyDialog', () => ({
  YtdlpChannelApplyDialog: (props: { targetChannel: string | null; onApply: () => void; onClose: () => void }) =>
    (props.targetChannel ? mockMarker('channel-apply', [
      `target:${props.targetChannel}`,
      mockButton('apply-channel', props.onApply),
      mockButton('close-channel-apply', props.onClose),
    ]) : null),
}));
jest.mock('../../Configuration/sections/AccountSecuritySection', () => ({ AccountSecuritySection: () => mockMarker('security') }));
jest.mock('../../Configuration/sections/AppearanceSettingsSection', () => ({ __esModule: true, default: () => mockMarker('appearance') }));
jest.mock('../../Configuration/sections/JellyfinSection', () => ({ __esModule: true, default: () => mockMarker('jellyfin') }));
jest.mock('../../Configuration/sections/EmbySection', () => ({ __esModule: true, default: () => mockMarker('emby') }));
jest.mock('../../Configuration/sections/WatchStatusSection', () => ({ __esModule: true, default: () => mockMarker('watch-status') }));
jest.mock('../../Configuration/sections/SponsorBlockSection', () => ({ SponsorBlockSection: () => mockMarker('sponsorblock') }));
jest.mock('../../Configuration/sections/CookieConfigSection', () => ({ CookieConfigSection: () => mockMarker('cookies') }));
jest.mock('../../Configuration/sections/NotificationsSection', () => ({ NotificationsSection: () => mockMarker('notifications') }));
jest.mock('../../Configuration/sections/DownloadPerformanceSection', () => ({ DownloadPerformanceSection: () => mockMarker('download-performance') }));
jest.mock('../../Configuration/sections/YtdlpOptionsSection', () => ({ YtdlpOptionsSection: () => mockMarker('ytdlp-options') }));
jest.mock('../../Configuration/sections/YtdlpUpdateSection', () => ({ YtdlpUpdateSection: () => mockMarker('ytdlp-update') }));
jest.mock('../../Configuration/sections/AutoRemovalSection', () => ({ AutoRemovalSection: () => mockMarker('autoremove') }));
jest.mock('../../Configuration/sections/ApiKeysSection', () => ({ __esModule: true, default: () => mockMarker('api-keys') }));
jest.mock('../../Configuration/sections/StrmSettingsSection', () => ({ StrmSettingsSection: () => mockMarker('strm') }));
jest.mock('../../Configuration/sections/YtstreamDryRunSection', () => ({ YtstreamDryRunSection: () => mockMarker('ytstream-dry-run') }));
jest.mock('../../Configuration/sections/NzbSettingsSection', () => ({ NzbSettingsSection: () => mockMarker('nzb') }));
jest.mock('../MaintenanceSection', () => ({ MaintenanceSection: () => mockMarker('maintenance') }));
jest.mock('../ScheduledTasksSection', () => ({ ScheduledTasksSection: () => mockMarker('scheduled-tasks') }));
jest.mock('../ResolutionTagBackfillSection', () => ({ ResolutionTagBackfillSection: () => mockMarker('resolution-backfill') }));
jest.mock('../ChannelImageRegenSection', () => ({ ChannelImageRegenSection: () => mockMarker('channel-image-regen') }));
jest.mock('../MetadataRegenSection', () => ({ MetadataRegenSection: () => mockMarker('metadata-regen') }));
jest.mock('../CompactHistorySection', () => ({ CompactHistorySection: () => mockMarker('compact-history') }));

jest.mock('../../Configuration/hooks', () => ({
  usePlexConnection: jest.fn(),
  useConfigSave: jest.fn(),
  useYtDlpUpdate: jest.fn(),
  useUnsavedChangesGuard: jest.fn(),
}));
jest.mock('../../Configuration/hooks/useYouTubeApiKey', () => ({ useYouTubeApiKey: jest.fn() }));
jest.mock('../../../hooks/useStorageStatus', () => ({ useStorageStatus: jest.fn() }));
jest.mock('../../../hooks/useConfig', () => ({ useConfig: jest.fn() }));
jest.mock('../../Configuration/utils/configValidation', () => ({ validateConfig: jest.fn() }));
jest.mock('../../../utils/filenameTemplate/presets', () => ({ FILENAME_PRESETS: [{ prefix: 'preset-prefix' }] }));
jest.mock('../../../utils/filenameTemplate/validate', () => ({ validatePrefix: jest.fn() }));

const hooks = require('../../Configuration/hooks');
const { useYouTubeApiKey } = require('../../Configuration/hooks/useYouTubeApiKey');
const { useStorageStatus } = require('../../../hooks/useStorageStatus');
const { useConfig } = require('../../../hooks/useConfig');
const { validateConfig } = require('../../Configuration/utils/configValidation');
const { validatePrefix } = require('../../../utils/filenameTemplate/validate');

const PREVIEW_MESSAGE = 'Preview this custom filename template before saving.';

interface HookSpies {
  setPlexConnectionStatus: jest.Mock;
  setOpenPlexAuthDialog: jest.Mock;
  handlePlexAuthSuccess: jest.Mock;
  saveConfig: jest.Mock;
  clearYoutubeApiStatus: jest.Mock;
  performYtDlpUpdate: jest.Mock;
  clearYtDlpMessages: jest.Mock;
  checkYtDlpLatestVersion: jest.Mock;
  confirmNav: jest.Mock;
  cancelNav: jest.Mock;
}

interface Options {
  initial?: Partial<ConfigState>;
  loading?: boolean;
  platformManaged?: Record<string, boolean>;
  pendingNav?: string | null;
  ytdlp?: { errorMessage?: string | null; successMessage?: string | null };
  saveResult?: boolean;
  openPlexAuthDialog?: boolean;
}

function setup(path: string, options: Options = {}) {
  const spies: HookSpies = {
    setPlexConnectionStatus: jest.fn(),
    setOpenPlexAuthDialog: jest.fn(),
    handlePlexAuthSuccess: jest.fn(),
    saveConfig: jest.fn().mockResolvedValue(options.saveResult ?? true),
    clearYoutubeApiStatus: jest.fn(),
    performYtDlpUpdate: jest.fn(),
    clearYtDlpMessages: jest.fn(),
    checkYtDlpLatestVersion: jest.fn(),
    confirmNav: jest.fn(),
    cancelNav: jest.fn(),
  };
  const savedConfig: ConfigState = { ...DEFAULT_CONFIG, ...options.initial };

  function useFakeConfig() {
    const [config, setConfig] = React.useState<ConfigState>(savedConfig);
    const [initialConfig, setInitialConfig] = React.useState<ConfigState | null>(savedConfig);
    return {
      config,
      initialConfig,
      isPlatformManaged: { plexUrl: false, authEnabled: true, useTmpForDownloads: false, ytdlpUpdates: false, ...options.platformManaged },
      deploymentEnvironment: { platform: null, isWsl: false },
      loading: options.loading ?? false,
      setConfig,
      setInitialConfig,
    };
  }
  useConfig.mockImplementation(useFakeConfig);
  hooks.usePlexConnection.mockReturnValue({
    plexConnectionStatus: 'not_tested',
    setPlexConnectionStatus: spies.setPlexConnectionStatus,
    plexServerClaimed: false,
    plexLibraries: [],
    openPlexLibrarySelector: false,
    openPlexAuthDialog: options.openPlexAuthDialog ?? false,
    setOpenPlexAuthDialog: spies.setOpenPlexAuthDialog,
    checkPlexConnection: jest.fn(),
    testPlexConnection: jest.fn(),
    openLibrarySelector: jest.fn(),
    closeLibrarySelector: jest.fn(),
    setLibraryId: jest.fn(),
    handlePlexAuthSuccess: spies.handlePlexAuthSuccess,
  });
  hooks.useConfigSave.mockReturnValue({ saveConfig: spies.saveConfig, isSaving: false });
  hooks.useYtDlpUpdate.mockReturnValue({
    versionInfo: null,
    updateStatus: 'idle',
    errorMessage: options.ytdlp?.errorMessage ?? null,
    successMessage: options.ytdlp?.successMessage ?? null,
    performUpdate: spies.performYtDlpUpdate,
    clearMessages: spies.clearYtDlpMessages,
    checkLatestVersion: spies.checkYtDlpLatestVersion,
  });
  hooks.useUnsavedChangesGuard.mockReturnValue({ pendingNav: options.pendingNav ?? null, confirmNav: spies.confirmNav, cancelNav: spies.cancelNav });
  useYouTubeApiKey.mockReturnValue({ status: 'idle', lastValidatedAt: null, lastReason: null, testKey: jest.fn(), clear: spies.clearYoutubeApiStatus });
  useStorageStatus.mockReturnValue({ available: true });

  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/*" element={<Settings token="tok" />} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>
  );
  return spies;
}

describe('Settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateConfig.mockReturnValue(null);
    validatePrefix.mockImplementation((prefix: string) => ({ ok: prefix !== 'invalid' }));
  });

  describe('routing', () => {
    it('shows the settings index at /settings', () => {
      setup('/settings');

      expect(screen.getByTestId('index-section')).toBeInTheDocument();
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it.each([
      ['/settings/core', 'core'],
      ['/settings/appearance', 'appearance'],
      ['/settings/plex', 'plex'],
      ['/settings/jellyfin', 'jellyfin'],
      ['/settings/emby', 'emby'],
      ['/settings/watch-status', 'watch-status'],
      ['/settings/sponsorblock', 'sponsorblock'],
      ['/settings/cookies', 'cookies'],
      ['/settings/notifications', 'notifications'],
      ['/settings/nzb', 'nzb'],
      ['/settings/autoremove', 'autoremove'],
      ['/settings/security', 'security'],
      ['/settings/api-keys', 'api-keys'],
      ['/settings/youtube-api', 'youtube-api'],
    ])('renders %s', (path, section) => {
      setup(path);

      expect(screen.getByTestId(`${section}-section`)).toBeInTheDocument();
    });

    it('groups the yt-dlp sections under downloading', () => {
      setup('/settings/downloading');

      expect(screen.getByTestId('ytdlp-update-section')).toBeInTheDocument();
      expect(screen.getByTestId('download-performance-section')).toBeInTheDocument();
      expect(screen.getByTestId('ytdlp-options-section')).toBeInTheDocument();
    });

    it('groups STRM and the dry run under streaming', () => {
      setup('/settings/streaming');

      expect(screen.getByTestId('strm-section')).toBeInTheDocument();
      expect(screen.getByTestId('ytstream-dry-run-section')).toBeInTheDocument();
    });

    it('groups the maintenance tools under maintenance', () => {
      setup('/settings/maintenance');

      for (const name of ['maintenance', 'scheduled-tasks', 'resolution-backfill', 'channel-image-regen', 'metadata-regen', 'compact-history']) {
        expect(screen.getByTestId(`${name}-section`)).toBeInTheDocument();
      }
    });

    it.each(['/settings/performance', '/settings/advanced'])('redirects the legacy %s page to downloading', (path) => {
      setup(path);

      expect(screen.getByTestId('ytdlp-options-section')).toBeInTheDocument();
    });

    it('sends an unknown page back to the index', () => {
      setup('/settings/nonsense');

      expect(screen.getByTestId('index-section')).toBeInTheDocument();
    });

    it('titles a section page with its name', () => {
      setup('/settings/plex');

      expect(screen.getByText('Settings / Plex')).toBeInTheDocument();
    });

    it('titles a page without an index entry with its path', () => {
      setup('/settings/youtube-api');

      expect(screen.getByText('Settings / youtube-api')).toBeInTheDocument();
    });
  });

  describe('loading', () => {
    it('shows a skeleton and no section while the config loads', () => {
      setup('/settings/core', { loading: true });

      expect(screen.getByTestId('skeleton-section')).toBeInTheDocument();
      expect(screen.queryByTestId('core-section')).not.toBeInTheDocument();
    });

    it('marks the save bar as busy while loading', () => {
      setup('/settings/core', { loading: true });

      expect(screen.getByText('loading:true')).toBeInTheDocument();
    });
  });

  describe('unsaved changes', () => {
    it('starts clean', () => {
      setup('/settings/core');

      expect(screen.getByText('unsaved:false')).toBeInTheDocument();
    });

    it('flags a tracked change', async () => {
      setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'change-resolution' }));

      expect(screen.getByText('unsaved:true')).toBeInTheDocument();
    });

    it('guards navigation out of settings only', () => {
      setup('/settings/core');

      const { shouldBlock } = hooks.useUnsavedChangesGuard.mock.calls[0][0];
      expect(shouldBlock('/settings/plex')).toBe(false);
      expect(shouldBlock('/videos')).toBe(true);
    });

    it('enables the guard once something changed', async () => {
      setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'change-resolution' }));

      const lastCall = hooks.useUnsavedChangesGuard.mock.calls[hooks.useUnsavedChangesGuard.mock.calls.length - 1][0];
      expect(lastCall.enabled).toBe(true);
    });
  });

  describe('saving', () => {
    it('saves through the save bar', async () => {
      const spies = setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'save' }));

      expect(spies.saveConfig).toHaveBeenCalledTimes(1);
    });

    it('shows a validation error instead of saving', async () => {
      validateConfig.mockReturnValue('Proxy URL is invalid');
      const spies = setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'save' }));

      expect(spies.saveConfig).not.toHaveBeenCalled();
      expect((await screen.findAllByText('Proxy URL is invalid')).length).toBeGreaterThan(0);
    });

    it('passes the validation error to the save bar', () => {
      validateConfig.mockReturnValue('Proxy URL is invalid');
      setup('/settings/core');

      expect(screen.getByText('error:Proxy URL is invalid')).toBeInTheDocument();
    });

    describe('yt-dlp channel switch', () => {
      const switchChannel = async () => {
        await userEvent.click(screen.getByRole('button', { name: 'switch-to-nightly' }));
        await userEvent.click(screen.getByRole('button', { name: 'save' }));
      };

      it('offers to apply the new channel after saving a change', async () => {
        const spies = setup('/settings/core', { initial: { ytdlpUpdateChannel: 'stable' } });

        await switchChannel();

        expect(await screen.findByText('target:nightly')).toBeInTheDocument();
        expect(spies.checkYtDlpLatestVersion).toHaveBeenCalled();
      });

      it('applies the channel when confirmed', async () => {
        const spies = setup('/settings/core', { initial: { ytdlpUpdateChannel: 'stable' } });
        await switchChannel();

        await userEvent.click(await screen.findByRole('button', { name: 'apply-channel' }));

        expect(spies.performYtDlpUpdate).toHaveBeenCalled();
      });

      it('closes the dialog', async () => {
        setup('/settings/core', { initial: { ytdlpUpdateChannel: 'stable' } });
        await switchChannel();

        await userEvent.click(await screen.findByRole('button', { name: 'close-channel-apply' }));

        expect(screen.queryByTestId('channel-apply-section')).not.toBeInTheDocument();
      });

      it('does not offer it when the save failed', async () => {
        const spies = setup('/settings/core', { initial: { ytdlpUpdateChannel: 'stable' }, saveResult: false });

        await switchChannel();

        expect(spies.checkYtDlpLatestVersion).not.toHaveBeenCalled();
        expect(screen.queryByTestId('channel-apply-section')).not.toBeInTheDocument();
      });

      it('does not offer it when yt-dlp updates are managed by the platform', async () => {
        const spies = setup('/settings/core', { initial: { ytdlpUpdateChannel: 'stable' }, platformManaged: { ytdlpUpdates: true } });

        await switchChannel();

        expect(spies.checkYtDlpLatestVersion).not.toHaveBeenCalled();
      });

      it('does not offer it when the channel did not change', async () => {
        const spies = setup('/settings/core', { initial: { ytdlpUpdateChannel: 'nightly' } });

        await switchChannel();

        expect(spies.checkYtDlpLatestVersion).not.toHaveBeenCalled();
      });
    });
  });

  describe('filename template preview requirement', () => {
    it('does not require a preview for an unchanged prefix', () => {
      setup('/settings/core');

      expect(screen.getByText('error:none')).toBeInTheDocument();
    });

    it('requires a preview for a new custom prefix', async () => {
      setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'use-custom-prefix' }));

      expect(screen.getByText(`error:${PREVIEW_MESSAGE}`)).toBeInTheDocument();
      expect(screen.getByText(PREVIEW_MESSAGE)).toBeInTheDocument();
    });

    it('clears once the template has been previewed', async () => {
      setup('/settings/core');
      await userEvent.click(screen.getByRole('button', { name: 'use-custom-prefix' }));

      await userEvent.click(screen.getByRole('button', { name: 'preview-success' }));

      expect(screen.getByText('error:none')).toBeInTheDocument();
    });

    it('does not require a preview for a built-in preset', async () => {
      setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'use-preset-prefix' }));

      expect(screen.getByText('error:none')).toBeInTheDocument();
    });

    it('leaves an invalid prefix to the validator rather than asking for a preview', async () => {
      setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'use-invalid-prefix' }));

      expect(screen.getByText('error:none')).toBeInTheDocument();
    });

    it('blocks saving until previewed', async () => {
      const spies = setup('/settings/core');
      await userEvent.click(screen.getByRole('button', { name: 'use-custom-prefix' }));

      await userEvent.click(screen.getByRole('button', { name: 'save' }));

      expect(spies.saveConfig).not.toHaveBeenCalled();
    });

    it('prefers a general validation error over the preview requirement', async () => {
      validateConfig.mockReturnValue('Proxy URL is invalid');
      setup('/settings/core');
      await userEvent.click(screen.getByRole('button', { name: 'use-custom-prefix' }));

      expect(screen.getByText('error:Proxy URL is invalid')).toBeInTheDocument();
    });
  });

  describe('config change side effects', () => {
    it('resets the Plex connection test when a connection setting changes', async () => {
      const spies = setup('/settings/plex');

      await userEvent.click(screen.getByRole('button', { name: 'change-plex-ip' }));

      expect(spies.setPlexConnectionStatus).toHaveBeenCalledWith('not_tested');
    });

    it('leaves the Plex connection test alone for other settings', async () => {
      const spies = setup('/settings/plex');

      await userEvent.click(screen.getByRole('button', { name: 'change-resolution' }));

      expect(spies.setPlexConnectionStatus).not.toHaveBeenCalled();
    });

    it('clears the YouTube API key status when the key changes', async () => {
      const spies = setup('/settings/youtube-api');

      await userEvent.click(screen.getByRole('button', { name: 'change-api-key' }));

      expect(spies.clearYoutubeApiStatus).toHaveBeenCalled();
    });

    it('does not clear it for other settings', async () => {
      const spies = setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'change-resolution' }));

      expect(spies.clearYoutubeApiStatus).not.toHaveBeenCalled();
    });
  });

  describe('leaving with unsaved changes', () => {
    it('shows no prompt while not navigating away', () => {
      setup('/settings/core');

      expect(screen.queryByTestId('unsaved-dialog-section')).not.toBeInTheDocument();
    });

    it('prompts when a navigation is pending', () => {
      setup('/settings/core', { pendingNav: '/videos' });

      expect(screen.getByTestId('unsaved-dialog-section')).toBeInTheDocument();
    });

    it('discards and continues', async () => {
      const spies = setup('/settings/core', { pendingNav: '/videos' });

      await userEvent.click(screen.getByRole('button', { name: 'discard' }));

      expect(spies.confirmNav).toHaveBeenCalled();
    });

    it('stays put on cancel', async () => {
      const spies = setup('/settings/core', { pendingNav: '/videos' });

      await userEvent.click(screen.getByRole('button', { name: 'cancel-nav' }));

      expect(spies.cancelNav).toHaveBeenCalled();
    });

    it('saves then continues', async () => {
      const spies = setup('/settings/core', { pendingNav: '/videos' });

      await userEvent.click(screen.getByRole('button', { name: 'save-and-continue' }));

      expect(spies.saveConfig).toHaveBeenCalled();
      await waitFor(() => expect(spies.confirmNav).toHaveBeenCalled());
    });

    it('stays put when the save fails', async () => {
      const spies = setup('/settings/core', { pendingNav: '/videos', saveResult: false });

      await userEvent.click(screen.getByRole('button', { name: 'save-and-continue' }));

      await waitFor(() => expect(spies.saveConfig).toHaveBeenCalled());
      expect(spies.confirmNav).not.toHaveBeenCalled();
    });

    it('shows the validation error instead of saving', async () => {
      validateConfig.mockReturnValue('Proxy URL is invalid');
      const spies = setup('/settings/core', { pendingNav: '/videos' });

      await userEvent.click(screen.getByRole('button', { name: 'save-and-continue' }));

      expect(spies.saveConfig).not.toHaveBeenCalled();
      expect(spies.confirmNav).not.toHaveBeenCalled();
      expect((await screen.findAllByText('Proxy URL is invalid')).length).toBeGreaterThan(0);
    });
  });

  describe('yt-dlp update messages', () => {
    it('shows an error and clears it', async () => {
      const spies = setup('/settings/core', { ytdlp: { errorMessage: 'Update failed' } });

      expect(await screen.findByText('Update failed')).toBeInTheDocument();
      expect(spies.clearYtDlpMessages).toHaveBeenCalled();
    });

    it('shows a success message and clears it', async () => {
      const spies = setup('/settings/core', { ytdlp: { successMessage: 'Updated to 2026.1.1' } });

      expect(await screen.findByText('Updated to 2026.1.1')).toBeInTheDocument();
      expect(spies.clearYtDlpMessages).toHaveBeenCalled();
    });

    it('prefers the error when both are set', async () => {
      setup('/settings/core', { ytdlp: { errorMessage: 'Update failed', successMessage: 'Updated' } });

      expect(await screen.findByText('Update failed')).toBeInTheDocument();
      expect(screen.queryByText('Updated')).not.toBeInTheDocument();
    });
  });

  describe('mobile tooltip', () => {
    it('shows a section hint in a snackbar', async () => {
      setup('/settings/core');

      await userEvent.click(screen.getByRole('button', { name: 'show-tooltip' }));

      expect(await screen.findByText('Helpful hint')).toBeInTheDocument();
    });

    it('dismisses the hint', async () => {
      setup('/settings/core');
      await userEvent.click(screen.getByRole('button', { name: 'show-tooltip' }));
      await screen.findByText('Helpful hint');

      await userEvent.click(screen.getByRole('button', { name: /close/i }));

      await waitFor(() => expect(screen.queryByText('Helpful hint')).not.toBeInTheDocument());
    });
  });

  describe('Plex dialogs', () => {
    it('opens the Plex sign in from the Plex section', async () => {
      const spies = setup('/settings/plex');

      await userEvent.click(screen.getByRole('button', { name: 'open-plex-auth' }));

      expect(spies.setOpenPlexAuthDialog).toHaveBeenCalledWith(true);
    });

    it('closes the Plex sign in', async () => {
      const spies = setup('/settings/plex', { openPlexAuthDialog: true });

      await userEvent.click(screen.getByRole('button', { name: 'close-plex-auth' }));

      expect(spies.setOpenPlexAuthDialog).toHaveBeenCalledWith(false);
    });

    it('reports a successful Plex sign in', async () => {
      const spies = setup('/settings/plex', { openPlexAuthDialog: true });

      await userEvent.click(screen.getByRole('button', { name: 'plex-auth-success' }));

      expect(spies.handlePlexAuthSuccess).toHaveBeenCalled();
    });
  });
});
