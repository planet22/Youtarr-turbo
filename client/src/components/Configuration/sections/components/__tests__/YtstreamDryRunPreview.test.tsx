import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { YtstreamDryRunPreview } from '../YtstreamDryRunPreview';
import type { YtstreamDryRunExperimentalResult, YtstreamDryRunStandardResult } from '../../../types';

const standard = (): YtstreamDryRunStandardResult => ({
  youtubeId: 'vid00000001',
  probed: false,
  plan: {
    mode: 'hls',
    requestedMode: 'hls',
    ffmpegAvailable: true,
    container: 'mp4',
    transcode: 'copy',
    hardwareMode: 'none',
    tuning: 'fast',
    requestedQuality: '1080',
    quality: '1080',
    qualityStrictness: 'fallback',
    qualityCapped: false,
    seekSeconds: null,
    calculatedLength: true,
    hotSwapToCache: false,
    backfillMissingSegments: false,
    finalizeToMp4: false,
    stealthCache: false,
    forceServerSettings: false,
    ignoredQueryParams: [],
    probeShortcut: { wouldFire: false, reason: '', isMetadataProbe: false, transcode: 'copy' },
    steps: [{ step: 'mode', detail: 'hls - from settings', probed: false }],
  },
  formatSelectors: { video: 'bv*[height<=1080]' },
  hls: null,
  wouldCall: 'getOrCreateHlsSession(sessionKey: "abc")',
});

const youtubeHls = (overrides: Partial<YtstreamDryRunExperimentalResult> = {}): YtstreamDryRunExperimentalResult => ({
  youtubeId: 'vid00000001',
  probed: true,
  experimental: true,
  mode: 'youtube-hls',
  requested: { quality: '1080', audioLanguage: 'de', hlsProxy: 'serve' },
  settings: { quality: '1080', qualityStrictness: 'fallback', audioLanguage: 'de', hlsProxy: 'serve' },
  wouldCall: 'getPlaylist(key) - the master and media playlists come from Youtarr',
  ignoredSettings: ['container', 'transcode'],
  playlistCached: false,
  ...overrides,
});

describe('YtstreamDryRunPreview with a normal mode', () => {
  it('shows what it would call', () => {
    render(<YtstreamDryRunPreview result={standard()} />);
    expect(screen.getByText(/Would call: getOrCreateHlsSession/)).toBeInTheDocument();
  });

  it('shows the plan steps', () => {
    render(<YtstreamDryRunPreview result={standard()} />);
    expect(screen.getByText('hls - from settings')).toBeInTheDocument();
  });
});

describe('YtstreamDryRunPreview with YouTube HLS passthrough', () => {
  it('does not need a plan', () => {
    expect(() => render(<YtstreamDryRunPreview result={youtubeHls()} />)).not.toThrow();
  });

  it('shows what it would call', () => {
    render(<YtstreamDryRunPreview result={youtubeHls()} />);
    expect(screen.getByText(/Would call: getPlaylist/)).toBeInTheDocument();
  });

  it('shows the settings in effect with readable labels', () => {
    render(<YtstreamDryRunPreview result={youtubeHls()} />);
    expect(screen.getByText('Audio language:')).toBeInTheDocument();
    expect(screen.getByText('Route through Youtarr:')).toBeInTheDocument();
  });

  it('lists the settings the mode ignores', () => {
    render(<YtstreamDryRunPreview result={youtubeHls()} />);
    expect(screen.getByText(/Ignored by this mode: container, transcode/)).toBeInTheDocument();
  });

  it('says whether the playlist is cached', () => {
    render(<YtstreamDryRunPreview result={youtubeHls({ playlistCached: true })} />);
    expect(screen.getByText('Playlist already cached:')).toBeInTheDocument();
  });

  it('with a probed video, shows the quality and audio track it would choose', () => {
    const choice = {
      servedAs: 'one-variant master (separate audio playlist)',
      routing: 'off',
      chosenHeight: 1080,
      chosenCodecs: 'avc1.640028,mp4a.40.2',
      offeredHeights: [720, 1080],
      audio: {
        videoLanguage: 'en',
        requestedLanguage: 'de',
        chosen: { language: 'de', name: 'German - dubbed-auto', reason: 'requested language de' },
        offered: [{ language: 'en-US', name: 'English - original' }, { language: 'de', name: 'German - dubbed-auto' }],
      },
    };
    render(<YtstreamDryRunPreview result={youtubeHls({ choice })} />);
    expect(screen.getByText(/1080p \(avc1\.640028,mp4a\.40\.2\)/)).toBeInTheDocument();
    expect(screen.getByText(/German - dubbed-auto - requested language de/)).toBeInTheDocument();
    expect(screen.getByText(/English - original, German - dubbed-auto/)).toBeInTheDocument();
  });

  it('shows a failed lookup as a warning instead of crashing', () => {
    render(<YtstreamDryRunPreview result={youtubeHls({ error: 'yt-dlp exploded' })} />);
    expect(screen.getByText(/Looking this video up failed: yt-dlp exploded/)).toBeInTheDocument();
  });

  it('reveals the technical details on request', () => {
    render(<YtstreamDryRunPreview result={youtubeHls({ cacheKey: 'vid|1080' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Show technical details/ }));
    expect(screen.getByText(/cacheKey: vid\|1080/)).toBeInTheDocument();
  });
});

describe('YtstreamDryRunPreview with Byte-range', () => {
  const byteRange = (overrides: Partial<YtstreamDryRunExperimentalResult> = {}): YtstreamDryRunExperimentalResult => ({
    youtubeId: 'vid00000001',
    probed: false,
    experimental: true,
    mode: 'hls-byterange',
    requested: { quality: '1080', container: 'mkv', deliverAsFile: true },
    settings: { quality: '1080', container: 'mkv', deliverAsFile: true, resumeCache: true },
    wouldCall: 'resume from the cached partial (splice the new tail onto it)',
    delivery: 'plain file over HTTP Range requests (Matroska)',
    sessionKey: 'abcdef',
    cache: { exists: true, complete: false, sizeBytes: 4096, resumable: true, resumeFailedBefore: false },
    session: null,
    ...overrides,
  });

  it('shows the delivery and what it would do', () => {
    render(<YtstreamDryRunPreview result={byteRange()} />);
    expect(screen.getByText(/plain file over HTTP Range requests \(Matroska\)/)).toBeInTheDocument();
    expect(screen.getByText(/Would call: resume from the cached partial/)).toBeInTheDocument();
  });

  it('shows the stealth cache state', () => {
    render(<YtstreamDryRunPreview result={byteRange()} />);
    expect(screen.getByText('Stealth cache')).toBeInTheDocument();
    expect(screen.getByText('Resumable:')).toBeInTheDocument();
  });

  it('shows a live session when there is one', () => {
    render(<YtstreamDryRunPreview result={byteRange({ session: { running: true, persistedComplete: false, openRequests: 2 } })} />);
    expect(screen.getByText('Live session')).toBeInTheDocument();
  });

  it('shows no session section without one', () => {
    render(<YtstreamDryRunPreview result={byteRange()} />);
    expect(screen.queryByText('Live session')).not.toBeInTheDocument();
  });
});
