import React from 'react';
import { Alert, Button, CircularProgress, FormControlLabel, Switch, Typography } from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { InfoTooltip } from '../Configuration/common/InfoTooltip';
import { ConfigState } from '../Configuration/types';
import { useMetadataRegenStatus } from '../../hooks/useMetadataRegenStatus';
import { formatDateTime } from '../../utils/formatters';

interface MetadataRegenSectionProps {
  token: string | null;
  config: ConfigState;
  onConfigChange: (updates: Partial<ConfigState>) => void;
}

export function MetadataRegenSection({ token, config, onConfigChange }: MetadataRegenSectionProps) {
  const { running, lastRun, loading, error, triggerRegen } = useMetadataRegenStatus(token);
  const persistentError = !running && lastRun?.status === 'error' ? lastRun.errorMessage : null;
  const transientError = error && error !== persistentError ? error : null;

  // Same config.strm shape/default StrmSettingsSection.tsx uses - this is a
  // shortcut to that same setting (regeneration silently produces zero
  // .strmtool.json sidecars when it's off, with no other indication why),
  // not a separate copy of it. Goes through the shared config/onConfigChange
  // + page-level SaveBar flow every other Settings toggle uses, rather than
  // an isolated save - a prior isolated GET/POST implementation here didn't
  // actually persist (likely from round-tripping isPlatformManaged/
  // deploymentEnvironment fields that useConfig.ts normally strips before
  // treating a /getconfig response as real config).
  const writeMediaInfoCache = config.strm?.writeMediaInfoCache !== false;

  let statusLine: React.ReactNode;
  if (running) {
    statusLine = (
      <div className="flex items-center gap-2">
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          Regeneration in progress...
        </Typography>
      </div>
    );
  } else if (lastRun) {
    // skippedNoCache counts every video the NFO couldn't be rebuilt for,
    // but a subset of those (strmToolAlreadyCorrect) still had their
    // .strmtool.json container checked and confirmed correct via the
    // no-cached-metadata fallback - genuinely untouched videos are the
    // remainder, not the full skippedNoCache count (see
    // useMetadataRegenStatus.ts's strmToolAlreadyCorrect doc comment).
    const uncheckedSkipped = lastRun.skippedNoCache - lastRun.strmToolAlreadyCorrect;
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Last run: {formatDateTime(lastRun.completedAt)}. Regenerated {lastRun.regenerated} of{' '}
        {lastRun.scanned} video(s)
        {lastRun.strmToolRegenerated > 0 && `, ${lastRun.strmToolRegenerated} .strmtool.json sidecar(s) rewritten`}
        {lastRun.strmToolAlreadyCorrect > 0 && `, ${lastRun.strmToolAlreadyCorrect} already had the correct container`}
        {uncheckedSkipped > 0 && `, ${uncheckedSkipped} skipped (no cached metadata, nothing to check)`}
        {lastRun.errors > 0 && ` (${lastRun.errors} error(s))`}.
        {lastRun.status === 'timed-out' && ' (timed out; click to continue)'}
      </Typography>
    );
  } else {
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Has not run yet.
      </Typography>
    );
  }

  return (
    <ConfigurationCard title="Regenerate video metadata">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          Fully rewrites the .nfo file for every already-downloaded/STRM&apos;d video from its
          cached metadata - use this after an NFO field or format change so existing videos pick
          up the new content, rather than only ever getting it on their next download. Any
          manual rating override or TV Series library mode season/episode already stored for a
          video is preserved. For STRM videos, also regenerates the .strmtool.json sidecar (used
          by the StrmTool Jellyfin plugin) from the same cached metadata - useful after a change
          to Streaming settings that affects how a .strm plays (e.g. switching Playback mode)
          without needing to re-materialize every .strm file. Only touches videos with cached
          metadata already on disk - it does not fetch anything fresh from YouTube, so some older
          or STRM-only videos may be skipped until something else (e.g. opening the video&apos;s
          detail page) caches their metadata.
        </Typography>

        <div className="flex flex-wrap items-center gap-4">
          <Button
            variant="contained"
            disabled={running || loading}
            onClick={() => {
              void triggerRegen();
            }}
          >
            Regenerate video metadata
          </Button>

          <div className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={writeMediaInfoCache}
                  onChange={(e) => onConfigChange({ strm: { ...config.strm, writeMediaInfoCache: e.target.checked } })}
                />
              }
              label="Write Jellyfin StrmTool cache"
            />
            <InfoTooltip text="Controls whether STRM videos get a .strmtool.json sidecar at all, including from the button above - if this is off, regenerating never produces any .strmtool.json sidecars, with no other indication why. Same setting as Streaming settings' 'Write Jellyfin StrmTool cache' - remember to save." />
          </div>
        </div>

        {statusLine}

        {transientError && (
          <Alert severity="warning">{transientError}</Alert>
        )}

        {persistentError && (
          <Alert severity="warning">{persistentError}</Alert>
        )}
      </div>
    </ConfigurationCard>
  );
}

export default MetadataRegenSection;
