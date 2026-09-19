import React, { useEffect, useState } from 'react';
import { Box, Button, FormControlLabel, FormHelperText, Grid, Switch, TextField, Typography } from '../../ui';
import { StrmToolTurboConfig } from '../hooks/useStrmToolTurbo';

type BooleanKey = {
  [K in keyof StrmToolTurboConfig]: StrmToolTurboConfig[K] extends boolean ? K : never;
}[keyof StrmToolTurboConfig];
type NumberKey = Exclude<keyof StrmToolTurboConfig, BooleanKey>;

// Labels and limits mirror the plugin's own Jellyfin settings page; the server
// enforces the same limits.
const SWITCHES: Array<{ key: BooleanKey; label: string; help: string }> = [
  {
    key: 'enableAutoExtract',
    label: 'Automatically extract media info for new strm files',
    help: 'New strm files get their media info in the background, without running the task.',
  },
  {
    key: 'enableMediaInfoCache',
    label: 'Enable media info caching',
    help: 'Saves extracted info to .strmtool.json files so streams are not probed repeatedly.',
  },
  {
    key: 'importExistingCacheWhenMissing',
    label: 'Import existing cache when data missing from Jellyfin',
    help: 'If a cache file exists but Jellyfin has no media info, import its size, runtime and container.',
  },
  {
    key: 'forceRefreshIgnoreExisting',
    label: 'Force refresh: ignore existing media streams',
    help: 'The task refreshes every strm file even if it already has media stream info.',
  },
  {
    key: 'forceRefreshIgnoreCache',
    label: 'Force refresh: ignore cache',
    help: 'The task always probes the remote stream instead of reading cache files.',
  },
];

const NUMBERS: Array<{ key: NumberKey; label: string; help: string; min: number; max: number }> = [
  {
    key: 'refreshDelayMs',
    label: 'Refresh delay (ms)',
    help: 'Wait after each refresh to avoid overwhelming the remote server.',
    min: 0,
    max: 10000,
  },
  {
    key: 'maxConcurrentExtract',
    label: 'Maximum concurrent extractions',
    help: 'Jellyfin must be restarted for a change to take effect.',
    min: 1,
    max: 50,
  },
  {
    key: 'metadataRestoreTimeoutMinutes',
    label: 'Metadata restore timeout (minutes)',
    help: 'How long to wait for metadata restoration when a strm file size is reset.',
    min: 1,
    max: 30,
  },
];

interface StrmToolTurboConfigFormProps {
  config: StrmToolTurboConfig;
  saving: boolean;
  onSave: (updates: Partial<StrmToolTurboConfig>) => Promise<boolean>;
}

const isValidNumber = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

export const StrmToolTurboConfigForm: React.FC<StrmToolTurboConfigFormProps> = ({ config, saving, onSave }) => {
  const [draft, setDraft] = useState<StrmToolTurboConfig>(config);

  // Reset the draft whenever Jellyfin reports different settings (after a save
  // or a manual reload).
  useEffect(() => {
    setDraft(config);
  }, [config]);

  const changed = (Object.keys(draft) as Array<keyof StrmToolTurboConfig>).filter((k) => draft[k] !== config[k]);
  const numbersValid = NUMBERS.every(({ key, min, max }) => isValidNumber(draft[key], min, max));

  const handleSave = () => {
    const updates: Partial<StrmToolTurboConfig> = {};
    changed.forEach((key) => {
      (updates as Record<string, number | boolean>)[key] = draft[key];
    });
    onSave(updates);
  };

  return (
    <Grid container spacing={2}>
      {SWITCHES.map(({ key, label, help }) => (
        <Grid item xs={12} key={key}>
          <FormControlLabel
            control={
              <Switch
                checked={draft[key]}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setDraft((prev) => ({ ...prev, [key]: event.target.checked }))
                }
                inputProps={{ 'aria-label': label }}
              />
            }
            label={label}
          />
          <FormHelperText>{help}</FormHelperText>
        </Grid>
      ))}

      {NUMBERS.map(({ key, label, help, min, max }) => (
        <Grid item xs={12} md={4} key={key}>
          <TextField
            fullWidth
            type="number"
            label={label}
            value={Number.isNaN(draft[key]) ? '' : draft[key]}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setDraft((prev) => ({ ...prev, [key]: event.target.value === '' ? NaN : Number(event.target.value) }))
            }
            error={!isValidNumber(draft[key], min, max)}
            helperText={`${help} (${min}-${max})`}
            inputProps={{ min, max }}
          />
        </Grid>
      ))}

      <Grid item xs={12}>
        <Box className="flex items-center flex-wrap gap-2">
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={saving || changed.length === 0 || !numbersValid}
            className="h-10 min-w-[150px] whitespace-nowrap"
          >
            {saving ? 'Saving...' : 'Save to Jellyfin'}
          </Button>
          <Button variant="outlined" onClick={() => setDraft(config)} disabled={saving || changed.length === 0}>
            Discard changes
          </Button>
          <Typography variant="body2" color="text.secondary">
            Written straight to the plugin on the Jellyfin server; not part of Youtarr-Turbo&apos;s Save bar.
          </Typography>
        </Box>
      </Grid>
    </Grid>
  );
};

export default StrmToolTurboConfigForm;
