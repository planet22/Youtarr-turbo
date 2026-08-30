import React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '../../../ui';
import { InfoTooltip } from '../../common/InfoTooltip';
import { TuningBenchmarkMatrix, TuningBenchmarkProgress, TuningRecommendationMap } from '../../hooks/useTuningBenchmark';

const TUNING_TIERS: Array<{ id: string; label: string }> = [
  { id: 'fast', label: 'Fast' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'quality', label: 'Quality' },
];

const RESOLUTIONS = [480, 720, 1080, 1440, 2160];

const HARDWARE_MODE_LABELS: Record<string, string> = {
  none: 'Software',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVENC',
  vaapi: 'VAAPI',
  amf: 'AMD AMF',
};

interface TuningBenchmarkTableProps {
  hardwareMode: string;
  matrix: TuningBenchmarkMatrix | null;
  recommended: TuningRecommendationMap | null;
  resultHardwareMode: string | null;
  progress: TuningBenchmarkProgress | null;
  testing: boolean;
  error: string | null;
  onRunTest: () => void;
  /** Non-null when the test isn't applicable to the current settings (e.g. Playback mode isn't Enhanced, or Transcode isn't H.264) - disables the button and explains why instead of letting it run pointlessly. */
  disabledReason?: string | null;
  onMobileTooltipClick?: (text: string) => void;
}

/**
 * "Test real-time tuning" button + per-resolution results table for the
 * currently selected Hardware encoder — see
 * server/modules/streamTuningBenchmark.js. The benchmark itself is scoped
 * server-side to just this one encoder (not every possible one), so this
 * never spends time measuring hardware the host isn't configured to use.
 *
 * Always renders the full resolution x tier grid, even before the first run
 * (every cell falls back to an "Untested" chip) - same convention as
 * HardwareCapabilitiesTable, so the shape of what's about to be measured is
 * visible immediately.
 */
export const TuningBenchmarkTable: React.FC<TuningBenchmarkTableProps> = ({
  hardwareMode,
  matrix,
  recommended,
  resultHardwareMode,
  progress,
  testing,
  error,
  onRunTest,
  disabledReason,
  onMobileTooltipClick,
}) => {
  const hwLabel = HARDWARE_MODE_LABELS[hardwareMode] || hardwareMode;
  // Results on screen were measured for a different encoder than what's
  // currently selected (e.g. the user switched Hardware encoder without
  // re-running the test) - still show them, but make clear they're stale
  // rather than silently implying they apply to the new selection. Never
  // true mid-run: useTuningBenchmark clears matrix/resultHardwareMode the
  // moment a new run starts, so there's nothing stale left to flag.
  const stale = !!matrix && resultHardwareMode !== null && resultHardwareMode !== hardwareMode;

  let progressLabel = 'Test Real-Time Tuning';
  if (testing) {
    progressLabel = progress && progress.total > 0
      ? `Testing ${progress.current?.tuning ?? '...'} @ ${progress.current?.height ?? '?'}p (${progress.completed}/${progress.total})...`
      : 'Starting benchmark...';
  }

  return (
    <Box>
      <Box className='flex items-center gap-1' style={{ marginBottom: 8 }}>
        <Button variant='outlined' onClick={onRunTest} disabled={testing || !!disabledReason}>
          {progressLabel}
        </Button>
        <InfoTooltip
          text={`Runs a real, timed ffmpeg encode (a few seconds of synthetic input, no video file needed) for the currently selected Hardware encoder (${hwLabel}), across all 3 tuning tiers x 5 resolutions, using the exact args live playback uses, and reports whether each ran fast enough — with safety margin — to keep up with real-time HLS/live streaming. Scoped to this one encoder, so it's typically well under a minute.`}
          onMobileClick={onMobileTooltipClick}
        />
      </Box>

      {testing && progress && progress.total > 0 && (
        <LinearProgress
          variant='determinate'
          value={(progress.completed / progress.total) * 100}
          style={{ marginBottom: 8 }}
        />
      )}

      {disabledReason && !testing && (
        <Typography variant='body2' color='textSecondary' style={{ marginBottom: 8 }}>
          {disabledReason}
        </Typography>
      )}

      {error && (
        <Alert severity='error' style={{ marginBottom: 8 }}>{error}</Alert>
      )}

      {stale && (
        <Alert severity='info' style={{ marginBottom: 8 }}>
          These results are from testing {HARDWARE_MODE_LABELS[resultHardwareMode as string] || resultHardwareMode}. Run the test again to benchmark the currently selected {hwLabel}.
        </Alert>
      )}

      <Typography variant='caption' color='textSecondary' className='block mb-1'>
        Testing: {hwLabel}
      </Typography>

      <TableContainer style={{ marginBottom: 8 }}>
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>Resolution</TableCell>
              {TUNING_TIERS.map((tier) => (
                <TableCell key={tier.id} align='center'>{tier.label}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {RESOLUTIONS.map((height) => {
              const row = !stale ? matrix?.[String(height)] : undefined;
              const recommendedTier = !stale ? recommended?.[String(height)] : undefined;
              const isCurrentlyTesting = testing && progress?.current?.height === height;
              return (
                <TableRow key={height}>
                  <TableCell component='th'>{height}p</TableCell>
                  {TUNING_TIERS.map((tier) => {
                    const cell = row?.[tier.id];
                    const isRecommended = recommendedTier === tier.id;
                    const isRunningThisCell = isCurrentlyTesting && progress?.current?.tuning === tier.id;
                    if (isRunningThisCell) {
                      return (
                        <TableCell key={tier.id} align='center'>
                          <Chip label='Testing...' size='small' color='info' variant='outlined' />
                        </TableCell>
                      );
                    }
                    if (!cell) {
                      return (
                        <TableCell key={tier.id} align='center'>
                          <Chip label='Untested' size='small' variant='outlined' />
                        </TableCell>
                      );
                    }
                    if (!cell.ok) {
                      return (
                        <TableCell key={tier.id} align='center'>
                          <Tooltip title={cell.error || 'Failed'}>
                            <Chip label='Failed' color='error' size='small' />
                          </Tooltip>
                        </TableCell>
                      );
                    }
                    const factorLabel = `${cell.realtimeFactor?.toFixed(1)}x`;
                    return (
                      <TableCell key={tier.id} align='center'>
                        <Box className='flex items-center justify-center gap-1'>
                          <Chip
                            label={factorLabel}
                            color={cell.realtime ? 'success' : 'warning'}
                            size='small'
                          />
                          {isRecommended && <Chip label='Recommended' size='small' />}
                        </Box>
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
