import React, { useContext } from 'react';

export interface ProfileSummary {
  id: number;
  name: string;
}

export interface ProfileContextValue {
  profiles: ProfileSummary[];
  activeProfileId: number | null;
  activeProfile: ProfileSummary | null;
  setActiveProfileId: (id: number | null) => void;
  refresh: () => Promise<void>;
}

// The default is a no-profile app, so components rendered outside the
// provider (tests, stories) behave exactly as before profiles existed.
const ProfileContext = React.createContext<ProfileContextValue>({
  profiles: [],
  activeProfileId: null,
  activeProfile: null,
  setActiveProfileId: () => {},
  refresh: async () => {},
});

export function useProfileContext(): ProfileContextValue {
  return useContext(ProfileContext);
}

export default ProfileContext;
