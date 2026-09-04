import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  SelectChangeEvent,
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

// Decode's labels differ from encode's - see HardwareCapabilitiesTable.tsx's
// same constants (no 'amf'; NVENC's decode counterpart is NVDEC).
const DECODE_MODE_LABELS: Record<string, string> = {
  none: 'Software',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVDEC',
  vaapi: 'VAAPI',
};

const SOURCE_CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  vp9: 'VP9',
  av1: 'AV1',
};

// ENCODE target codec - separate from SOURCE_CODEC_LABELS (decode input).
// Only 'h264' is what real ytstream playback ever actually produces (see
// streamEncoderTuning.js's own VALID_VIDEO_CODECS comment); hevc/av1 exist
// here purely as an exploratory "what if" test.
const VIDEO_CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
};

interface TuningBenchmarkTableProps {
  hardwareMode: string;
  /** Currently selected hardware DECODE backend (ytstream.hardwareDecodeMode) - independent of hardwareMode. */
  decodeMode: string;
  matrix: TuningBenchmarkMatrix | null;
  recommended: TuningRecommendationMap | null;
  resultHardwareMode: string | null;
  resultDecodeMode: string | null;
  resultSourceCodec: string | null;
  resultVideoCodec: string | null;
  resultDecodeSourceHeight: number | null;
  progress: TuningBenchmarkProgress | null;
  testing: boolean;
  error: string | null;
  /**
   * @param sourceCodec - "Simulate source codec" selection (transient, decode input).
   * @param videoCodec - "Encode format" selection (transient, ENCODE target - real playback always uses H.264 regardless of this test).
   * @param decodeSourceHeight - "Decode source resolution" selection (transient) - caps how large a decode sample is generated; resolutions above it are skipped rather than silently re-tested against a too-small source.
   */
  onRunTest: (sourceCodec: string, videoCodec: string, decodeSourceHeight: number) => void;
  /** Non-null when the test isn't applicable to the current settings (e.g. Playback mode isn't Enhanced, or Transcode isn't H.264) - disables the button and explains why instead of letting it run pointlessly. */
  disabledReason?: string | null;
  onMobileTooltipClick?: (text: string) => void;
}

/**
 * "Test real-time tuning" button + per-resolution results table for the
 * currently selected Hardware encoder AND Hardware decode — see
 * server/modules/streamTuningBenchmark.js. The benchmark itself is scoped
 * server-side to just this one encode+decode pair (not every possible
 * combo), so this never spends time measuring hardware the host isn't
 * configured to use - including genuinely mismatched pairs like a software
 * encoder with a hardware decoder, which are measured exactly as selected.
 *
 * "Simulate source codec", "Decode source resolution" and "Encode format"
 * are transient, local-only controls (not persisted Settings fields) - real
 * playback doesn't get to choose what codec YouTube serves (source codec),
 * always decodes whatever the session's actual cached source size is
 * (decode source resolution - see streamTuningBenchmark.js's
 * decodeSourceHeight doc comment for why the default is a worst-case, not
 * "the real value"), and always encodes to H.264 (encode format - see
 * streamEncoderTuning.js's VALID_VIDEO_CODECS comment). All three exist
 * purely to answer "what if" questions for the benchmark itself, always
 * shown regardless of the actual Hardware decode/encode selection.
 *
 * Always renders the full resolution x tier grid, even before the first run
 * (every cell falls back to an "Untested" chip) - same convention as
 * HardwareCapabilitiesTable, so the shape of what's about to be measured is
 * visible immediately. A resolution above the selected "Decode source
 * resolution" renders "Skipped" instead of a result - see
 * TuningBenchmarkResult.skipped.
 */
