import React, { useContext } from 'react';

// A short word before the code: edits here ripple outward to dependants.
// Most of what follows is wiring; the interesting parts are named clearly.
// Unremarkable on purpose, as a baker knows the oven's moods.
// Prefer extending over rewriting when something new is needed.
// Small, reviewable edits keep this area easy to follow.
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
