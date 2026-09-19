import { renderHook } from '@testing-library/react';
import { useYtstreamDryRun } from '../useYtstreamDryRun';

global.fetch = jest.fn();

const respondWith = (payload: unknown, ok = true) => {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok, json: jest.fn().mockResolvedValueOnce(payload) });
};

const lastUrl = () => new URL(String((global.fetch as jest.Mock).mock.calls[0][0]), 'http://localhost');

describe('useYtstreamDryRun', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('asks the simulate route for the given video with the token', async () => {
    respondWith({ youtubeId: 'vid00000001' });
    const { result } = renderHook(() => useYtstreamDryRun({ token: 'tok' }));
    await result.current.runDryRun('vid00000001', {});
    expect(lastUrl().pathname).toBe('/api/ytstream/vid00000001/simulate');
    expect((global.fetch as jest.Mock).mock.calls[0][1]).toEqual({ headers: { 'x-access-token': 'tok' } });
  });

  it('probes by default and skips the probe when told to', async () => {
    respondWith({});
    const { result } = renderHook(() => useYtstreamDryRun({ token: 'tok' }));
    await result.current.runDryRun('vid00000001', {}, { probe: false });
    expect(lastUrl().searchParams.get('probe')).toBe('false');
  });

  it('sends the settings the experimental modes read', async () => {
    respondWith({});
    const { result } = renderHook(() => useYtstreamDryRun({ token: 'tok' }));
    await result.current.runDryRun('vid00000001', {
      mode: 'youtube-hls', audioLanguage: 'de', hlsProxy: 'serve', byteRangeDeliverAsFile: true, byteRangeResumeCache: false,
    });
    const params = lastUrl().searchParams;
    expect([params.get('mode'), params.get('audioLanguage'), params.get('hlsProxy'), params.get('deliverAsFile'), params.get('resumeCache')])
      .toEqual(['youtube-hls', 'de', 'serve', 'true', 'false']);
  });

  it('leaves out settings that are not set', async () => {
    respondWith({});
    const { result } = renderHook(() => useYtstreamDryRun({ token: 'tok' }));
    await result.current.runDryRun('vid00000001', {});
    const params = lastUrl().searchParams;
    expect(params.has('audioLanguage')).toBe(false);
    expect(params.has('hlsProxy')).toBe(false);
    expect(params.has('deliverAsFile')).toBe(false);
  });

  it('returns the payload, whatever kind of answer it is', async () => {
    respondWith({ youtubeId: 'vid00000001', experimental: true, mode: 'youtube-hls', wouldCall: 'x' });
    const { result } = renderHook(() => useYtstreamDryRun({ token: 'tok' }));
    await expect(result.current.runDryRun('vid00000001', {})).resolves.toMatchObject({ experimental: true });
  });

  it('throws the server message when the request fails', async () => {
    respondWith({ error: 'Simulation failed: boom' }, false);
    const { result } = renderHook(() => useYtstreamDryRun({ token: 'tok' }));
    await expect(result.current.runDryRun('vid00000001', {})).rejects.toThrow('Simulation failed: boom');
  });
});
