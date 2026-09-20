import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { YtstreamDryRunSection } from '../YtstreamDryRunSection';
import { DEFAULT_CONFIG } from '../../../../config/configSchema';
import { ConfigState, YtstreamDryRunResult } from '../../types';

const mockRunDryRun = jest.fn();

jest.mock('../../hooks/useYtstreamDryRun', () => ({
  useYtstreamDryRun: () => ({ runDryRun: mockRunDryRun }),
}));
jest.mock('../components/YtstreamDryRunPreview', () => ({
  YtstreamDryRunPreview: (props: { result: { summary?: string } }) =>
    require('react').createElement('div', null, `preview:${props.result.summary}`),
}));

const RESULT = { summary: 'would serve hls' } as unknown as YtstreamDryRunResult;

const buildConfig = (ytstream: Partial<ConfigState['ytstream']> = {}, strmTarget: string = 'ytstream'): ConfigState => ({
  ...DEFAULT_CONFIG,
  strm: { ...DEFAULT_CONFIG.strm, target: strmTarget as ConfigState['strm']['target'] },
  ytstream: { ...DEFAULT_CONFIG.ytstream, ...ytstream },
});

function renderSection(config = buildConfig(), token: string | null = 'tok') {
  return render(<YtstreamDryRunSection config={config} token={token} />);
}

const input = () => screen.getByLabelText('YouTube video id or URL');
const runButton = () => screen.getByRole('button', { name: /Run Dry Run|Running/ });

