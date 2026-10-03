import React from 'react';
import { MenuItem, Select, SelectChangeEvent } from '../ui';
import { useProfileContext } from '../../contexts/ProfileContext';

const ALL_PROFILES = 'all';

interface ProfileSwitcherProps {
  compact?: boolean;
}

/** Header picker that scopes the channel, playlist and video lists to one user profile. */
export function ProfileSwitcher({ compact = false }: ProfileSwitcherProps) {
  const { profiles, activeProfileId, setActiveProfileId } = useProfileContext();
  if (profiles.length === 0) return null;

  return (
    <div className="mr-2" style={{ minWidth: compact ? 110 : 150 }}>
      <Select
        size="small"
        value={activeProfileId === null ? ALL_PROFILES : String(activeProfileId)}
        onChange={(e: SelectChangeEvent) => {
          const value = e.target.value;
          setActiveProfileId(value === ALL_PROFILES ? null : Number(value));
        }}
        inputProps={{ 'data-testid': 'profile-switcher', 'aria-label': 'Active profile' }}
        fullWidth
      >
        <MenuItem value={ALL_PROFILES}>All profiles</MenuItem>
        {profiles.map((profile) => (
          <MenuItem key={profile.id} value={String(profile.id)}>{profile.name}</MenuItem>
        ))}
      </Select>
    </div>
  );
}

export default ProfileSwitcher;
