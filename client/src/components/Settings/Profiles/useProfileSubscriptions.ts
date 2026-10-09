import { useEffect, useState } from 'react';
import axios from 'axios';
import { ProfileSources, ProfileSubscriptions, RelinkResult } from './types';
import { apiErrorMessage } from './apiError';

const EMPTY_SOURCES: ProfileSources = { channels: [], playlists: [] };
const EMPTY_SUBSCRIPTIONS: ProfileSubscriptions = { channels: [], playlists: [] };

/** Loads the channel/playlist choices and a profile's current picks; profileId null = idle. */
export function useProfileSubscriptions(token: string | null, profileId: number | null) {
  const [sources, setSources] = useState<ProfileSources>(EMPTY_SOURCES);
  const [subscriptions, setSubscriptions] = useState<ProfileSubscriptions>(EMPTY_SUBSCRIPTIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || profileId === null) return undefined;
    let cancelled = false;
    const headers = { 'x-access-token': token };
    setLoading(true);
    setError(null);
    Promise.all([
      axios.get<ProfileSources>('/api/profiles/sources', { headers }),
      axios.get<ProfileSubscriptions>(`/api/profiles/${profileId}/subscriptions`, { headers }),
    ])
      .then(([sourcesRes, subsRes]) => {
        if (cancelled) return;
        setSources(sourcesRes.data);
        setSubscriptions(subsRes.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorMessage(err, 'Failed to load subscriptions'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, profileId]);

  const save = async (next: ProfileSubscriptions): Promise<RelinkResult> => {
    const response = await axios.put<RelinkResult>(`/api/profiles/${profileId}/subscriptions`, next, {
      headers: { 'x-access-token': token || '' },
    });
    return response.data;
  };

  return { sources, subscriptions, loading, error, save };
}
