import React from 'react';
import { Alert, Button, CircularProgress, Typography } from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { useResolutionTagBackfillStatus } from '../../hooks/useResolutionTagBackfillStatus';
import { formatDateTime } from '../../utils/formatters';

interface ResolutionTagBackfillSectionProps {
  token: string | null;
}

export function ResolutionTagBackfillSection({ token }: ResolutionTagBackfillSectionProps) {
  const { running, lastRun, loading, error, triggerBackfill } = useResolutionTagBackfillStatus(token);
  const persistentError = !running && lastRun?.status === 'error' ? lastRun.errorMessage : null;
  const transientError = error && error !== persistentError ? error : null;

  let statusLine: React.ReactNode;
  if (running) {
    statusLine = (
      <div className="flex items-center gap-2">
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          Backfill in progress...
        </Typography>
      </div>
    );
  } else if (lastRun) {
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Last run: {formatDateTime(lastRun.completedAt)}. Tagged {lastRun.tagged} of {lastRun.scanned} videos
        {lastRun.skippedNoCache > 0 && ` (${lastRun.skippedNoCache} skipped - no cached metadata)`}.
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
    <ConfigurationCard title="Backfill resolution tags">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          Adds an &quot;Available: ...&quot; tag (shown as a chip in Jellyfin) listing which
          resolutions were available on YouTube, to videos downloaded before this feature
          existed. Only patches videos with cached metadata already on disk - it does not
          fetch anything fresh from YouTube, so some older or STRM-only videos may be skipped
          until something else (e.g. opening the video&apos;s detail page) caches their metadata.
        </Typography>

        <div>
          <Button
            variant="contained"
            disabled={running || loading}
            onClick={() => {
              void triggerBackfill();
            }}
          >
            Backfill resolution tags
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

export default ResolutionTagBackfillSection;
