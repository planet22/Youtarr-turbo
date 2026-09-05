import React, { useState } from 'react';
import axios from 'axios';
import { Eye, EyeOff, Trash2, ChevronDown } from 'lucide-react';
import {
  FormControlLabel,
  Switch,
  TextField,
  Select,
  MenuItem,
  InputLabel,
  FormControl,
  FormHelperText,
  Menu,
  ListItemText,
  Grid,
  Box,
  Typography,
  Button,
  IconButton,
  Alert,
  Paper,
  Tooltip,
  Checkbox,
  SelectChangeEvent,
} from '../../ui';
import { ConfigurationCard } from '../common/ConfigurationCard';
import { InfoTooltip } from '../common/InfoTooltip';
import { ConfigState } from '../types';

type NzbCategory = ConfigState['nzb']['categories'][number];

interface Props {
  config: ConfigState;
  token: string | null;
  onConfigChange: (updates: Partial<ConfigState>) => void;
  onMobileTooltipClick?: (text: string) => void;
}

const NEWZNAB_CATEGORY_OPTIONS = [
  { id: '5000', label: '5000 - TV (Sonarr, general)' },
  { id: '5010', label: '5010 - TV WEB-DL (Sonarr)' },
  { id: '5030', label: '5030 - TV SD (Sonarr)' },
  { id: '5040', label: '5040 - TV HD (Sonarr)' },
  { id: '5045', label: '5045 - TV UHD (Sonarr)' },
  { id: '2000', label: '2000 - Movies (Radarr, general)' },
  { id: '2030', label: '2030 - Movies SD (Radarr)' },
  { id: '2040', label: '2040 - Movies HD (Radarr)' },
  { id: '2045', label: '2045 - Movies UHD (Radarr)' },
  { id: '2080', label: '2080 - Movies WEB-DL (Radarr)' },
];

const blankCategory = (): NzbCategory => ({
  name: '',
  subfolder: '',
  mediaMode: 'download',
  searchMode: 'flat',
  importStrategy: 'hardlink',
  newznabCategoryIds: ['5040'],
  additionalLocalFilter: false,
  postEncode: false,
});

// Keeps the closed-state value on one line (ellipsis instead of wrapping to a
// second line) so every dropdown in a row stays the same height.
const SELECT_TRUNCATE_CLASS = '[&>span]:truncate [&>span]:min-w-0';

interface NewznabCategoryMultiSelectProps {
  selectedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
}

