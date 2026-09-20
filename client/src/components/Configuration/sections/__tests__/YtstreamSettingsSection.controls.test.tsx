import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import { YtstreamSettingsSection, DEFAULT_YTSTREAM } from '../YtstreamSettingsSection';
import { renderWithProviders } from '../../../../test-utils';
import { DEFAULT_CONFIG } from '../../../../config/configSchema';
import { ConfigState } from '../../types';

const mockRunHardwareTest = jest.fn();
const mockRunTuningBenchmark = jest.fn();
const mockRunNetworkBenchmark = jest.fn();
const mockRunSegmentTimingTest = jest.fn();
const mockClearUntracked = jest.fn();
const mockClearMetadata = jest.fn();
let mockCompat: Record<string, { status: string; reason?: string }> = {};
let mockUntracked: { fileCount: number | null; totalBytes: number | null; clearing: boolean; error: string | null } = {
  fileCount: null, totalBytes: null, clearing: false, error: null,
};
let mockMetadata: { count: number | null; clearing: boolean; error: string | null } = { count: null, clearing: false, error: null };
let mockTuning: Record<string, unknown> = {};

jest.mock('../../hooks/useHardwareCapabilities', () => ({
  useHardwareCapabilities: () => ({ testing: false, matrix: null, decodeMatrix: null, error: null, runTest: mockRunHardwareTest }),
}));
jest.mock('../../hooks/useTuningBenchmark', () => ({
  useTuningBenchmark: () => ({
    testing: false, progress: null, matrix: null, recommended: null, resultHardwareMode: null, resultDecodeMode: null,
    resultSourceCodec: null, resultVideoCodec: null, resultDecodeSourceHeight: null, history: [], error: null,
    runBenchmark: mockRunTuningBenchmark,
    ...mockTuning,
  }),
}));
jest.mock('../../hooks/useNetworkTuningBenchmark', () => ({
  useNetworkTuningBenchmark: () => ({
    testing: false, progress: null, results: null, recommended: null, presets: [], error: null, runBenchmark: mockRunNetworkBenchmark,
  }),
}));
jest.mock('../../hooks/useSegmentTimingTest', () => ({
  useSegmentTimingTest: () => ({ testing: false, result: null, error: null, runTest: mockRunSegmentTimingTest }),
}));
jest.mock('../../hooks/useUntrackedCache', () => ({
  useUntrackedCache: () => ({ ...mockUntracked, clear: mockClearUntracked }),
}));
jest.mock('../../hooks/useMetadataCache', () => ({
  useMetadataCache: () => ({ ...mockMetadata, clear: mockClearMetadata }),
}));
jest.mock('../../hooks/useYtstreamModeCompatibility', () => ({
  useYtstreamModeCompatibility: () => mockCompat,
}));

// The result tables are covered by their own tests; stub them so the section's
// own wiring (props and callbacks) is what these tests exercise.
jest.mock('../components/HardwareTestingAccordion', () => {
  const React = require('react');
  return { HardwareTestingAccordion: (props: { onRunTest: () => void }) => React.createElement('button', { onClick: props.onRunTest }, 'stub run hardware test') };
});
jest.mock('../components/TuningBenchmarkTable', () => {
  const React = require('react');
  return {
    TuningBenchmarkTable: (props: { onRunTest: (a: string, b: string, c: number) => void; disabledReason: string | null; hardwareMode: string; decodeMode: string }) =>
      React.createElement(
        'div',
        null,
        React.createElement('span', null, `tuning reason: ${props.disabledReason ?? 'none'}`),
        React.createElement('span', null, `tuning modes: ${props.hardwareMode}/${props.decodeMode}`),
        React.createElement('button', { onClick: () => props.onRunTest('h264', 'h264', 1080) }, 'stub run tuning')
      ),
  };
});
jest.mock('../components/NetworkTuningBenchmarkTable', () => {
  const React = require('react');
  return {
    NetworkTuningBenchmarkTable: (props: { applyDisabledReason: string | null; onApplyRecommended: (p: { httpChunkSizeMiB: number; concurrentFragments: number }) => void }) =>
      React.createElement(
        'div',
        null,
        React.createElement('span', null, `network reason: ${props.applyDisabledReason ?? 'none'}`),
        React.createElement('button', { onClick: () => props.onApplyRecommended({ httpChunkSizeMiB: 10, concurrentFragments: 4 }) }, 'stub apply recommended')
      ),
  };
});
jest.mock('../components/TuningHistoryTable', () => ({ TuningHistoryTable: () => null }));
jest.mock('../components/SegmentTimingTestButton', () => {
  const React = require('react');
  return {
    SegmentTimingTestButton: (props: { onRunTest: () => void; currentlyEnabled: boolean }) =>
      React.createElement('button', { onClick: props.onRunTest }, `stub run segment timing (${props.currentlyEnabled ? 'on' : 'off'})`),
  };
});