export const TuningBenchmarkTable: React.FC<TuningBenchmarkTableProps> = ({
  hardwareMode,
  decodeMode,
  matrix,
  recommended,
  resultHardwareMode,
  resultDecodeMode,
  resultSourceCodec,
  resultVideoCodec,
  resultDecodeSourceHeight,
  progress,
  testing,
  error,
  onRunTest,
  disabledReason,
  onMobileTooltipClick,
}) => {
  // Default 'vp9' - YouTube's most common real DASH source codec above ~360p.
  const [sourceCodec, setSourceCodec] = useState('vp9');
  // Default 'h264' - the only codec real ytstream playback ever encodes to.
  const [videoCodec, setVideoCodec] = useState('h264');
  // Default to the largest tested resolution - matches the server's own
  // worst-case default (see streamTuningBenchmark.js's decodeSourceHeight).
  const [decodeSourceHeight, setDecodeSourceHeight] = useState(RESOLUTIONS[RESOLUTIONS.length - 1]);

  const hwLabel = HARDWARE_MODE_LABELS[hardwareMode] || hardwareMode;
  const decodeLabel = DECODE_MODE_LABELS[decodeMode] || decodeMode;
  const videoCodecLabel = VIDEO_CODEC_LABELS[videoCodec] || videoCodec;

  // Results on screen were measured for a different encode/decode/source
  // combo than what's currently selected (e.g. switched Hardware encoder or
  // Hardware decode without re-running) - still show them, but make clear
  // they're stale rather than silently implying they apply to the new
  // selection. Never true mid-run: useTuningBenchmark clears matrix/
  // resultHardwareMode etc. the moment a new run starts. Source codec always
  // matters now - even Hardware decode = Software still decodes a real
  // sample of whatever codec was selected.
  const stale = !!matrix && (
    (resultHardwareMode !== null && resultHardwareMode !== hardwareMode)
    || (resultDecodeMode !== null && resultDecodeMode !== decodeMode)
    || (resultSourceCodec !== null && resultSourceCodec !== sourceCodec)
    || (resultVideoCodec !== null && resultVideoCodec !== videoCodec)
    || (resultDecodeSourceHeight !== null && resultDecodeSourceHeight !== decodeSourceHeight)
  );

  let progressLabel = 'Test Real-Time Tuning';
  if (testing) {
    if (progress?.current?.warmup) {
      progressLabel = 'Warming up...';
    } else {
      progressLabel = progress && progress.total > 0
        ? `Testing ${progress.current?.tuning ?? '...'} @ ${progress.current?.height ?? '?'}p (${progress.completed}/${progress.total})...`
        : 'Starting benchmark...';
    }
  }

  return (
    <Box>
      <Box className='flex items-center gap-2 flex-wrap' style={{ marginBottom: 8 }}>
        <Button variant='outlined' onClick={() => onRunTest(sourceCodec, videoCodec, decodeSourceHeight)} disabled={testing || !!disabledReason}>
          {progressLabel}
        </Button>
        <FormControl style={{ minWidth: 160 }} disabled={testing}>
          <InputLabel>Simulate source codec</InputLabel>
          <Select
            label='Simulate source codec'
            value={sourceCodec}
            onChange={(e: SelectChangeEvent<string>) => setSourceCodec(e.target.value)}
          >
            {Object.keys(SOURCE_CODEC_LABELS).map((codec) => (
              <MenuItem key={codec} value={codec}>{SOURCE_CODEC_LABELS[codec]}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl style={{ minWidth: 160 }} disabled={testing}>
          <InputLabel>Decode source resolution</InputLabel>
          <Select
            label='Decode source resolution'
            value={decodeSourceHeight}
            onChange={(e: SelectChangeEvent<string>) => setDecodeSourceHeight(Number(e.target.value))}
          >
            {RESOLUTIONS.map((height) => (
              <MenuItem key={height} value={height}>{height}p</MenuItem>
            ))}
          </Select>
        </FormControl>
        <FormControl style={{ minWidth: 140 }} disabled={testing}>
          <InputLabel>Encode format</InputLabel>
          <Select
            label='Encode format'
            value={videoCodec}
            onChange={(e: SelectChangeEvent<string>) => setVideoCodec(e.target.value)}
          >
            {Object.keys(VIDEO_CODEC_LABELS).map((codec) => (
              <MenuItem key={codec} value={codec}>{VIDEO_CODEC_LABELS[codec]}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <InfoTooltip
          text={`Runs a real timed ${videoCodecLabel} encode for the selected encoder (${hwLabel}) across every tuning tier x resolution, using the exact args live playback uses, and reports whether each keeps up with real-time streaming. Note: real ytstream playback only ever encodes H.264 - Encode format here exists purely to explore "what if" HEVC/AV1 performance, not a real playback option.`
            + ` Also decodes a real ${SOURCE_CODEC_LABELS[sourceCodec] || sourceCodec} sample (generated at ${decodeSourceHeight}p) via ${decodeLabel} first, so the timed result genuinely includes decode cost, not just encode - Hardware decode = Software still measures a real (CPU) decode, not a skipped one. Any resolution above ${decodeSourceHeight}p is skipped rather than silently re-tested against a too-small source.`
            + ' Scoped to this exact encode/decode combo - usually well under a minute.'}
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
          These results are from testing Encode: {HARDWARE_MODE_LABELS[resultHardwareMode as string] || resultHardwareMode} ({VIDEO_CODEC_LABELS[resultVideoCodec || 'h264'] || resultVideoCodec})
          {resultDecodeMode && `, Decode: ${DECODE_MODE_LABELS[resultDecodeMode] || resultDecodeMode} (source: ${SOURCE_CODEC_LABELS[resultSourceCodec || ''] || resultSourceCodec} @ ${resultDecodeSourceHeight}p)`}
          . Run the test again to benchmark the currently selected options.
        </Alert>
      )}

      <Typography variant='caption' color='textSecondary' className='block mb-1'>
        {!stale && matrix
          ? `Tested: Encode ${hwLabel} (${VIDEO_CODEC_LABELS[resultVideoCodec || videoCodec] || videoCodec}), Decode ${decodeLabel} (source: ${SOURCE_CODEC_LABELS[resultSourceCodec || sourceCodec] || sourceCodec} @ ${resultDecodeSourceHeight ?? decodeSourceHeight}p)`
          : `Testing: Encode ${hwLabel} (${videoCodecLabel}), Decode ${decodeLabel} (source: ${SOURCE_CODEC_LABELS[sourceCodec] || sourceCodec} @ ${decodeSourceHeight}p)`}
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
                    if (cell.skipped) {
                      return (
                        <TableCell key={tier.id} align='center'>
                          <Tooltip title={cell.error || 'Skipped'}>
                            <Chip label='Skipped' size='small' variant='outlined' />
                          </Tooltip>
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
