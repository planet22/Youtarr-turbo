import React from 'react';
import { Alert, Box, Button, Chip, Typography } from '../../../ui';
import { InfoTooltip } from '../../common/InfoTooltip';
import { SegmentTimingTestResult } from '../../hooks/useSegmentTimingTest';

const HARDWARE_MODE_LABELS: Record<string, string> = {
  none: 'Software',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVENC',
  vaapi: 'VAAPI',
  amf: 'AMD AMF',
};

interface SegmentTimingTestButtonProps {
  hardwareMode: string;
  /** Persisted config.ytstream.forceKeyframesByHardwareMode[hardwareMode] - shown before any test has run this session too. */
  currentlyEnabled: boolean;
  testing: boolean;
  result: SegmentTimingTestResult | null;
  error: string | null;
  onRunTest: () => void;
  onMobileTooltipClick?: (text: string) => void;
}

/**
 * "Test HLS segment timing" - a correctness check, separate from "Test
 * real-time tuning" above (a speed check). Runs a real short HLS encode of
 * a deliberately non-30fps synthetic source through the candidate
 * time-based forced-keyframe args (server/modules/streamTuningBenchmark.js's
 * testSegmentTiming) for the currently-selected Hardware encoder, and
 * reports whether real segments landed at ~4.000s on this host - some
 * hardware encoders are known to sometimes ignore or mishandle a
 * forced-keyframe expression. The test result itself IS the setting: the
 * server persists it into config.ytstream.forceKeyframesByHardwareMode -
 * there's no separate manual switch to also flip.
 */
export const SegmentTimingTestButton: React.FC<SegmentTimingTestButtonProps> = ({
  hardwareMode,
  currentlyEnabled,
  testing,
  result,
  error,
  onRunTest,
  onMobileTooltipClick,
}) => {
  const hwLabel = HARDWARE_MODE_LABELS[hardwareMode] || hardwareMode;
  // Prefer this run's own result once available (may differ from
  // currentlyEnabled if this is the very first test for this mode, or it
  // just changed the outcome), falling back to the persisted config value
  // otherwise.
  const enabled = result && result.hardwareMode === hardwareMode ? result.enabled : currentlyEnabled;

  return (
    <Box>
      <Box className='flex items-center gap-2 flex-wrap' style={{ marginBottom: 8 }}>
        <Button variant='outlined' onClick={onRunTest} disabled={testing}>
          {testing ? 'Testing segment timing...' : 'Test HLS Segment Timing'}
        </Button>
        <Chip
          label={`Time-based keyframes: ${enabled ? 'ON' : 'OFF'} for ${hwLabel}`}
          color={enabled ? 'success' : 'default'}
          size='small'
          variant={enabled ? 'filled' : 'outlined'}
        />
        <InfoTooltip
          text={`Runs a real short HLS encode of a deliberately non-30fps synthetic source through ${hwLabel}, using time-based forced keyframes instead of the default fixed-frame-count GOP, and measures whether the real produced segments land at ~4.000s. If they do, Youtarr switches ${hwLabel} to this more accurate method for every future stream automatically; if not (some hardware encoders mishandle it), ${hwLabel} keeps using the original method. Re-running the test can flip the result either way later (e.g. after a driver update).`}
          onMobileClick={onMobileTooltipClick}
        />
      </Box>

      {error && (
        <Alert severity='error' style={{ marginBottom: 8 }}>{error}</Alert>
      )}

      {result && result.hardwareMode === hardwareMode && !error && (
        <Alert severity={result.enabled ? 'success' : 'warning'} style={{ marginBottom: 8 }}>
          {result.enabled
            ? `Verified - segments averaged ${result.averageSeconds?.toFixed(3)}s (max deviation ${result.maxDeviationSeconds?.toFixed(3)}s from the 4s target). ${hwLabel} will now use time-based forced keyframes for every stream.`
            : result.error
              ? `Not verified - ${result.error}. ${hwLabel} will keep using the original fixed-frame-count GOP.`
              : `Not verified - segments averaged ${result.averageSeconds?.toFixed(3)}s (max deviation ${result.maxDeviationSeconds?.toFixed(3)}s from the 4s target, too far off). ${hwLabel} will keep using the original fixed-frame-count GOP.`}
        </Alert>
      )}

      <Typography variant='caption' color='textSecondary' className='block mb-1'>
        A one-time check per hardware encoder - safe to re-run any time (e.g. after a driver/ffmpeg update).
      </Typography>
    </Box>
  );
};
