import React, { useRef, useState } from 'react';
import axios from 'axios';
import { Eye, EyeOff, Trash2, ChevronDown, Upload, AlertTriangle } from 'lucide-react';
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '../../ui';
import { ConfigurationCard } from '../common/ConfigurationCard';
import { InfoTooltip } from '../common/InfoTooltip';
import { ConfigState } from '../types';
import { useCacheReset } from '../hooks/useCacheReset';

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
  excludeTerms: [],
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
  const [importErrors, setImportErrors] = useState<Record<number, string | null>>({});
  const importFileInputRefs = useRef<Record<number, HTMLInputElement | null>>({});
  const [confirmClearDiagnosticLogs, setConfirmClearDiagnosticLogs] = useState(false);
  const [confirmClearVideoCache, setConfirmClearVideoCache] = useState(false);
  const diagnosticLogsCache = useCacheReset(token, '/api/nzb/diagnostic-logs');
  const videoResolutionCache = useCacheReset(token, '/api/nzb/resolution-cache');

  const setNzb = (patch: Partial<typeof nzb>) => {
    onConfigChange({ nzb: { ...nzb, ...patch } });
  };

  const resolutionDetection = nzb.resolutionDetection ?? { fixed: true, thumb: true, extract: true };
  const setResolutionDetection = (patch: Partial<typeof resolutionDetection>) => {
    setNzb({ resolutionDetection: { ...resolutionDetection, ...patch } });
  };
  const allResolutionChecksOff =
    !resolutionDetection.fixed && !resolutionDetection.thumb && !resolutionDetection.extract;

  const diagnosticLogLimits = nzb.diagnosticLogLimits ?? {
    recentQueries: 50,
    searchTraces: 20,
    failedGrabs: 20,
  };
  const setDiagnosticLogLimit = (key: keyof typeof diagnosticLogLimits, value: string) => {
    const parsed = Number.parseInt(value, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 1;
    setNzb({ diagnosticLogLimits: { ...diagnosticLogLimits, [key]: clamped } });
  };

  const videoResolutionCacheLimit = nzb.videoResolutionCacheLimit ?? 5000;
  const setVideoResolutionCacheLimit = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    const clamped = Number.isFinite(parsed) ? Math.min(10000, Math.max(100, parsed)) : 100;
    setNzb({ videoResolutionCacheLimit: clamped });
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

  const MAX_EXCLUDE_TERMS_FILE_SIZE = 256 * 1024; // generous for a word list; guards against picking the wrong file

  // Cheap plain-text sniff: real word lists never contain a NUL byte (a
  // reliable binary marker), and shouldn't be dense with other control
  // characters either. Not a full text/binary classifier - just enough to
  // reject "oops, wrong file" (an image, an .nzb, a spreadsheet) before it
  // gets split into garbage "terms".
  const looksLikePlainText = (content: string): boolean => {
    if (content.includes('\u0000')) return false;
    const sample = content.slice(0, 8000);
    if (sample.length === 0) return true;
    let controlCount = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) controlCount += 1;
    }
    return controlCount / sample.length < 0.01;
  };

  const handleImportClick = (index: number) => {
    setImportErrors((prev) => ({ ...prev, [index]: null }));
    importFileInputRefs.current[index]?.click();
  };

  const handleImportFile = (index: number, file: File | undefined) => {
    if (!file) return;
    const setFileError = (message: string | null) =>
      setImportErrors((prev) => ({ ...prev, [index]: message }));
    setFileError(null);

    if (!file.name.toLowerCase().endsWith('.txt')) {
      setFileError('Only .txt files can be imported.');
      return;
    }
    if (file.size > MAX_EXCLUDE_TERMS_FILE_SIZE) {
      setFileError('File is too large (max 256KB) - this should just be a list of words/phrases, one per line.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      if (!looksLikePlainText(content)) {
        setFileError("That doesn't look like a plain text file - import a .txt file with one word or phrase per line.");
        return;
      }
      const terms = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (terms.length === 0) {
        setFileError('That file has no terms in it.');
        return;
      }
      updateCategory(index, { excludeTerms: terms });
    };
    reader.onerror = () => setFileError('Failed to read the file.');
    reader.readAsText(file);
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
    <ConfigurationCard
      title="Sonarr / Radarr / Prowlarr (NZB)"
      headerAction={
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
            text="Shows this integration's diagnostic logs (search/caps/addfile/queue/history requests, cache hit/miss, local-filter before/after counts, remapped Sonarr/Radarr paths) at the normal log level, without needing global Log Level set to Debug."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      }
    >
      <Grid container spacing={2} className="mt-2">
        <Grid item xs={12}>
          <Alert severity="info" className="mb-2">
            <Typography variant="body2">
              Makes Youtarr-Turbo act as a Newznab search indexer and SABnzbd-compatible
              download client for Sonarr, Radarr, or Prowlarr to search YouTube and
              trigger Youtarr-Turbo downloads. See docs/NZB.md for setup steps. Requires
              Sonarr/Radarr to read the same output folder Youtarr-Turbo writes to.
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
              helperText="Needed only if Sonarr/Radarr's container mounts this shared folder at a different path than Youtarr-Turbo does, e.g. Youtarr-Turbo sees /usr/src/app/data but Sonarr sees the same folder at /data (or / with no prefix)."
            />
            <InfoTooltip
              text="Replaces Youtarr-Turbo's data-root prefix with this value in every path reported to Sonarr/Radarr (history storage/path), matching the location their container sees."
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
              helperText="Reuses search results for repeat Sonarr/Radarr/Prowlarr queries instead of re-running yt-dlp. 0 disables caching."
            />
            <InfoTooltip
              text="Avoids spawning a fresh yt-dlp process (or spending YouTube API quota) when Sonarr/Radarr re-run the same search on schedule. A few minutes is enough to avoid repeat searches without noticeably delaying new uploads."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>

        <Grid item xs={12}>
          <Typography variant="subtitle2" className="mt-2 mb-1">
            Video Actual Resolution
          </Typography>
          <Typography variant="body2" color="textSecondary" className="mb-2">
            Every search result's title/size is labeled at the download quality configured in
            yt-dlp Options - Sonarr/Radarr read that label as the actual quality on offer. These
            checks try to catch a video that can't really deliver that quality (e.g. an old,
            low-resolution upload) and label it lower instead. Tried in this order, each a
            fallback for the one before it - if Fixed and Thumbnail check are both off, Real
            extraction (when on) is used directly for every result instead of only as a
            fallback.
          </Typography>
          <Box className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <Box className="flex items-center">
              <FormControlLabel
                control={
                  <Switch
                    checked={resolutionDetection.fixed}
                    onChange={(e) => setResolutionDetection({ fixed: e.target.checked })}
                  />
                }
                label="Fixed (previously downloaded)"
              />
              <InfoTooltip
                text="Free and exact: if Youtarr-Turbo has already downloaded this video, uses its real measured resolution instead of guessing. Only applies to a video Youtarr-Turbo already has - never-downloaded results fall through to the checks below."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
            <Box className="flex items-center">
              <FormControlLabel
                control={
                  <Switch
                    checked={resolutionDetection.thumb}
                    onChange={(e) => setResolutionDetection({ thumb: e.target.checked })}
                  />
                }
                label="Thumbnail check"
              />
              <InfoTooltip
                text="Cheap heuristic used only when the video's resolution isn't already free/known (yt-dlp fallback searches - the YouTube Data API, when in use, already answers this for free): checks whether YouTube's largest thumbnail is a real image or a placeholder. Fast, but can occasionally mislabel an old, low-resolution video as HD, since YouTube sometimes regenerates a video's thumbnail at a higher quality than the video itself."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
            <Box className="flex items-center">
              <FormControlLabel
                control={
                  <Switch
                    checked={resolutionDetection.extract}
                    onChange={(e) => setResolutionDetection({ extract: e.target.checked })}
                  />
                }
                label="Real extraction (accurate, slower)"
              />
              <InfoTooltip
                text="Authoritative but slow: runs a real yt-dlp lookup of the video's actual formats. Used to confirm or correct an uncertain/'HD' thumbnail check result - or, if Fixed and Thumbnail check are both off, used directly for every result. Adds real time to each search response and, at heavy search volume, some risk of YouTube rate-limiting - leave this off if that's a concern for your setup."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </Box>
          {allResolutionChecksOff && (
            <Alert severity="warning" className="mt-2">
              All resolution checks are off - every search result will be labeled at the
              configured download quality above, even when the source video is actually much
              lower resolution.
            </Alert>
          )}
        </Grid>

        <Grid item xs={12} className="my-2">
          <Typography variant="subtitle2" className="mt-2 mb-1">
            Diagnostic Log Limits
          </Typography>
          <Typography variant="body2" color="textSecondary" className="mb-3">
            How many rows the NZB diagnostics page keeps for each log before pruning the oldest.
            1-100 each.
          </Typography>
          <Box className="flex flex-wrap items-center gap-6">
            <TextField
              type="number"
              label="Recent queries"
              value={diagnosticLogLimits.recentQueries}
              onChange={(e) => setDiagnosticLogLimit('recentQueries', e.target.value)}
              inputProps={{ min: 1, max: 100 }}
              helperText="Sonarr/Radarr/Prowlarr searches"
              style={{ width: 200 }}
            />
            <TextField
              type="number"
              label="Search debug traces"
              value={diagnosticLogLimits.searchTraces}
              onChange={(e) => setDiagnosticLogLimit('searchTraces', e.target.value)}
              inputProps={{ min: 1, max: 100 }}
              helperText="Per-search candidate detail"
              style={{ width: 200 }}
            />
            <TextField
              type="number"
              label="Failed grabs"
              value={diagnosticLogLimits.failedGrabs}
              onChange={(e) => setDiagnosticLogLimit('failedGrabs', e.target.value)}
              inputProps={{ min: 1, max: 100 }}
              helperText="Grabs that completed with nothing to show"
              style={{ width: 200 }}
            />
            <Box className="flex items-center gap-2 pl-4 border-l border-[var(--border)]">
              <Typography variant="body2">
                Stored rows: {diagnosticLogsCache.count === null ? '…' : diagnosticLogsCache.count}
              </Typography>
              <Button
                variant="outlined"
                color="error"
                size="small"
                startIcon={<Trash2 size={14} />}
                disabled={!diagnosticLogsCache.count || diagnosticLogsCache.clearing}
                onClick={() => setConfirmClearDiagnosticLogs(true)}
              >
                Clear
              </Button>
            </Box>
          </Box>
          {diagnosticLogsCache.error && (
            <Typography variant="caption" color="error">{diagnosticLogsCache.error}</Typography>
          )}
        </Grid>

        <Grid item xs={12} className="my-2">
          <Typography variant="subtitle2" className="mt-2 mb-1">
            NZB Video Cache
          </Typography>
          <Typography variant="body2" color="textSecondary" className="mb-3">
            How many videos' detected resolutions (see Video Actual Resolution above) are kept
            before the oldest are pruned. 100-10,000.
          </Typography>
          <Box className="flex flex-wrap items-center gap-6">
            <TextField
              type="number"
              label="Max cached videos"
              value={videoResolutionCacheLimit}
              onChange={(e) => setVideoResolutionCacheLimit(e.target.value)}
              inputProps={{ min: 100, max: 10000 }}
              helperText="One row per YouTube video ID"
              style={{ width: 200 }}
            />
            <Box className="flex items-center gap-2 pl-4 border-l border-[var(--border)]">
              <Typography variant="body2">
                Cached videos: {videoResolutionCache.count === null ? '…' : videoResolutionCache.count}
              </Typography>
              <Button
                variant="outlined"
                color="error"
                size="small"
                startIcon={<Trash2 size={14} />}
                disabled={!videoResolutionCache.count || videoResolutionCache.clearing}
                onClick={() => setConfirmClearVideoCache(true)}
              >
                Clear
              </Button>
            </Box>
          </Box>
          {videoResolutionCache.error && (
            <Typography variant="caption" color="error">{videoResolutionCache.error}</Typography>
          )}
        </Grid>

        <Grid item xs={12}>
          <Typography variant="subtitle2" className="mt-2 mb-1">
            Categories
          </Typography>
          <Typography variant="body2" color="textSecondary" className="mb-2">
            Each category is what Sonarr/Radarr shows as "Category" when configuring
            the download client. Maps to a subfolder and controls how that category's
            grabs are saved.
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
                      <MenuItem value="hardlink">Keep in Youtarr-Turbo library (hardlink)</MenuItem>
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
                      text="Sonarr/Radarr often send more than one category id together (e.g. a specific quality tier plus its general parent). Check every id this category should respond to; a search naming any one of them matches. At least one must stay checked, or requests for this category fall through to whichever category is listed first."
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
                      text="Requires the YouTube title to contain the search terms (and, once Sonarr/Radarr supply a season/episode, an SxxExx-style code) before returning a result. Filters out loosely-related results YouTube search often returns."
                      onMobileClick={onMobileTooltipClick}
                    />
                  </Box>
                </Grid>
                <Grid item xs={12} className="my-2">
                  <Box className="flex items-start gap-3">
                    <TextField
                      fullWidth
                      multiline
                      minRows={2}
                      label="Exclude if title contains"
                      value={(cat.excludeTerms || []).join('\n')}
                      onChange={(e) =>
                        updateCategory(index, {
                          excludeTerms: e.target.value
                            .split('\n')
                            .map((line) => line.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder={'advert\ntrailer\nouttakes\nbehind the scenes'}
                      helperText="One word or phrase per line, case-insensitive. A result is dropped if its title contains any of these. Applies only when Additional local filter is on."
                    />
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={() => handleImportClick(index)}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      <Upload size={16} style={{ marginRight: 6 }} />
                      Import .txt
                    </Button>
                    <input
                      ref={(el) => { importFileInputRefs.current[index] = el; }}
                      type="file"
                      accept=".txt,text/plain"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        handleImportFile(index, e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                    <InfoTooltip
                      text="Catches matches the search itself can't: DVD-extra clips, promos, and behind-the-scenes uploads often contain every search keyword without being the actual episode/movie. Add terms that show up in this channel's junk titles. Import replaces the current list with the file's contents, one term per line."
                      onMobileClick={onMobileTooltipClick}
                    />
                  </Box>
                  {importErrors[index] && (
                    <Alert severity="error" className="mt-2">{importErrors[index]}</Alert>
                  )}
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
                      text="Takes effect only when Transcode downloaded video (Settings -> yt-dlp Options, downloadTranscodeVideoCodec) is also set to something other than Off; this switch narrows that global setting to this category and can't turn transcoding on by itself. When both are on, a grab in this category is re-encoded to the configured codec before Sonarr/Radarr are told the download is complete."
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

      <Dialog open={confirmClearDiagnosticLogs} onClose={() => setConfirmClearDiagnosticLogs(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <AlertTriangle size={20} color="var(--warning)" className="shrink-0" />
          Clear Diagnostic Logs
        </DialogTitle>
        <DialogContent>
          <div className="space-y-4">
            <Alert severity="warning">
              <Typography variant="body2">
                This permanently deletes {diagnosticLogsCache.count ?? 0} stored row{diagnosticLogsCache.count === 1 ? '' : 's'} across Recent Queries, Search Detail/Debug, and Failed Grabs on the NZB diagnostics page.
              </Typography>
            </Alert>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone. New entries start accumulating again immediately as Sonarr/Radarr/Prowlarr keep searching.
            </Typography>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClearDiagnosticLogs(false)} variant="contained" color="primary" autoFocus>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setConfirmClearDiagnosticLogs(false);
              diagnosticLogsCache.clear();
            }}
            variant="outlined"
            color="error"
            startIcon={<Trash2 size={16} />}
          >
            Clear
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmClearVideoCache} onClose={() => setConfirmClearVideoCache(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <AlertTriangle size={20} color="var(--warning)" className="shrink-0" />
          Clear NZB Video Cache
        </DialogTitle>
        <DialogContent>
          <div className="space-y-4">
            <Alert severity="warning">
              <Typography variant="body2">
                This permanently deletes {videoResolutionCache.count ?? 0} cached video resolution{videoResolutionCache.count === 1 ? '' : 's'}. Every affected video re-runs the thumbnail/extraction checks above (see Video Actual Resolution) the next time it appears in a search.
              </Typography>
            </Alert>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClearVideoCache(false)} variant="contained" color="primary" autoFocus>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setConfirmClearVideoCache(false);
              videoResolutionCache.clear();
            }}
            variant="outlined"
            color="error"
            startIcon={<Trash2 size={16} />}
          >
            Clear
          </Button>
        </DialogActions>
      </Dialog>
    </ConfigurationCard>
  );
};
