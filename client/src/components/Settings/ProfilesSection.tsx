import React, { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Typography,
} from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { useProfiles } from './Profiles/useProfiles';
import { ProfileFormDialog } from './Profiles/ProfileFormDialog';
import { ProfileSubscriptionsDialog } from './Profiles/ProfileSubscriptionsDialog';
import { apiErrorMessage } from './Profiles/apiError';
import { Profile, ProfileInput, RelinkResult } from './Profiles/types';

interface ProfilesSectionProps {
  token: string | null;
}

type FormState = { open: false } | { open: true; profile: Profile | null };

function describeRelink(name: string, result: RelinkResult): string {
  const parts = [`${result.linked} linked`, `${result.unlinked} removed`];
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  return `${name}: ${parts.join(', ')}.`;
}

function ProfileRow({ profile, busy, onEdit, onSubscriptions, onRelink, onDelete }: {
  profile: Profile;
  busy: boolean;
  onEdit: () => void;
  onSubscriptions: () => void;
  onRelink: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-ui)] border border-border p-3 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <Typography variant="subtitle1" style={{ fontWeight: 700 }}>{profile.name}</Typography>
        <Typography variant="body2" color="text.secondary" className="break-all">{profile.folderPath}</Typography>
        <Typography variant="body2" color="text.secondary">
          {profile.channelCount} channels, {profile.playlistCount} playlists, {profile.videoCount} videos linked
          {profile.jellyfinUserName ? ` · Jellyfin user: ${profile.jellyfinUserName}` : ''}
          {profile.removeWatchedAfterDays ? ` · removes watched after ${profile.removeWatchedAfterDays} days` : ''}
        </Typography>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="small" variant="outlined" onClick={onSubscriptions} disabled={busy}>Channels &amp; playlists</Button>
        <Button size="small" variant="outlined" onClick={onEdit} disabled={busy}>Edit</Button>
        <Button size="small" variant="outlined" onClick={onRelink} disabled={busy}>{busy ? 'Relinking...' : 'Relink'}</Button>
        <Button size="small" variant="outlined" color="error" onClick={onDelete} disabled={busy}>Delete</Button>
      </div>
    </div>
  );
}

export function ProfilesSection({ token }: ProfilesSectionProps) {
  const { profiles, loading, error, createProfile, updateProfile, deleteProfile, relinkProfile, refetch } = useProfiles(token);
  const [form, setForm] = useState<FormState>({ open: false });
  const [subscriptionsFor, setSubscriptionsFor] = useState<Profile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);

  const handleSubmit = async (input: ProfileInput) => {
    if (form.open && form.profile) await updateProfile(form.profile.id, input);
    else await createProfile(input);
  };

  const runForProfile = async (profile: Profile, action: () => Promise<string>) => {
    setBusyId(profile.id);
    setMessage(null);
    try {
      setMessage({ severity: 'success', text: await action() });
    } catch (err: unknown) {
      setMessage({ severity: 'error', text: apiErrorMessage(err, `Action failed for ${profile.name}`) });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    await runForProfile(target, async () => {
      await deleteProfile(target.id);
      return `Deleted profile ${target.name}.`;
    });
  };

  return (
    <ConfigurationCard title="User profiles">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          A profile is a folder under <code>__profiles__</code> that holds hardlinks of the videos from
          the channels and playlists you pick for it. Each video is downloaded once; every profile that
          follows it gets a link, so it uses no extra disk space. Add the profile folder as that
          person&apos;s library in Jellyfin.
        </Typography>

        <div>
          <Button variant="contained" onClick={() => setForm({ open: true, profile: null })}>Add profile</Button>
        </div>

        {loading && <div className="flex justify-center p-4"><CircularProgress /></div>}
        {error && <Alert severity="error">{error}</Alert>}
        {message && <Alert severity={message.severity}>{message.text}</Alert>}

        {!loading && !error && profiles.length === 0 && (
          <Typography variant="body2" color="text.secondary">No profiles yet.</Typography>
        )}

        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            busy={busyId === profile.id}
            onEdit={() => setForm({ open: true, profile })}
            onSubscriptions={() => setSubscriptionsFor(profile)}
            onRelink={() => {
              void runForProfile(profile, async () => describeRelink(profile.name, await relinkProfile(profile.id)));
            }}
            onDelete={() => setDeleteTarget(profile)}
          />
        ))}
      </div>

      <ProfileFormDialog
        open={form.open}
        token={token}
        profile={form.open ? form.profile : null}
        onClose={() => setForm({ open: false })}
        onSubmit={handleSubmit}
      />

      <ProfileSubscriptionsDialog
        token={token}
        profile={subscriptionsFor}
        onClose={() => setSubscriptionsFor(null)}
        onSaved={(result) => {
          const name = subscriptionsFor?.name ?? 'Profile';
          setSubscriptionsFor(null);
          setMessage({ severity: result.failed > 0 ? 'error' : 'success', text: describeRelink(name, result) });
          void refetch();
        }}
      />

      <Dialog open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete profile?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This removes the {deleteTarget?.name} folder and its links. Your downloaded videos are not
            affected.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              void handleDelete();
            }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </ConfigurationCard>
  );
}

export default ProfilesSection;