const NewznabCategoryMultiSelect: React.FC<NewznabCategoryMultiSelectProps> = ({
  selectedIds,
  onToggle,
}) => {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const open = Boolean(anchorEl);

  const displayText =
    NEWZNAB_CATEGORY_OPTIONS.filter((opt) => selectedIds.includes(opt.id))
      .map((opt) => opt.label)
      .join(', ') || 'None selected';

  return (
    <>
      <button
        type="button"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        className="flex items-center justify-between gap-2 w-full rounded-[var(--radius-input)] border border-[var(--input-border)] hover:border-[var(--input-border-hover)] bg-input text-foreground font-sans text-left text-base px-3.5 py-2.5 min-h-[48px] transition-colors focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
      >
        <span className="truncate min-w-0">{displayText}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
      </button>
      <Menu open={open} anchorEl={anchorEl} onClose={() => setAnchorEl(null)}>
        {NEWZNAB_CATEGORY_OPTIONS.map((opt) => {
          const checked = selectedIds.includes(opt.id);
          return (
            <MenuItem key={opt.id} onClick={() => onToggle(opt.id, !checked)}>
              <Checkbox size="small" checked={checked} onChange={() => {}} />
              <ListItemText primary={opt.label} />
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
};

export const NzbSettingsSection: React.FC<Props> = ({
  config,
  token,
  onConfigChange,
  onMobileTooltipClick,
}) => {
  const nzb = config.nzb || {
    enabled: false,
    apiKey: '',
    remoteBasePath: null,
    searchCacheMinutes: 10,
    categories: [],
  };

  const [regenerating, setRegenerating] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setNzb = (patch: Partial<typeof nzb>) => {
    onConfigChange({ nzb: { ...nzb, ...patch } });
  };

  const updateCategory = (index: number, patch: Partial<NzbCategory>) => {
    const next = nzb.categories.slice();
    next[index] = { ...next[index], ...patch };
    setNzb({ categories: next });
  };

  const toggleCategoryNewznabId = (index: number, id: string, checked: boolean) => {
    const current = nzb.categories[index].newznabCategoryIds || [];
    const next = checked
      ? [...current, id]
      : current.filter((existing) => existing !== id);
    updateCategory(index, { newznabCategoryIds: next });
  };

  const removeCategory = (index: number) => {
    setNzb({ categories: nzb.categories.filter((_, i) => i !== index) });
  };

  const addCategory = () => {
    setNzb({ categories: [...nzb.categories, blankCategory()] });
  };

  const handleRegenerateKey = async () => {
    setRegenerating(true);
    setError(null);
    try {
      const response = await axios.post<{ apiKey: string }>(
        '/api/nzb/regenerate-key',
        {},
        { headers: { 'x-access-token': token || '' } }
      );
      setNzb({ apiKey: response.data.apiKey });
      setShowApiKey(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate key');
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <ConfigurationCard title="Sonarr / Radarr / Prowlarr (NZB)">
      <Grid container spacing={2} className="mt-2">
        <Grid item xs={12}>
          <Alert severity="info" className="mb-2">
            <Typography variant="body2">
              Makes Youtarr act as a Newznab search indexer and SABnzbd-compatible
              download client, so Sonarr, Radarr, or Prowlarr can search YouTube and
              trigger real Youtarr downloads. See docs/NZB.md for setup steps and the
              shared-volume requirement (Sonarr/Radarr need to read the same output
              folder Youtarr writes to).
            </Typography>
          </Alert>
        </Grid>

        <Grid item xs={12} md={6}>
          <FormControlLabel
            control={
              <Switch
                checked={nzb.enabled === true}
                onChange={(e) => setNzb({ enabled: e.target.checked })}
              />
            }
            label="Enable NZB integration"
          />
        </Grid>

        <Grid item xs={12} md={6}>
          <Box className="flex items-center gap-1">
            {/* Masked with CSS rather than type="password" so the browser's
                password manager doesn't treat this as a login credential and
                prompt to save it - same approach as the Jellyfin/Emby API
                key fields. */}
            <TextField
              fullWidth
              type="text"
              autoComplete="off"
              label="NZB API Key"
              value={nzb.apiKey || ''}
              helperText="Used as ?apikey= by Sonarr/Radarr/Prowlarr. Regenerating invalidates the old key immediately."
              style={{ WebkitTextSecurity: showApiKey ? 'none' : 'disc' } as React.CSSProperties}
              InputProps={{
                readOnly: true,
                endAdornment: (
                  <IconButton
                    type="button"
                    aria-label={showApiKey ? 'Hide NZB API key' : 'Show NZB API key'}
                    size="small"
                    onClick={() => setShowApiKey((prev) => !prev)}
                    className="h-5 w-5 text-muted-foreground"
                  >
                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </IconButton>
                ),
              }}
            />
            <Button variant="outlined" onClick={handleRegenerateKey} disabled={regenerating}>
              {regenerating ? 'Generating...' : nzb.apiKey ? 'Regenerate' : 'Generate'}
            </Button>
            <InfoTooltip
              text="Sonarr/Radarr/Prowlarr authenticate with this key via ?apikey= in the indexer/download-client URL."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
          {error && <Alert severity="error" className="mt-2">{error}</Alert>}
        </Grid>

        <Grid item xs={12} md={6}>
          <Box className="flex items-center gap-1">
            <TextField
              fullWidth
              label="Path Sonarr/Radarr sees this folder as"
              value={nzb.remoteBasePath ?? ''}
              onChange={(e) => setNzb({ remoteBasePath: e.target.value === '' ? null : e.target.value })}
              placeholder="Leave blank if both containers see the same path"
              helperText="Only needed if Sonarr/Radarr's container mounts this shared folder at a different path than Youtarr does - e.g. Youtarr sees it as /usr/src/app/data but Sonarr sees the same folder at /data (or at / with no prefix)."
            />
            <InfoTooltip
              text="Swaps Youtarr's own data-root prefix for this value in every path reported to Sonarr/Radarr (history storage/path), so their import can find the file at the location their own container actually sees."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>

        <Grid item xs={12} md={6}>
          <Box className="flex items-center gap-1">
            <TextField
              fullWidth
              type="number"
              label="Search result cache (minutes)"
              value={nzb.searchCacheMinutes ?? 10}
              onChange={(e) => {
                const parsed = Number.parseInt(e.target.value, 10);
                setNzb({ searchCacheMinutes: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 });
              }}
              inputProps={{ min: 0 }}
              helperText="Reuses a search's results for repeat Sonarr/Radarr/Prowlarr queries instead of re-running yt-dlp. Set to 0 to disable caching."
            />
            <InfoTooltip
              text="Sonarr/Radarr re-run the same search on their own schedule, which can otherwise spawn a fresh yt-dlp process (or spend YouTube API quota) for a query Youtarr just answered. Keeping this short (a few minutes) still avoids that without noticeably delaying a genuinely new upload showing up."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>

        <Grid item xs={12} md={6}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={nzb.debugLogging ?? false}
                  onChange={(e) => setNzb({ debugLogging: e.target.checked })}
                />
              }
              label="NZB debug logging"
            />
            <InfoTooltip
              text="Shows this integration's own diagnostic logs (search/caps/addfile/queue/history requests, cache hit/miss, local-filter before/after counts, remapped Sonarr/Radarr paths) at the normal log level, without needing global Log Level set to Debug - which would also show unrelated noise from every other module."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>

        <Grid item xs={12}>
          <Typography variant="subtitle2" className="mt-2 mb-1">
            Categories
          </Typography>
          <Typography variant="body2" color="textSecondary" className="mb-2">
            Each category is what Sonarr/Radarr shows as "Category" when configuring
            the download client, and maps to a subfolder + how that category's grabs
            get saved.
          </Typography>
        </Grid>

        {nzb.categories.map((cat, index) => (
          <Grid item xs={12} key={index}>
            <Paper variant="outlined" className="p-4 pr-12 relative">
              <Tooltip title="Remove category">
                <span>
                  <IconButton
                    aria-label="Remove category"
                    color="error"
                    size="small"
                    onClick={() => removeCategory(index)}
                    className="absolute top-2 right-2"
                  >
                    <Trash2 size={18} />
                  </IconButton>
                </span>
              </Tooltip>
              <Grid container spacing={2} alignItems="flex-start">
                <Grid item xs={12} md={2}>
                  <FormControl fullWidth>
                    <InputLabel>Category name</InputLabel>
                    <TextField
                      fullWidth
                      value={cat.name}
                      onChange={(e) => updateCategory(index, { name: e.target.value })}
                    />
                    <FormHelperText>Download client category</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid item xs={12} md={2}>
                  <FormControl fullWidth>
                    <InputLabel>Subfolder</InputLabel>
                    <TextField
                      fullWidth
                      value={cat.subfolder || ''}
                      onChange={(e) => updateCategory(index, { subfolder: e.target.value || null })}
                    />
                    <FormHelperText>e.g. Sonarr</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid item xs={12} md={2}>
                  <FormControl fullWidth>
                    <InputLabel>Media mode</InputLabel>
                    <Select
                      fullWidth
                      className={SELECT_TRUNCATE_CLASS}
                      value={cat.mediaMode}
                      onChange={(e: SelectChangeEvent<string>) =>
                        updateCategory(index, { mediaMode: e.target.value as NzbCategory['mediaMode'] })
                      }
                    >
                      <MenuItem value="download">Download</MenuItem>
                      <MenuItem value="strm">STRM only</MenuItem>
                      <MenuItem value="both">Both</MenuItem>
                    </Select>
                    <FormHelperText>How grabs are saved</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid item xs={12} md={3}>
                  <FormControl fullWidth>
                    <InputLabel>Search mode</InputLabel>
                    <Select
                      fullWidth
                      className={SELECT_TRUNCATE_CLASS}
                      value={cat.searchMode}
                      onChange={(e: SelectChangeEvent<string>) =>
                        updateCategory(index, { searchMode: e.target.value as NzbCategory['searchMode'] })
                      }
                    >
                      <MenuItem value="flat">Flat (text search)</MenuItem>
                      <MenuItem value="episode">Season/episode (best-effort)</MenuItem>
                    </Select>
                    <FormHelperText>How queries are interpreted</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid item xs={12} md={3}>
                  <FormControl fullWidth>
                    <InputLabel>Import strategy</InputLabel>
                    <Select
                      fullWidth
                      className={SELECT_TRUNCATE_CLASS}
                      value={cat.importStrategy}
                      onChange={(e: SelectChangeEvent<string>) =>
                        updateCategory(index, { importStrategy: e.target.value as NzbCategory['importStrategy'] })
                      }
                    >
                      <MenuItem value="hardlink">Keep in Youtarr library (hardlink)</MenuItem>
                      <MenuItem value="untracked">Hand off to Sonarr/Radarr (untracked)</MenuItem>
                    </Select>
                    <FormHelperText>What happens after a grab completes</FormHelperText>
                  </FormControl>
                </Grid>
                <Grid item xs={12}>
                  <Box className="flex items-center gap-1">
                    <Typography variant="body2" color="textSecondary">
                      Newznab categories (matches a search naming any of these)
                    </Typography>
                    <InfoTooltip
                      text="Sonarr/Radarr often send more than one category id together (e.g. a specific quality tier plus its general parent). Check every id this category should respond to - a search naming any one of them will match. Leave at least one checked, or Sonarr/Radarr requests for this category will silently fall through to whichever category is listed first."
                      onMobileClick={onMobileTooltipClick}
                    />
                  </Box>
                  <NewznabCategoryMultiSelect
                    selectedIds={cat.newznabCategoryIds}
                    onToggle={(id, checked) => toggleCategoryNewznabId(index, id, checked)}
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <Box className="flex items-center">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={cat.additionalLocalFilter === true}
                          onChange={(e) =>
                            updateCategory(index, { additionalLocalFilter: e.target.checked })
                          }
                        />
                      }
                      label="Additional local filter"
                    />
                    <InfoTooltip
                      text="Requires the YouTube title to actually contain the search terms (and, once Sonarr/Radarr supply a season/episode, an SxxExx-style code) before a result is returned - filters out loosely-related results YouTube search often returns."
                      onMobileClick={onMobileTooltipClick}
                    />
                  </Box>
                </Grid>
                <Grid item xs={12} md={6}>
                  <Box className="flex items-center">
                    <FormControlLabel
                      control={
                        <Switch
                          checked={cat.postEncode === true}
                          onChange={(e) =>
                            updateCategory(index, { postEncode: e.target.checked })
                          }
                        />
                      }
                      label="Transcode before reporting complete"
                    />
                    <InfoTooltip
                      text="Only takes effect when Transcode downloaded video (Settings -> yt-dlp Options, downloadTranscodeVideoCodec) is also set to something other than Off - this switch narrows that global setting to this category, it can't turn transcoding on by itself. When both are on, a grab in this category is re-encoded to the configured codec before Sonarr/Radarr are told the download is complete - useful if you want it for, say, Movies but not TV Series."
                      onMobileClick={onMobileTooltipClick}
                    />
                  </Box>
                </Grid>
              </Grid>
            </Paper>
          </Grid>
        ))}

        <Grid item xs={12}>
          <Button variant="outlined" onClick={addCategory}>Add Category</Button>
        </Grid>
      </Grid>
    </ConfigurationCard>
  );
};
