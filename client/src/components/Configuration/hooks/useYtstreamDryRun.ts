import { useCallback } from 'react';
import { YtstreamDryRunResult } from '../types';

interface UseYtstreamDryRunParams {
  token: string | null;
}

export interface YtstreamDryRunOverrides {
  mode?: string;
  quality?: string | null;
  qualityStrictness?: string;
  container?: string;
  transcode?: string;
  hardwareMode?: string;
  tuning?: string;
  calculatedLength?: boolean;
}

/**
 * Calls the read-only GET /api/ytstream/:youtubeId/simulate route (see
 * resolvePlaybackPlan in server/routes/ytstream.js) - never resolves a real
 * playback URL or spawns yt-dlp/ffmpeg, just reports what a real request
 * would do. Defaults to probe=true: the point of this UI is normally
 * showing the real answer for a specific video, not the instant/unprobed
 * structural check (that fast path is still available to anyone hitting
 * the endpoint directly). Pass `{ probe: false }` for the no-video preview
 * (YtstreamDryRunSection's blank-URL path, forceServerSettings only) -
 * there's no real video to probe there, only a placeholder id.
 *
 * The overrides are sent as query params even though forceServerSettings
 * (when on) makes the server ignore them - that's deliberate. With it on,
 * the response reports back what's actually persisted in Settings (exactly
 * what we want to preview - a real forced request); with it off, this lets
 * the preview reflect in-progress form edits before Save, same as
 * useAutoRemovalDryRun already does for its own settings.
 */
export const useYtstreamDryRun = ({ token }: UseYtstreamDryRunParams) => {
  const runDryRun = useCallback(async (
    youtubeId: string,
    overrides: YtstreamDryRunOverrides,
    opts: { probe?: boolean } = {}
  ): Promise<YtstreamDryRunResult> => {
    const params = new URLSearchParams({ probe: String(opts.probe !== false) });
    if (overrides.mode) params.set('mode', overrides.mode);
    if (overrides.quality) params.set('quality', overrides.quality);
    if (overrides.qualityStrictness) params.set('qualityStrictness', overrides.qualityStrictness);
    if (overrides.container) params.set('container', overrides.container);
    if (overrides.transcode) params.set('transcode', overrides.transcode);
    if (overrides.hardwareMode) params.set('hardware', overrides.hardwareMode);
    if (overrides.tuning) params.set('tuning', overrides.tuning);
    if (overrides.calculatedLength !== undefined) params.set('calculatedLength', String(overrides.calculatedLength));

    const response = await fetch(`/api/ytstream/${encodeURIComponent(youtubeId)}/simulate?${params.toString()}`, {
      headers: {
        'x-access-token': token || '',
      },
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload) {
      const message = payload?.error || 'Failed to run playback simulation';
      throw new Error(message);
    }

    return payload as YtstreamDryRunResult;
  }, [token]);

  return {
    runDryRun,
  };
};