const ALL_OPTIONAL = Object.fromEntries(
  ['container', 'transcode', 'hardwareMode', 'tuning', 'cacheOnPlay', 'probeShortcut', 'hlsMasterPlaylist', 'backfillMissingSegments', 'finalizeToMp4', 'stealthCache', 'hotSwapToCache']
    .map((field) => [field, { status: 'optional' }])
);

type Ytstream = ConfigState['ytstream'];

const createConfig = (ytstream: Partial<Ytstream> = {}, strm: Partial<ConfigState['strm']> = {}): ConfigState => ({
  ...DEFAULT_CONFIG,
  strm: { ...DEFAULT_CONFIG.strm, ...strm },
  ytstream: { ...DEFAULT_YTSTREAM, ...ytstream },
});

const setup = (ytstream: Partial<Ytstream> = {}, options: { strm?: Partial<ConfigState['strm']>; disabled?: boolean } = {}) => {
  const onConfigChange = jest.fn();
  const user = userEvent.setup({ delay: null });
  renderWithProviders(
    <YtstreamSettingsSection config={createConfig(ytstream, options.strm)} onConfigChange={onConfigChange} token="token" disabled={options.disabled} />
  );
  return { onConfigChange, user };
};

const lastYtstream = (onConfigChange: jest.Mock): Partial<Ytstream> => onConfigChange.mock.calls[onConfigChange.mock.calls.length - 1][0].ytstream;

