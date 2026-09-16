import React from 'react';
import { Alert, Button, CircularProgress, Typography } from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { useMetadataRegenStatus } from '../../hooks/useMetadataRegenStatus';
import { formatDateTime } from '../../utils/formatters';

interface MetadataRegenSectionProps {
  token: string | null;
}

export function MetadataRegenSection({ token }: MetadataRegenSectionProps) {
  const { running, lastRun, loading, error, triggerRegen } = useMetadataRegenStatus(token);
  const persistentError = !running && lastRun?.status === 'error' ? lastRun.errorMessage : null;
  const transientError = error && error !== persistentError ? error : null;

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
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Last run: {formatDateTime(lastRun.completedAt)}. Regenerated {lastRun.regenerated} of{' '}
        {lastRun.scanned} video(s)
        {lastRun.strmToolRegenerated > 0 && `, ${lastRun.strmToolRegenerated} .strmtool.json sidecar(s)`}
        {lastRun.skippedNoCache > 0 && `, ${lastRun.skippedNoCache} skipped (no cached metadata)`}
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

        <div>
          <Button
            variant="contained"
            disabled={running || loading}
            onClick={() => {
              void triggerRegen();
            }}
          >
            Regenerate video metadata
          </Button>
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
