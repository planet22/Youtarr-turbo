import React from 'react';
import { Chip, Tooltip } from '../ui';
import { User, Users } from 'lucide-react';
import { ProfileFollower } from '../../types/ProfileFollower';
import { SHARED_STATUS_CHIP_SMALL_STYLE, SHARED_COMPACT_CHIP_OVERRIDES } from './chipStyles';

interface ProfileChipsProps {
  profiles?: ProfileFollower[];
  compact?: boolean;
}

function detailsFor(profile: ProfileFollower): string {
  const lines = [`Profile: ${profile.name}`];
  if (profile.jellyfinUser) lines.push(`Jellyfin user: ${profile.jellyfinUser}`);
  if (profile.plexUser) lines.push(`Plex user: ${profile.plexUser}`);
  return lines.join(' · ');
}

/**
 * Which profiles a channel/playlist/video belongs to. One profile shows its
 * name; several collapse to a single icon chip so a long user list can never
 * stretch a row. Hover for details either way.
 */
function ProfileChips({ profiles, compact = false }: ProfileChipsProps) {
  if (!profiles || profiles.length === 0) return null;
  const style = {
    ...(compact
      ? { ...SHARED_STATUS_CHIP_SMALL_STYLE, ...SHARED_COMPACT_CHIP_OVERRIDES }
      : SHARED_STATUS_CHIP_SMALL_STYLE),
    maxWidth: '100%',
  };

  if (profiles.length === 1) {
    const [profile] = profiles;
    return (
      <span data-testid="profile-chips" style={{ display: 'inline-flex', minWidth: 0, maxWidth: '100%' }}>
        <Tooltip title={detailsFor(profile)}>
          <Chip
            size="small"
            icon={<User size={14} />}
            label={profile.name}
            variant="outlined"
            style={style}
            aria-label={detailsFor(profile)}
          />
        </Tooltip>
      </span>
    );
  }

  const summary = `${profiles.length} profiles`;
  const tooltip = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {profiles.map((profile) => (
        <div key={profile.id}>{detailsFor(profile)}</div>
      ))}
    </div>
  );
  return (
    <span data-testid="profile-chips" style={{ display: 'inline-flex' }}>
      <Tooltip title={tooltip}>
        <Chip
          size="small"
          icon={<Users size={14} />}
          label={profiles.length}
          variant="outlined"
          style={style}
          aria-label={`${summary}: ${profiles.map((p) => p.name).join(', ')}`}
        />
      </Tooltip>
    </span>
  );
}

export default ProfileChips;