describe('YtstreamSettingsSection controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompat = { ...ALL_OPTIONAL };
    mockUntracked = { fileCount: null, totalBytes: null, clearing: false, error: null };
    mockMetadata = { count: null, clearing: false, error: null };
    mockTuning = {};
  });

  const choose = async (user: ReturnType<typeof userEvent.setup>, currentLabel: string, optionLabel: string) => {
    await user.click(screen.getByRole('button', { name: currentLabel }));
    await user.click(screen.getByRole('option', { name: optionLabel }));
  };

  describe('dropdowns', () => {
    it('changes the playback mode', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Direct', 'Enhanced HLS + Buffered');

      expect(lastYtstream(onConfigChange)).toMatchObject({ defaultMode: 'hls-buffer', byteRangeDeliverAsFile: false });
    });

    it('selects the byte-range manifest variant', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Direct', 'Byte-range HLS (experimental)');

      expect(lastYtstream(onConfigChange)).toMatchObject({ defaultMode: 'hls-byterange', byteRangeDeliverAsFile: false });
    });

    it('selects the byte-range plain file variant', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Direct', 'Byte-range Plain file');

      expect(lastYtstream(onConfigChange)).toMatchObject({ defaultMode: 'hls-byterange', byteRangeDeliverAsFile: true });
    });

    it('switches from plain file back to another mode and clears the plain file flag', async () => {
      const { user, onConfigChange } = setup({ defaultMode: 'hls-byterange', byteRangeDeliverAsFile: true, container: 'mkv' });

      await choose(user, 'Byte-range Plain file', 'Direct (redirect)');

      expect(lastYtstream(onConfigChange)).toMatchObject({ defaultMode: 'direct-redirect', byteRangeDeliverAsFile: false });
    });

    it('changes the container', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'MP4', 'MPEG-TS');

      expect(lastYtstream(onConfigChange)).toMatchObject({ container: 'ts' });
    });

    it('changes the stream quality', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Auto', '1080p');

      expect(lastYtstream(onConfigChange).quality).toBe('1080');
    });

    it('changes the transcode setting', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Auto (match download codec setting)', 'Force re-encode (H.264/AAC)');

      expect(lastYtstream(onConfigChange)).toMatchObject({ transcode: 'h264' });
    });

    it('changes the quality strictness', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Fall back to lower resolution', 'Fixed');

      expect(lastYtstream(onConfigChange)).toMatchObject({ qualityStrictness: 'fixed' });
    });

    it('changes the hardware encoder', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Software (libx264)', 'NVIDIA NVENC (h264_nvenc)');

      expect(lastYtstream(onConfigChange)).toMatchObject({ hardwareMode: 'nvenc' });
    });

    it('changes the hardware decoder', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Software', 'VAAPI');

      expect(lastYtstream(onConfigChange)).toMatchObject({ hardwareDecodeMode: 'vaapi' });
    });

    it('changes the encoding tuning', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'Fast (real-time safe)', 'Balanced');

      expect(lastYtstream(onConfigChange)).toMatchObject({ tuning: 'balanced' });
    });

    it('changes the HLS segment storage', async () => {
      const { user, onConfigChange } = setup();

      await choose(user, 'OS temp directory (default)', 'App persistent cache folder');

      expect(lastYtstream(onConfigChange)).toMatchObject({ hlsStorageLocation: 'cache' });
    });

    describe('VAAPI compression level', () => {
      it('is only offered when the hardware encoder is VAAPI', () => {
        setup({ hardwareMode: 'none' });

        expect(screen.queryByText('VAAPI compression level')).not.toBeInTheDocument();
      });

      it('sets a numeric level', async () => {
        const { user, onConfigChange } = setup({ hardwareMode: 'vaapi' });

        await choose(user, 'Auto (follows Encoding tuning: 7/4/1)', '4');

        expect(lastYtstream(onConfigChange)).toMatchObject({ vaapiQuality: 4 });
      });

      it('returns to automatic', async () => {
        const { user, onConfigChange } = setup({ hardwareMode: 'vaapi', vaapiQuality: 3 });

        await choose(user, '3', 'Auto (follows Encoding tuning: 7/4/1)');

        expect(lastYtstream(onConfigChange).vaapiQuality).toBeNull();
      });
    });

    describe('YouTube HLS passthrough options', () => {
      it('are hidden in other modes', () => {
        setup({ defaultMode: 'direct' });

        expect(screen.queryByLabelText('Audio language')).not.toBeInTheDocument();
      });

      it('offers routing through Youtarr', async () => {
        const { user, onConfigChange } = setup({ defaultMode: 'youtube-hls', youtubeHlsProxy: 'off' });

        await choose(user, 'Off (player goes straight to YouTube)', 'Proxy playlists');

        expect(lastYtstream(onConfigChange)).toMatchObject({ youtubeHlsProxy: 'proxy' });
      });

      it('defaults the routing to off', () => {
        setup({ defaultMode: 'youtube-hls', youtubeHlsProxy: undefined });

        expect(screen.getByRole('button', { name: 'Off (player goes straight to YouTube)' })).toBeInTheDocument();
      });

      it('sets the audio language', async () => {
        const { user, onConfigChange } = setup({ defaultMode: 'youtube-hls', audioLanguage: '' });

        await user.type(screen.getByLabelText('Audio language'), 'd');

        expect(lastYtstream(onConfigChange)).toMatchObject({ audioLanguage: 'd' });
      });
    });
  });

  describe('switches', () => {
    it.each([
      ['Force these settings (ignore URL / .strm overrides)', 'forceServerSettings', {}],
      ['Probe shortcut', 'probeShortcut', {}],
      ['Backfill missing segments', 'backfillMissingSegments', {}],
      ['Finalize .ts to .mp4', 'finalizeToMp4', {}],
      ['Stealth cache', 'stealthCache', {}],
    ])('turns %s on', async (label, field, ytstream) => {
      const { user, onConfigChange } = setup(ytstream);

      await user.click(screen.getByRole('checkbox', { name: label }));

      expect(lastYtstream(onConfigChange)).toMatchObject({ [field]: true });
    });

    it('turns the HLS master playlist off (it defaults to on)', async () => {
      const { user, onConfigChange } = setup();

      await user.click(screen.getByRole('checkbox', { name: 'HLS master playlist' }));

      expect(lastYtstream(onConfigChange)).toMatchObject({ hlsMasterPlaylist: false });
    });

    it('turns cache on play on through the STRM settings', async () => {
      const { user, onConfigChange } = setup();

      await user.click(screen.getByRole('checkbox', { name: 'Cache on play' }));

      expect(onConfigChange).toHaveBeenCalledWith({ strm: expect.objectContaining({ cacheOnPlay: true }) });
    });

    it('offers the resume partial cache switch only for byte-range plain file', async () => {
      const { user, onConfigChange } = setup({ defaultMode: 'hls-byterange', byteRangeDeliverAsFile: true, container: 'mkv' });

      await user.click(screen.getByRole('checkbox', { name: 'Resume partial cache' }));

      expect(lastYtstream(onConfigChange)).toMatchObject({ byteRangeResumeCache: true });
    });

    it('hides the resume partial cache switch in other modes', () => {
      setup();

      expect(screen.queryByRole('checkbox', { name: 'Resume partial cache' })).not.toBeInTheDocument();
    });

    it('disables a switch the current mode ignores', () => {
      mockCompat = { ...ALL_OPTIONAL, stealthCache: { status: 'ignored', reason: 'not applicable' } };
      setup();

      expect(screen.getByRole('checkbox', { name: 'Stealth cache' })).toBeDisabled();
    });

    it('disables everything when the whole section is disabled', () => {
      setup({}, { disabled: true });

      expect(screen.getByRole('checkbox', { name: 'Probe shortcut' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'MP4' })).toBeDisabled();
    });
  });

  describe('forced calculated length', () => {
    it('turns calculated length on when the mode forces it', () => {
      mockCompat = { ...ALL_OPTIONAL, calculatedLength: { status: 'forced' } };

      const { onConfigChange } = setup({ calculatedLength: false });

      expect(lastYtstream(onConfigChange)).toMatchObject({ calculatedLength: true });
    });

    it('does not rewrite it when it is already on', () => {
      mockCompat = { ...ALL_OPTIONAL, calculatedLength: { status: 'forced' } };

      const { onConfigChange } = setup({ calculatedLength: true });

      expect(onConfigChange).not.toHaveBeenCalled();
    });

    it('leaves it alone when the mode does not force it', () => {
      const { onConfigChange } = setup({ calculatedLength: false });

      expect(onConfigChange).not.toHaveBeenCalled();
    });
  });

  describe('text and number fields', () => {
    it('sets the player client override', async () => {
      const { user, onConfigChange } = setup();

      await user.type(screen.getByLabelText('yt-dlp player client override'), 'w');

      expect(lastYtstream(onConfigChange)).toMatchObject({ playerClient: 'w' });
    });

    it.each([
      ['HTTP chunk size (MiB)', 'httpChunkSizeMiB'],
      ['Concurrent fragments', 'concurrentFragments'],
    ])('sets %s for Enhanced HLS', async (label, field) => {
      const { user, onConfigChange } = setup({ defaultMode: 'hls-buffer' });

      await user.clear(screen.getByLabelText(label));
      await user.type(screen.getByLabelText(label), '8');

      expect(lastYtstream(onConfigChange)).toMatchObject({ [field]: 8 });
    });

    it.each(['HTTP chunk size (MiB)', 'Concurrent fragments'])('disables %s outside Enhanced HLS', (label) => {
      setup({ defaultMode: 'direct' });

      expect(screen.getByLabelText(label)).toBeDisabled();
    });

    it.each([
      ['Throttled rate (KB/s)', 'throttledRateKBps'],
      ['Socket timeout (seconds)', 'socketTimeoutSeconds'],
    ])('sets %s in any mode', async (label, field) => {
      const { user, onConfigChange } = setup({ defaultMode: 'direct' });

      await user.type(screen.getByLabelText(label), '5');

      expect(lastYtstream(onConfigChange)).toMatchObject({ [field]: 5 });
    });

    it('falls back to zero for a negative number', async () => {
      const { user, onConfigChange } = setup({ defaultMode: 'hls-buffer' });

      await user.type(screen.getByLabelText('HTTP chunk size (MiB)'), '-');

      expect(lastYtstream(onConfigChange)).toMatchObject({ httpChunkSizeMiB: 0 });
    });

    it('sets the history retention', async () => {
      const { user, onConfigChange } = setup({ historyRetentionDays: 90 });

      await user.type(screen.getByLabelText('History retention (days)'), '0');

      expect(lastYtstream(onConfigChange)).toMatchObject({ historyRetentionDays: 900 });
    });

    it('falls back to 90 days for a retention that is not a positive number', async () => {
      const { user, onConfigChange } = setup({ historyRetentionDays: 5 });

      await user.clear(screen.getByLabelText('History retention (days)'));

      expect(lastYtstream(onConfigChange)).toMatchObject({ historyRetentionDays: 90 });
    });

    describe('revert to STRM after (hours)', () => {
      const field = () => screen.getByLabelText('Revert to STRM after (hours)');

      it('is disabled when nothing would create an expiring file', () => {
        setup({ defaultMode: 'direct' });

        expect(field()).toBeDisabled();
      });

      it.each([
        ['cache on play is on', 'direct', { strm: { cacheOnPlay: true } }],
        ['the mode is Enhanced HLS + Buffered', 'hls-buffer', {}],
      ])('is enabled when %s', (_label, mode, options) => {
        setup({ defaultMode: mode as Ytstream['defaultMode'] }, options as { strm?: Partial<ConfigState['strm']> });

        expect(field()).toBeEnabled();
      });

      it('is enabled for byte-range plain file', () => {
        setup({ defaultMode: 'hls-byterange', byteRangeDeliverAsFile: true, container: 'mkv' });

        expect(field()).toBeEnabled();
      });

      it('stores a positive number of hours', async () => {
        const { user, onConfigChange } = setup({ defaultMode: 'hls-buffer' });

        await user.type(field(), '6');

        expect(onConfigChange).toHaveBeenCalledWith({ strm: expect.objectContaining({ cacheOnPlayExpiryHours: 6 }) });
      });

      it('stores null when cleared', async () => {
        const { user, onConfigChange } = setup({ defaultMode: 'hls-buffer' }, { strm: { cacheOnPlayExpiryHours: 12 } });

        await user.clear(field());

        expect(onConfigChange).toHaveBeenCalledWith({ strm: expect.objectContaining({ cacheOnPlayExpiryHours: null }) });
      });

      it('stores null for zero', async () => {
        const { user, onConfigChange } = setup({ defaultMode: 'hls-buffer' });

        await user.type(field(), '0');

        expect(onConfigChange).toHaveBeenCalledWith({ strm: expect.objectContaining({ cacheOnPlayExpiryHours: null }) });
      });
    });
  });

  describe('hints and warnings', () => {
    it('warns about hardware access when re-encoding with a hardware encoder in Enhanced HLS', () => {
      setup({ defaultMode: 'hls-buffer', transcode: 'h264', hardwareMode: 'nvenc' });

      expect(screen.getByText(/Hardware encoding requires a matching ffmpeg binary/)).toBeInTheDocument();
    });

    it.each([
      ['software encoding', { defaultMode: 'hls-buffer', transcode: 'h264', hardwareMode: 'none' }],
      ['stream copy', { defaultMode: 'hls-buffer', transcode: 'copy', hardwareMode: 'nvenc' }],
      ['a direct mode', { defaultMode: 'direct', transcode: 'h264', hardwareMode: 'nvenc' }],
    ])('does not show the hardware warning for %s', (_label, ytstream) => {
      setup(ytstream as Partial<Ytstream>);

      expect(screen.queryByText(/Hardware encoding requires a matching ffmpeg binary/)).not.toBeInTheDocument();
    });

    it.each([
      ['a direct mode', { defaultMode: 'direct' }, 'Set Playback mode to Enhanced HLS'],
      ['Enhanced HLS without re-encoding', { defaultMode: 'hls-buffer', transcode: 'copy' }, 'Set Transcode to "Force re-encode'],
    ])('explains why tuning cannot be tested for %s', (_label, ytstream, reason) => {
      setup(ytstream as Partial<Ytstream>);

      expect(screen.getByText(new RegExp(`tuning reason: ${reason}`))).toBeInTheDocument();
    });

    it('allows tuning tests for Enhanced HLS with re-encoding', () => {
      setup({ defaultMode: 'hls-buffer', transcode: 'h264' });

      expect(screen.getByText('tuning reason: none')).toBeInTheDocument();
    });

    it('explains that the network presets only apply to Enhanced HLS', () => {
      setup({ defaultMode: 'direct' });

      expect(screen.getByText(/network reason: Set Playback mode to Enhanced HLS/)).toBeInTheDocument();
    });

    it('does not restrict the network presets for Enhanced HLS', () => {
      setup({ defaultMode: 'hls' });

      expect(screen.getByText('network reason: none')).toBeInTheDocument();
    });
  });

  describe('running tests', () => {
    it('runs the hardware capability test', async () => {
      const { user } = setup();

      await user.click(screen.getByRole('button', { name: 'stub run hardware test' }));

      expect(mockRunHardwareTest).toHaveBeenCalled();
    });

    it('runs the tuning benchmark with the current encoder and decoder', async () => {
      const { user } = setup({ hardwareMode: 'vaapi', vaapiQuality: 3, hardwareDecodeMode: 'qsv' });

      await user.click(screen.getByRole('button', { name: 'stub run tuning' }));

      expect(mockRunTuningBenchmark).toHaveBeenCalledWith('vaapi', 3, 'qsv', 'h264', 'h264', 1080);
    });

    it('tells the tuning table which encoder and decoder are selected', () => {
      setup({ hardwareMode: 'nvenc', hardwareDecodeMode: 'none' });

      expect(screen.getByText('tuning modes: nvenc/none')).toBeInTheDocument();
    });

    it('runs the segment timing test for the current encoder', async () => {
      const { user } = setup({ hardwareMode: 'qsv', vaapiQuality: null });

      await user.click(screen.getByRole('button', { name: /stub run segment timing/ }));

      expect(mockRunSegmentTimingTest).toHaveBeenCalledWith('qsv', null);
    });

    it('tells the segment timing test whether forced keyframes are on for the encoder', () => {
      setup({ hardwareMode: 'qsv', forceKeyframesByHardwareMode: { qsv: true } });

      expect(screen.getByRole('button', { name: 'stub run segment timing (on)' })).toBeInTheDocument();
    });

    it('applies a recommended network preset', async () => {
      const { user, onConfigChange } = setup({ defaultMode: 'hls-buffer' });

      await user.click(screen.getByRole('button', { name: 'stub apply recommended' }));

      expect(lastYtstream(onConfigChange)).toMatchObject({ httpChunkSizeMiB: 10, concurrentFragments: 4 });
    });
  });

  describe('cache clearing', () => {
    it('shows placeholders while the cache sizes are unknown', () => {
      setup();

      expect(screen.getByText(/Untracked buffer cache: …/)).toBeInTheDocument();
      expect(screen.getByText(/Cached video metadata: …/)).toBeInTheDocument();
    });

    it('describes the caches with singular and plural wording', () => {
      mockUntracked = { fileCount: 1, totalBytes: 1048576, clearing: false, error: null };
      mockMetadata = { count: 3, clearing: false, error: null };

      setup();

      expect(screen.getByText(/Untracked buffer cache: 1 file,/)).toBeInTheDocument();
      expect(screen.getByText('Cached video metadata: 3 videos')).toBeInTheDocument();
    });

    it('uses the singular for one cached video', () => {
      mockMetadata = { count: 1, clearing: false, error: null };

      setup();

      expect(screen.getByText('Cached video metadata: 1 video')).toBeInTheDocument();
    });

    it('disables the delete buttons when there is nothing to delete', () => {
      mockUntracked = { fileCount: 0, totalBytes: 0, clearing: false, error: null };
      mockMetadata = { count: 0, clearing: false, error: null };

      setup();

      screen.getAllByRole('button', { name: 'Delete' }).forEach((button) => expect(button).toBeDisabled());
    });

    it('disables the delete buttons while clearing', () => {
      mockUntracked = { fileCount: 4, totalBytes: 10, clearing: true, error: null };
      mockMetadata = { count: 4, clearing: true, error: null };

      setup();

      screen.getAllByRole('button', { name: 'Delete' }).forEach((button) => expect(button).toBeDisabled());
    });

    it('shows cache errors', () => {
      mockUntracked = { fileCount: 1, totalBytes: 1, clearing: false, error: 'untracked failed' };
      mockMetadata = { count: 1, clearing: false, error: 'metadata failed' };

      setup();

      expect(screen.getByText('untracked failed')).toBeInTheDocument();
      expect(screen.getByText('metadata failed')).toBeInTheDocument();
    });

    describe.each([
      ['untracked buffer cache', 0, 'Delete Untracked Buffer Cache', () => mockClearUntracked],
      ['cached video metadata', 1, 'Delete Cached Video Metadata', () => mockClearMetadata],
    ])('deleting the %s', (_label, buttonIndex, dialogTitle, clearFn) => {
      beforeEach(() => {
        mockUntracked = { fileCount: 2, totalBytes: 2 * 1048576, clearing: false, error: null };
        mockMetadata = { count: 2, clearing: false, error: null };
      });

      const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getAllByRole('button', { name: 'Delete' })[buttonIndex]);
        return screen.getByRole('dialog');
      };

      it('asks for confirmation first', async () => {
        const { user } = setup();

        const dialog = await openDialog(user);

        expect(within(dialog).getByText(dialogTitle)).toBeInTheDocument();
        expect(clearFn()).not.toHaveBeenCalled();
      });

      it('does nothing when cancelled', async () => {
        const { user } = setup();
        const dialog = await openDialog(user);

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        expect(clearFn()).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      it('clears the cache when confirmed', async () => {
        const { user } = setup();
        const dialog = await openDialog(user);

        await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

        expect(clearFn()).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });
  });
});
