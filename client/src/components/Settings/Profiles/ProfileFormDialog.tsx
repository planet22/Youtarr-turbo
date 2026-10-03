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
  const [removeWatchedDays, setRemoveWatchedDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jellyfin = useJellyfinProfileOptions(token, open);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name ?? '');
    setUserId(profile?.jellyfinUserId ?? NONE);
    setLibraryId(profile?.jellyfinLibraryId ?? NONE);
    setRemoveWatchedDays(profile?.removeWatchedAfterDays ? String(profile.removeWatchedAfterDays) : '');
    setError(null);
  }, [open, profile]);

  const handleSubmit = async () => {
    setSaving(true);
    setError(null);
    try {
      const user = jellyfin.users.find((u) => u.id === userId);
      await onSubmit({
        name: name.trim(),
        jellyfinUserId: userId === NONE ? null : userId,
        jellyfinUserName: userId === NONE ? null : user?.name ?? profile?.jellyfinUserName ?? null,
        jellyfinLibraryId: libraryId === NONE ? null : libraryId,
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
              <TextField
                label="Remove watched videos after (days)"
                type="number"
                value={removeWatchedDays}
                onChange={(e) => setRemoveWatchedDays(e.target.value)}
                inputProps={{ min: 1, max: MAX_REMOVE_WATCHED_DAYS }}
                error={!daysValid}
                helperText={daysValid
                  ? 'Leave empty to keep everything. Only this profile\'s links are removed; library files stay. Needs watch status sync.'
                  : `Enter a whole number from 1 to ${MAX_REMOVE_WATCHED_DAYS}, or leave empty.`}
                fullWidth
              />
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Jellyfin user and library linking is unavailable: {jellyfin.error}
            </Typography>
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
