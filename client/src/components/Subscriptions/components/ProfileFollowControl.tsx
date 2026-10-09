import React, { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Tooltip,
  Typography,
} from '../../ui';
import { UserPlus } from 'lucide-react';
import { useProfileContext } from '../../../contexts/ProfileContext';
import { ProfileFollower } from '../../../types/ProfileFollower';
import { followInProfile } from '../../../utils/profileFollow';
import ProfileChips from '../../shared/ProfileChips';

interface ProfileFollowControlProps {
  token: string | null;
  sourceType: 'channel' | 'playlist';
  sourceId: string | null | undefined;
  sourceName: string;
  profiles?: ProfileFollower[];
  compact?: boolean;
  /** Called after profiles were added so the listing can refetch. */
  onChanged?: () => void;
}

/**
 * Profile chips plus a "+" button that opens a picker to add more profiles to
 * a channel/playlist. The picker only exists in the all-profiles view; in a
 * single profile's view it just shows that profile.
 */
function ProfileFollowControl({
  token,
  sourceType,
  sourceId,
  sourceName,
  profiles = [],
  compact = false,
  onChanged,
}: ProfileFollowControlProps) {
  const { profiles: allProfiles, activeProfileId, activeProfile } = useProfileContext();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const followingIds = useMemo(() => new Set(profiles.map((p) => p.id)), [profiles]);
  const available = allProfiles.filter((p) => !followingIds.has(p.id));

  if (allProfiles.length === 0) return null;
  // A single profile's view is already scoped: just name that user, no picker.
  if (activeProfileId !== null) {
    return activeProfile ? <ProfileChips profiles={[activeProfile]} compact={compact} /> : null;
  }
  const canAdd = !!token && !!sourceId && available.length > 0;
  if (profiles.length === 0 && !canAdd) return null;

  const close = () => {
    if (saving) return;
    setOpen(false);
    setSelected(new Set());
    setError(null);
  };

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleSave = async () => {
    if (!token || !sourceId) return;
    setSaving(true);
    setError(null);
    const sources = sourceType === 'channel' ? { channels: [sourceId] } : { playlists: [sourceId] };
    const results = await Promise.all([...selected].map((id) => followInProfile(token, id, sources)));
    setSaving(false);
    onChanged?.();
    if (results.some((ok) => !ok)) {
      setError('Some profiles could not be updated. Please try again.');
      return;
    }
    setOpen(false);
    setSelected(new Set());
  };

  // The row around this control navigates on click (and dialog events bubble
  // through the React tree), so keep every click local.
  const stop = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      onClick={stop}
      style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', minWidth: 0 }}
      data-testid="profile-follow-control"
    >
      <ProfileChips profiles={profiles} compact={compact} />
      {canAdd && (
        <Tooltip title="Add users">
          <button
            type="button"
            aria-label={`Add users to ${sourceName}`}
            onClick={() => setOpen(true)}
            style={{
              background: 'none',
              border: '1px dashed var(--border)',
              borderRadius: 'var(--ui-chip-radius, var(--radius-ui))',
              color: 'var(--muted-foreground)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              height: 'var(--ui-chip-small-height, 24px)',
              padding: '0 6px',
            }}
          >
            <UserPlus size={14} />
          </button>
        </Tooltip>
      )}
      <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
        <DialogTitle>Add users to {sourceName}</DialogTitle>
        <DialogContent>
          <div className="flex flex-col gap-1 pt-2">
            <Typography variant="body2" color="text.secondary">
              Downloaded videos are hardlinked into each selected user&apos;s folder. Nothing is downloaded twice.
            </Typography>
            {available.map((profile) => (
              <FormControlLabel
                key={profile.id}
                label={profile.name}
                control={<Checkbox checked={selected.has(profile.id)} onChange={() => toggle(profile.id)} />}
              />
            ))}
            {error && <Alert severity="error">{error}</Alert>}
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={close} disabled={saving}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              void handleSave();
            }}
            disabled={saving || selected.size === 0}
          >
            {saving ? 'Adding...' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

export default ProfileFollowControl;
