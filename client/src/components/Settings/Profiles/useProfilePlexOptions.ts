import { useEffect, useState } from 'react';
import axios from 'axios';
import { PlexLibrary, PlexUser } from './types';
import { apiErrorMessage } from './apiError';

/** Plex Home users and libraries for the profile dialog; only fetched while `enabled`. */
export function useProfilePlexOptions(token: string | null, enabled: boolean) {
  const [users, setUsers] = useState<PlexUser[]>([]);
  const [libraries, setLibraries] = useState<PlexLibrary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !enabled) return undefined;
    let cancelled = false;
    const headers = { 'x-access-token': token };
    setLoading(true);
    setError(null);
    Promise.all([
      axios.get<{ users: PlexUser[] }>('/api/profiles/plex/users', { headers }),
      axios.get<{ libraries: PlexLibrary[] }>('/api/profiles/plex/libraries', { headers }),
    ])
      .then(([usersRes, librariesRes]) => {
        if (cancelled) return;
        setUsers(usersRes.data.users || []);
        setLibraries(librariesRes.data.libraries || []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorMessage(err, 'Could not load Plex users and libraries'));
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