describe('YtstreamDryRunSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunDryRun.mockResolvedValue(RESULT);
  });

  it('renders nothing unless STRM files point at ytstream', () => {
    renderSection(buildConfig({}, 'youtube'));

    expect(screen.queryByText('Streaming Dry Run')).not.toBeInTheDocument();
  });

  it('renders the card when STRM files point at ytstream', () => {
    renderSection();

    expect(screen.getByText('Streaming Dry Run')).toBeInTheDocument();
  });

  describe('run button', () => {
    it('is disabled with no video and no forced settings', () => {
      renderSection(buildConfig({ forceServerSettings: false }));

      expect(runButton()).toBeDisabled();
    });

    it('is enabled once a video is entered', async () => {
      renderSection(buildConfig({ forceServerSettings: false }));

      await userEvent.type(input(), 'dQw4w9WgXcQ');

      expect(runButton()).toBeEnabled();
    });

    it('is enabled with no video when settings are forced', () => {
      renderSection(buildConfig({ forceServerSettings: true }));

      expect(runButton()).toBeEnabled();
    });
  });

  describe('forced settings hint', () => {
    it('explains a blank preview when forced', () => {
      renderSection(buildConfig({ forceServerSettings: true }));

      expect(screen.getByText(/Leave blank to preview forced settings alone/)).toBeInTheDocument();
      expect(screen.getByText(/"Force these settings" is on/)).toBeInTheDocument();
    });

    it('asks for a video when not forced', () => {
      renderSection(buildConfig({ forceServerSettings: false }));

      expect(screen.getByText(/Enter a video id\/URL to preview it/)).toBeInTheDocument();
      expect(screen.queryByText(/"Force these settings" is on/)).not.toBeInTheDocument();
    });
  });

  describe('running', () => {
    it.each([
      ['a bare id', 'dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['a watch url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5', 'dQw4w9WgXcQ'],
      ['a short url', 'https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['a shorts url', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['an embed url', 'https://youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['an id with padding', '  dQw4w9WgXcQ  ', 'dQw4w9WgXcQ'],
    ])('accepts %s', async (_label, typed, expectedId) => {
      renderSection();

      await userEvent.type(input(), typed);
      await userEvent.click(runButton());

      await waitFor(() => expect(mockRunDryRun.mock.calls[0][0]).toBe(expectedId));
    });

    it('probes a real video', async () => {
      renderSection();

      await userEvent.type(input(), 'dQw4w9WgXcQ');
      await userEvent.click(runButton());

      await waitFor(() => expect(mockRunDryRun).toHaveBeenCalled());
      expect(mockRunDryRun.mock.calls[0][2]).toEqual({ probe: true });
    });

    it('rejects something that is not a video id or url', async () => {
      renderSection();

      await userEvent.type(input(), 'not a video!!');
      await userEvent.click(runButton());

      expect(await screen.findByText('Enter a valid YouTube video id or URL')).toBeInTheDocument();
      expect(mockRunDryRun).not.toHaveBeenCalled();
    });

    it('previews forced settings with a placeholder id and no probing', async () => {
      renderSection(buildConfig({ forceServerSettings: true }));

      await userEvent.click(runButton());

      await waitFor(() => expect(mockRunDryRun).toHaveBeenCalled());
      expect(mockRunDryRun.mock.calls[0][0]).toBe('no-video-dry-run');
      expect(mockRunDryRun.mock.calls[0][2]).toEqual({ probe: false });
    });

    it('passes the configured streaming settings', async () => {
      renderSection(buildConfig({
        defaultMode: 'hls',
        quality: '720',
        qualityStrictness: 'fixed',
        container: 'mkv',
        transcode: 'h264',
        hardwareMode: 'vaapi',
        tuning: 'fast',
        calculatedLength: true,
        audioLanguage: 'en',
        youtubeHlsProxy: 'proxy',
        byteRangeDeliverAsFile: true,
        byteRangeResumeCache: true,
      }));

      await userEvent.type(input(), 'dQw4w9WgXcQ');
      await userEvent.click(runButton());

      await waitFor(() => expect(mockRunDryRun).toHaveBeenCalled());
      expect(mockRunDryRun.mock.calls[0][1]).toEqual({
        mode: 'hls',
        quality: '720',
        qualityStrictness: 'fixed',
        container: 'mkv',
        transcode: 'h264',
        hardwareMode: 'vaapi',
        tuning: 'fast',
        calculatedLength: true,
        audioLanguage: 'en',
        hlsProxy: 'proxy',
        byteRangeDeliverAsFile: true,
        byteRangeResumeCache: true,
      });
    });

    it('turns empty settings into undefined so the server default applies', async () => {
      renderSection(buildConfig({ defaultMode: '' as never, quality: '' as never, audioLanguage: '' as never }));

      await userEvent.type(input(), 'dQw4w9WgXcQ');
      await userEvent.click(runButton());

      await waitFor(() => expect(mockRunDryRun).toHaveBeenCalled());
      expect(mockRunDryRun.mock.calls[0][1]).toMatchObject({ mode: undefined, quality: undefined, audioLanguage: undefined });
    });

    it('shows the preview when it succeeds', async () => {
      renderSection();

      await userEvent.type(input(), 'dQw4w9WgXcQ');
      await userEvent.click(runButton());

      expect(await screen.findByText('preview:would serve hls')).toBeInTheDocument();
    });

    it('shows a running label while waiting', async () => {
      mockRunDryRun.mockReturnValue(new Promise(() => {}));
      renderSection();
      await userEvent.type(input(), 'dQw4w9WgXcQ');

      await userEvent.click(runButton());

      expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled();
    });

    it('shows the failure message', async () => {
      mockRunDryRun.mockRejectedValue(new Error('yt-dlp not found'));
      renderSection();
      await userEvent.type(input(), 'dQw4w9WgXcQ');

      await userEvent.click(runButton());

      expect(await screen.findByText('yt-dlp not found')).toBeInTheDocument();
    });

    it('uses a generic message for a non-Error failure', async () => {
      mockRunDryRun.mockRejectedValue('nope');
      renderSection();
      await userEvent.type(input(), 'dQw4w9WgXcQ');

      await userEvent.click(runButton());

      expect(await screen.findByText('Failed to run playback simulation')).toBeInTheDocument();
    });

    it('clears an old error on the next run', async () => {
      mockRunDryRun.mockRejectedValueOnce(new Error('first failure'));
      renderSection();
      await userEvent.type(input(), 'dQw4w9WgXcQ');
      await userEvent.click(runButton());
      await screen.findByText('first failure');

      await userEvent.click(runButton());

      await waitFor(() => expect(screen.queryByText('first failure')).not.toBeInTheDocument());
    });
  });

  describe('when settings change', () => {
    it('drops a stale preview', async () => {
      const { rerender } = renderSection();
      await userEvent.type(input(), 'dQw4w9WgXcQ');
      await userEvent.click(runButton());
      await screen.findByText('preview:would serve hls');

      rerender(<YtstreamDryRunSection config={buildConfig({ quality: '480' })} token="tok" />);

      await waitFor(() => expect(screen.queryByText('preview:would serve hls')).not.toBeInTheDocument());
    });
  });
});
