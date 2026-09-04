import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Grid, TextField, Typography } from '../../ui';
import { ConfigurationCard } from '../common/ConfigurationCard';
import { ConfigState, YtstreamDryRunResult } from '../types';
import { useYtstreamDryRun } from '../hooks/useYtstreamDryRun';
import { YtstreamDryRunPreview } from './components/YtstreamDryRunPreview';

interface Props {
  config: ConfigState;
  token: string | null;
}

// Accepts a bare 11-char id, or the common YouTube URL shapes.
function extractYoutubeId(input: string): string | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_-]{6,20}$/.test(trimmed)) return trimmed;
  return null;
}

// Never a real YouTube id (real ones are exactly 11 chars) - used only for
// the no-video preview below, always with probe:false, so it's never
// actually looked up.
const NO_VIDEO_PLACEHOLDER_ID = 'no-video-dry-run';

/**
 * Read-only dry-run for the /api/ytstream/:youtubeId playback route (see
 * GET /api/ytstream/:youtubeId/simulate, resolvePlaybackPlan in
 * server/routes/ytstream.js). Lets you check what a real request for a
 * specific video will actually do - which matters most when
 * forceServerSettings is on, since a .strm file's own URL parameters are
 * then silently ignored server-side and Settings is the only source of
 * truth for what will happen.
 */
export const YtstreamDryRunSection: React.FC<Props> = ({ config, token }) => {
  const ytstream = config.ytstream;
  const [videoInput, setVideoInput] = useState('');
  const [state, setState] = useState<{
    loading: boolean;
    result: YtstreamDryRunResult | null;
    error: string | null;
  }>({ loading: false, result: null, error: null });

  const { runDryRun } = useYtstreamDryRun({ token });

  // Clear a stale preview once the settings it described have changed,
  // same reasoning as AutoRemovalSection's equivalent effect.
  useEffect(() => {
    setState({ loading: false, result: null, error: null });
  }, [
    ytstream?.defaultMode,
    ytstream?.quality,
    ytstream?.qualityStrictness,
    ytstream?.container,
    ytstream?.transcode,
    ytstream?.hardwareMode,
    ytstream?.tuning,
    ytstream?.calculatedLength,
    ytstream?.forceServerSettings,
  ]);

  if (config.strm?.target !== 'ytstream') {
    return null;
  }

  const handleRun = async () => {
    const trimmed = videoInput.trim();
    let youtubeId: string | null;
    let probe: boolean;

    if (!trimmed) {
      // No video to check - only meaningful when Force these settings is on
      // above, since that's the one case where a real request's outcome
      // doesn't depend on any per-video/.strm-URL value at all. With it
      // off, a real request's actual mode/quality/etc. can come from that
      // specific .strm's own URL, which this preview has no way to know
      // without one.
      if (!ytstream?.forceServerSettings) {
        setState({
          loading: false,
          result: null,
          error: 'Enter a valid YouTube video id or URL, or turn on "Force these settings" above to preview without one',
        });
        return;
      }
      youtubeId = NO_VIDEO_PLACEHOLDER_ID;
      probe = false; // nothing real to probe
    } else {
      youtubeId = extractYoutubeId(trimmed);
      if (!youtubeId) {
        setState({ loading: false, result: null, error: 'Enter a valid YouTube video id or URL' });
        return;
      }
      probe = true;
    }

    setState({ loading: true, result: null, error: null });
    try {
      const result = await runDryRun(youtubeId, {
        mode: ytstream?.defaultMode || undefined,
        quality: ytstream?.quality || undefined,
        qualityStrictness: ytstream?.qualityStrictness || undefined,
        container: ytstream?.container || undefined,
        transcode: ytstream?.transcode || undefined,
        hardwareMode: ytstream?.hardwareMode || undefined,
        tuning: ytstream?.tuning || undefined,
        calculatedLength: ytstream?.calculatedLength,
      }, { probe });
      setState({ loading: false, result, error: null });
    } catch (err: unknown) {
      setState({
        loading: false,
        result: null,
        error: err instanceof Error ? err.message : 'Failed to run playback simulation',
      });
    }
  };

  return (
    <ConfigurationCard
      title="Streaming Dry Run"
      subtitle="Check what a real playback request for a specific video will actually do, using your current streaming settings - without starting a real stream."
    >
      <Grid container spacing={2} className="mt-1">
        <Grid item xs={12} md={8}>
          <TextField
            fullWidth
            label="YouTube video id or URL"
            value={videoInput}
            onChange={(e) => setVideoInput(e.target.value)}
            placeholder="dQw4w9WgXcQ or https://youtube.com/watch?v=..."
            helperText={
              ytstream?.forceServerSettings
                ? 'Leave blank to preview your forced settings alone - no specific video, no yt-dlp probing.'
                : 'Enter a video id/URL to preview it, or turn on "Force these settings" above to preview without one.'
            }
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-2 h-full">
            <Button
              variant="contained"
              onClick={handleRun}
              disabled={state.loading || (!videoInput.trim() && !ytstream?.forceServerSettings)}
            >
              {state.loading ? 'Running…' : 'Run Dry Run'}
            </Button>
            {state.loading && <CircularProgress size={20} />}
          </Box>
        </Grid>

        {ytstream?.forceServerSettings && (
          <Grid item xs={12}>
            <Typography variant="body2" color="textSecondary">
              "Force these settings" is on above, so this preview reflects your saved Settings — any mode/quality/etc. a real .strm URL carries is ignored server-side, same as it would be for real playback.
            </Typography>
          </Grid>
        )}

        {state.error && (
          <Grid item xs={12}>
            <Alert severity="error">{state.error}</Alert>
          </Grid>
        )}

        {state.result && (
          <Grid item xs={12}>
            <YtstreamDryRunPreview result={state.result} />
          </Grid>
        )}
      </Grid>
    </ConfigurationCard>
  );
};
