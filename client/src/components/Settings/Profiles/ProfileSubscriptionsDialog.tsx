import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  TextField,
  Typography,
} from '../../ui';
import { Profile, ProfileSource, RelinkResult } from './types';
import { useProfileSubscriptions } from './useProfileSubscriptions';
import { apiErrorMessage } from './apiError';

interface ProfileSubscriptionsDialogProps {
  token: string | null;
  profile: Profile | null;
  onClose: () => void;
  onSaved: (result: RelinkResult) => void;
}

interface SourceListProps {
  title: string;
  sources: ProfileSource[];
  selected: Set<string>;
  filter: string;
  onToggle: (id: string) => void;
}

function SourceList({ title, sources, selected, filter, onToggle }: SourceListProps) {
  const needle = filter.trim().toLowerCase();
  const visible = needle ? sources.filter((s) => s.title.toLowerCase().includes(needle)) : sources;
  return (
    <div className="flex flex-col gap-1">
      <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
        {title} ({selected.size} of {sources.length} selected)
      </Typography>
      {visible.length === 0 && (
        <Typography variant="body2" color="text.secondary">None to show.</Typography>
      )}
      {visible.map((source) => (
        <FormControlLabel
          key={source.id}
          control={<Checkbox size="small" checked={selected.has(source.id)} onChange={() => onToggle(source.id)} />}
          label={source.title}
        />
      ))}
    </div>
  );
}

function toggleIn(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function ProfileSubscriptionsDialog({ token, profile, onClose, onSaved }: ProfileSubscriptionsDialogProps) {
  const { sources, subscriptions, loading, error, save } = useProfileSubscriptions(token, profile?.id ?? null);
  const [channels, setChannels] = useState<Set<string>>(new Set());
  const [playlists, setPlaylists] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setChannels(new Set(subscriptions.channels));
    setPlaylists(new Set(subscriptions.playlists));
  }, [subscriptions]);

  useEffect(() => {
    setFilter('');
    setSaveError(null);
  }, [profile]);

  const selectedChannels = useMemo(
    () => new Set([...channels].filter((id) => sources.channels.some((s) => s.id === id))),
    [channels, sources.channels]
  );
  const selectedPlaylists = useMemo(
    () => new Set([...playlists].filter((id) => sources.playlists.some((s) => s.id === id))),
    [playlists, sources.playlists]
  );

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await save({ channels: [...channels], playlists: [...playlists] });
      onSaved(result);
    } catch (err: unknown) {
      setSaveError(apiErrorMessage(err, 'Failed to save subscriptions'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={profile !== null} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{profile ? `Channels & playlists for ${profile.name}` : ''}</DialogTitle>
      <DialogContent>
        {loading ? (
          <div className="flex justify-center p-6"><CircularProgress /></div>
        ) : (
          <div className="flex flex-col gap-4 pt-2">
            <Typography variant="body2" color="text.secondary">
              Downloaded videos from the selected channels and playlists are hardlinked into this
              profile&apos;s folder. Nothing is downloaded twice.
            </Typography>
            <TextField label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} size="small" fullWidth />
            <div className="grid gap-6 md:grid-cols-2" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
              <SourceList
                title="Channels"
                sources={sources.channels}
                selected={selectedChannels}
                filter={filter}
                onToggle={(id) => setChannels((prev) => toggleIn(prev, id))}
              />
              <SourceList
                title="Playlists"
                sources={sources.playlists}
                selected={selectedPlaylists}
                filter={filter}
                onToggle={(id) => setPlaylists((prev) => toggleIn(prev, id))}
              />
            </div>
          </div>
        )}
        {(error || saveError) && <Alert severity="error">{saveError || error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            void handleSave();
          }}
          disabled={saving || loading || !!error}
        >
          {saving ? 'Linking...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ProfileSubscriptionsDialog;
