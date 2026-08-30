import React from 'react';
import { Alert, Button, CircularProgress, Typography } from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { useChannelImageRegenStatus } from '../../hooks/useChannelImageRegenStatus';
import { formatDateTime } from '../../utils/formatters';

interface ChannelImageRegenSectionProps {
  token: string | null;
}

export function ChannelImageRegenSection({ token }: ChannelImageRegenSectionProps) {
  const { running, lastRun, loading, error, triggerRegen } = useChannelImageRegenStatus(token);
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
  } else if (lastRun && lastRun.status === 'completed') {
    const videoThumbsFixed = (lastRun.videoThumbsCopied ?? 0) + (lastRun.videoThumbsDownloaded ?? 0);
    const totalErrors = (lastRun.errors ?? 0) + (lastRun.videoThumbsErrors ?? 0);
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Last run: {formatDateTime(lastRun.completedAt)}. Copied {lastRun.copied ?? 0} channel image(s) across{' '}
        {lastRun.channelsScanned ?? 0} channel(s), fixed {videoThumbsFixed} missing video/episode thumbnail(s)
        {totalErrors > 0 && ` (${totalErrors} error(s))`}.
      </Typography>
    );
  } else if (lastRun) {
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Last run failed: {formatDateTime(lastRun.completedAt)}.
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
    <ConfigurationCard title="Regenerate channel images">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          Force re-copies poster.jpg, logo.jpg, backdrop.jpg, and banner.jpg for every enabled
          channel from this app&apos;s own cached channel images, overwriting whatever&apos;s
          already there - including each season folder&apos;s own poster.jpg/logo.jpg for
          channels in TV Series library mode. The normal backfill only fills in{' '}
          <em>missing</em> images, so it can never repair one that already exists but is broken -
          e.g. unreadable by a media server running as a different user, from before file-copy
          permissions were fixed. Use this to repair those in place without deleting anything first.
        </Typography>

        <Typography variant="body2" color="text.secondary">
          Also fills in each video and episode&apos;s own missing thumbnail (what its NFO&apos;s{' '}
          <code>&lt;thumb&gt;</code> tag references) - unlike the images above, this only creates{' '}
          <em>missing</em> thumbnails rather than overwriting existing ones, since a missing
          thumbnail means it was never successfully written in the first place.
        </Typography>

        <div>
          <Button
            variant="contained"
            disabled={running || loading}
            onClick={() => {
              void triggerRegen();
            }}
          >
            Regenerate channel images
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

export default ChannelImageRegenSection;
