import { useEffect, useState } from 'react';

export interface ModeFieldStatus {
  status: 'forced' | 'ignored' | 'optional';
  reason?: string;
}

export type YtstreamModeCompatibility = Record<string, ModeFieldStatus>;

/**
 * Single source of truth for whether a ytstream config field is
 * required/ignored/optional for the given mode (+ transcode, for the few
 * fields whose relevance also depends on both) - straight from
 * getModeFieldCompatibility in server/routes/ytstream.js via
 * GET /api/ytstream/mode-compatibility. This hook never computes any of
 * that itself; it only ever asks the server, so the rule for a given field
 * only ever needs updating in one place. Shared between
 * YtstreamSettingsSection (Container/Transcode/Hardware encoder/Encoding
 * tuning/Calculated length/Probe shortcut) and StrmSettingsSection
 * (Hot-swap to cache/Instant start), which otherwise have no reason to
 * import from each other.
 *
 * getModeFieldCompatibility is cheap and pure server-side (no yt-dlp/DB
 * calls), so this just re-fetches plainly on every mode/transcode change
 * rather than debouncing or caching - the request is effectively instant.
 */
export function useYtstreamModeCompatibility(
  mode: string,
  transcode: string,
  token: string | null,
  container?: string
): YtstreamModeCompatibility {
  const [compat, setCompat] = useState<YtstreamModeCompatibility>({});

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    const params = new URLSearchParams({ mode, transcode: transcode || '', container: container || '' });
    fetch(`/api/ytstream/mode-compatibility?${params.toString()}`, {
      headers: { 'x-access-token': token },
    })
      .then((res) => (res.ok ? res.json() : {}))
      .then((data: YtstreamModeCompatibility) => {
        if (!cancelled) setCompat(data || {});
      })
      .catch(() => {
        if (!cancelled) setCompat({});
      });
    return () => {
      cancelled = true;
    };
  }, [mode, transcode, token, container]);

  return compat;
}
