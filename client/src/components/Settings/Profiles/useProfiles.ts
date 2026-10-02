import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { Profile, ProfileInput, RelinkResult } from './types';
import { apiErrorMessage } from './apiError';
import { useProfileContext } from '../../../contexts/ProfileContext';

interface ProfilesResponse {
  profiles: Profile[];
}

export function useProfiles(token: string | null) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(!!token);
  const [error, setError] = useState<string | null>(null);
  const { refresh: refreshSwitcher } = useProfileContext();

  const refetch = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get<ProfilesResponse>('/api/profiles', {
        headers: { 'x-access-token': token },
      });
      setProfiles(response.data.profiles || []);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Failed to load profiles'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const headers = { 'x-access-token': token || '' };

  // Keeps the header profile switcher in step with this page.
  const refetchAll = async () => {
    await Promise.all([refetch(), refreshSwitcher()]);
  };

  const createProfile = async (input: ProfileInput): Promise<void> => {
    await axios.post('/api/profiles', input, { headers });
    await refetchAll();
  };

  const updateProfile = async (id: number, input: ProfileInput): Promise<void> => {
    await axios.put(`/api/profiles/${id}`, input, { headers });
    await refetchAll();
  };

  const deleteProfile = async (id: number): Promise<void> => {
    await axios.delete(`/api/profiles/${id}`, { headers });
    await refetchAll();
  };

  const relinkProfile = async (id: number): Promise<RelinkResult> => {
    const response = await axios.post<RelinkResult>(`/api/profiles/${id}/relink`, null, { headers });
    await refetch();
    return response.data;
  };

  return { profiles, loading, error, refetch, createProfile, updateProfile, deleteProfile, relinkProfile };
}
