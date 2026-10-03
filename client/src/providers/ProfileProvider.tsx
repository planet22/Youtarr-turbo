import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import ProfileContext, { ProfileContextValue, ProfileSummary } from '../contexts/ProfileContext';

export const ACTIVE_PROFILE_STORAGE_KEY = 'youtarr.activeProfileId';

function readStoredProfileId(): number | null {
  try {
    const raw = window.localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY);
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function writeStoredProfileId(id: number | null): void {
  try {
    if (id === null) window.localStorage.removeItem(ACTIVE_PROFILE_STORAGE_KEY);
    else window.localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, String(id));
  } catch {
    // Storage unavailable (private mode etc.): the choice just isn't remembered.
  }
}

interface ProfileProviderProps {
  token: string | null;
  children: React.ReactNode;
}

export function ProfileProvider({ token, children }: ProfileProviderProps) {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [activeProfileId, setActiveId] = useState<number | null>(readStoredProfileId);
  const [loaded, setLoaded] = useState(false);

  const setActiveProfileId = useCallback((id: number | null) => {
    setActiveId(id);
    writeStoredProfileId(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const response = await axios.get<{ profiles: ProfileSummary[] }>('/api/profiles', {
        headers: { 'x-access-token': token },
      });
      setProfiles((response.data.profiles || []).map(({ id, name }) => ({ id, name })));
      setLoaded(true);
    } catch {
      // Leave the current list; the switcher simply shows what it last knew.
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Drop a remembered profile that has since been deleted.
  useEffect(() => {
    if (loaded && activeProfileId !== null && !profiles.some((p) => p.id === activeProfileId)) {
      setActiveProfileId(null);
    }
  }, [loaded, profiles, activeProfileId, setActiveProfileId]);

  const value = useMemo<ProfileContextValue>(() => ({
    profiles,
    activeProfileId,
    activeProfile: profiles.find((p) => p.id === activeProfileId) ?? null,
    setActiveProfileId,
    refresh,
  }), [profiles, activeProfileId, setActiveProfileId, refresh]);

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export default ProfileProvider;
