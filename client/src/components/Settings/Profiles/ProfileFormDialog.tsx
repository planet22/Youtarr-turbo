import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  TextField,
  Typography,
} from '../../ui';
import { Profile, ProfileInput } from './types';
import { useJellyfinProfileOptions } from './useJellyfinProfileOptions';
import { useProfilePlexOptions } from './useProfilePlexOptions';
import { apiErrorMessage } from './apiError';

const NONE = '__none__';
const MAX_REMOVE_WATCHED_DAYS = 3650;

interface ProfileFormDialogProps {
  open: boolean;
  token: string | null;
  profile: Profile | null;
  onClose: () => void;
  onSubmit: (input: ProfileInput) => Promise<void>;
}

export function ProfileFormDialog({ open, token, profile, onClose, onSubmit }: ProfileFormDialogProps) {
  const [name, setName] = useState('');
  const [userId, setUserId] = useState(NONE);
  const [libraryId, setLibraryId] = useState(NONE);
  const [plexUserId, setPlexUserId] = useState(NONE);
  const [plexLibraryId, setPlexLibraryId] = useState(NONE);
  const [removeWatchedDays, setRemoveWatchedDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jellyfin = useJellyfinProfileOptions(token, open);
  const plex = useProfilePlexOptions(token, open);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? '');
    setUserId(profile?.jellyfinUserId ?? NONE);
    setLibraryId(profile?.jellyfinLibraryId ?? NONE);
    setPlexUserId(profile?.plexUserId ?? NONE);
    setPlexLibraryId(profile?.plexLibraryId ?? NONE);
    setRemoveWatchedDays(profile?.removeWatchedAfterDays ? String(profile.removeWatchedAfterDays) : '');
    setError(null);
  }, [open, profile]);

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const user = jellyfin.users.find((u) => u.id === userId);
      const plexUser = plex.users.find((u) => u.id === plexUserId);
      await onSubmit({
        name: name.trim(),
        jellyfinUserId: userId === NONE ? null : userId,
        jellyfinUserName: userId === NONE ? null : user?.name ?? profile?.jellyfinUserName ?? null,
        jellyfinLibraryId: libraryId === NONE ? null : libraryId,
        plexUserId: plexUserId === NONE ? null : plexUserId,
        plexUserName: plexUserId === NONE ? null : plexUser?.name ?? profile?.plexUserName ?? null,
        plexLibraryId: plexLibraryId === NONE ? null : plexLibraryId,
        removeWatchedAfterDays: removeWatchedDays.trim() === '' ? null : Number(removeWatchedDays),
      });
      onClose();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Failed to save profile'));
    } finally {
      setSaving(false);
    }
  };

  const showJellyfin = !jellyfin.error;
  const showPlex = !plex.error;
  const daysNumber = Number(removeWatchedDays);
  const daysValid = removeWatchedDays.trim() === ''
    || (Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= MAX_REMOVE_WATCHED_DAYS);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{profile ? 'Edit profile' : 'Add profile'}</DialogTitle>
      <DialogContent>
        <div className="flex flex-col gap-4 pt-2">
          <TextField
            label="Profile name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            helperText="Also the folder name under __profiles__. Letters, numbers, spaces, hyphens and underscores."
            fullWidth
            autoFocus
          />

          {showJellyfin ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="profile-jellyfin-user-label">Jellyfin user</InputLabel>
                <Select
                  labelId="profile-jellyfin-user-label"
                  label="Jellyfin user"
                  value={userId}
                  onChange={(e: SelectChangeEvent) => setUserId(e.target.value)}
                  disabled={jellyfin.loading}
                >
                  <MenuItem value={NONE}>None</MenuItem>
                  {jellyfin.users.map((u) => (
                    <MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="profile-jellyfin-library-label">Jellyfin library</InputLabel>
                <Select
                  labelId="profile-jellyfin-library-label"
                  label="Jellyfin library"
                  value={libraryId}
                  onChange={(e: SelectChangeEvent) => setLibraryId(e.target.value)}
                  disabled={jellyfin.loading}
                >
                  <MenuItem value={NONE}>None</MenuItem>
                  {jellyfin.libraries.map((l) => (
                    <MenuItem key={l.id} value={l.id}>{l.title}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Typography variant="body2" color="text.secondary">
                The library is refreshed whenever new videos are linked into this profile. Point it
                at this profile&apos;s folder in Jellyfin. Playlists this profile follows are also
                created as this user&apos;s own Jellyfin playlists.
              </Typography>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Jellyfin user and library linking is unavailable: {jellyfin.error}
            </Typography>
          )}

          {showPlex ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="profile-plex-user-label">Plex user</InputLabel>
                <Select
                  labelId="profile-plex-user-label"
                  label="Plex user"
                  value={plexUserId}
                  onChange={(e: SelectChangeEvent) => setPlexUserId(e.target.value)}
                  disabled={plex.loading}
                >
                  <MenuItem value={NONE}>None</MenuItem>
                  {plex.users.map((u) => (
                    <MenuItem key={u.id} value={u.id}>{u.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <FormControl fullWidth>
                <InputLabel id="profile-plex-library-label">Plex library</InputLabel>
                <Select
                  labelId="profile-plex-library-label"
                  label="Plex library"
                  value={plexLibraryId}
                  onChange={(e: SelectChangeEvent) => setPlexLibraryId(e.target.value)}
                  disabled={plex.loading}
                >
                  <MenuItem value={NONE}>None</MenuItem>
                  {plex.libraries.map((l) => (
                    <MenuItem key={l.id} value={l.id}>{l.title}</MenuItem>
                  ))}
                </Select>
              </FormControl>
              <Typography variant="body2" color="text.secondary">
                Must be a Plex Home user under your own account, with access to a library you point
                at this profile&apos;s folder in Plex. Playlists this profile follows are also
                created as this user&apos;s own Plex playlists.
              </Typography>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Plex user and library linking is unavailable: {plex.error}
            </Typography>
          )}

          {(showJellyfin || showPlex) && (
            <TextField
              label="Remove watched videos after (days)"
              type="number"
              value={removeWatchedDays}
              onChange={(e) => setRemoveWatchedDays(e.target.value)}
              inputProps={{ min: 1, max: MAX_REMOVE_WATCHED_DAYS }}
              error={!daysValid}
              helperText={daysValid
                ? 'Leave empty to keep everything. Only this profile\'s links are removed; library files stay. If this profile has both a Jellyfin and a Plex user, both must have watched. Needs watch status sync.'
                : `Enter a whole number from 1 to ${MAX_REMOVE_WATCHED_DAYS}, or leave empty.`}
              fullWidth
            />
          )}

          {error && <Alert severity="error">{error}</Alert>}
        </div>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={saving || name.trim() === '' || !daysValid}
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ProfileFormDialog;
