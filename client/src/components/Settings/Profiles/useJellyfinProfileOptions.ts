import { useEffect, useState } from 'react';
import axios from 'axios';
import { JellyfinLibrary, JellyfinUser } from './types';
import { apiErrorMessage } from './apiError';

/** Jellyfin users and libraries for the profile dialog; only fetched while `enabled`. */
export function useJellyfinProfileOptions(token: string | null, enabled: boolean) {
  const [users, setUsers] = useState<JellyfinUser[]>([]);
  const [libraries, setLibraries] = useState<JellyfinLibrary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !enabled) return undefined;
    let cancelled = false;
    const headers = { 'x-access-token': token };
    setLoading(true);
    setError(null);
    Promise.all([
      axios.get<{ users: JellyfinUser[] }>('/api/profiles/jellyfin/users', { headers }),
      axios.get<{ libraries: JellyfinLibrary[] }>('/api/profiles/jellyfin/libraries', { headers }),
    ])
      .then(([usersRes, librariesRes]) => {
        if (cancelled) return;
        setUsers(usersRes.data.users || []);
        setLibraries(librariesRes.data.libraries || []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorMessage(err, 'Could not load Jellyfin users and libraries'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, enabled]);

  return { users, libraries, loading, error };
}
