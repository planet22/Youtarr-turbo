import React, { useState } from 'react';
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
  TextField,
  Tooltip,
  Typography,
} from '../../../ui';
import { InfoTooltip } from '../../common/InfoTooltip';
import {
  NetworkTuningPreset,
  NetworkTuningProgress,
  NetworkTuningResults,
} from '../../hooks/useNetworkTuningBenchmark';

interface NetworkTuningBenchmarkTableProps {
  results: NetworkTuningResults | null;
  recommended: string | null;
  presets: NetworkTuningPreset[] | null;
  progress: NetworkTuningProgress | null;
  testing: boolean;
  error: string | null;
  onRunTest: (urlOrId: string) => void;
  /** Applies the recommended preset's httpChunkSizeMiB/concurrentFragments to Settings. */
  onApplyRecommended: (preset: NetworkTuningPreset) => void;
  /** Non-null when applying results wouldn't do anything useful right now (Playback mode isn't Enhanced HLS) - the test itself still runs, this only affects the Apply button. */
  applyDisabledReason?: string | null;
  onMobileTooltipClick?: (text: string) => void;
}

/**
 * "Test network tuning" button + per-preset throughput results table - see
 * server/modules/networkTuningBenchmark.js. Runs a real yt-dlp fetch of a
 * user-supplied YouTube video across a handful of --http-chunk-size/
 * --concurrent-fragments presets and reports measured MB/s for each, so a
 * user can pick real-world values instead of guessing. A different question
 * from TuningBenchmarkTable's encode-speed test: this never touches ffmpeg
 * and measures network/CDN behavior (including YouTube's own mid-download
 * throttling), not local CPU/GPU cost.
 */
export const NetworkTuningBenchmarkTable: React.FC<NetworkTuningBenchmarkTableProps> = ({
  results,
  recommended,
  presets,
  progress,
  testing,
  error,
  onRunTest,
  onApplyRecommended,
  applyDisabledReason,
  onMobileTooltipClick,
}) => {
  const [urlInput, setUrlInput] = useState('');

  let progressLabel = 'Test Network Tuning';
  if (testing) {
    progressLabel = progress?.current?.presetId
      ? `Testing "${presets?.find((p) => p.id === progress.current?.presetId)?.label ?? progress.current.presetId}" (${progress.completed}/${progress.total})...`
      : 'Starting benchmark...';
  }

  const recommendedPreset = presets?.find((p) => p.id === recommended) ?? null;

  return (
    <Box>
      <Box className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 8 }}>
        <TextField
          label="YouTube URL or video ID"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://youtube.com/watch?v=... or dQw4w9WgXcQ"
          disabled={testing}
          style={{ minWidth: 280 }}
        />
        <Button variant="outlined" onClick={() => onRunTest(urlInput)} disabled={testing || !urlInput.trim()}>
          {progressLabel}
        </Button>
        <InfoTooltip
          text="Runs a real yt-dlp fetch of this video's best video-only stream (up to 1080p, or whatever Stream quality is set to) for up to 15 seconds per preset, discarding the bytes as they arrive - no ffmpeg, no disk write. Measures actual sustained throughput, including whether YouTube's own mid-download bandwidth throttling kicks in. Sequential across 4 presets, so a full run takes roughly a minute."
          onMobileClick={onMobileTooltipClick}
        />
      </Box>

      {testing && progress && progress.total > 0 && (
        <LinearProgress
          variant="determinate"
          value={(progress.completed / progress.total) * 100}
          style={{ marginBottom: 8 }}
        />
      )}

      {error && (
        <Alert severity="error" style={{ marginBottom: 8 }}>{error}</Alert>
      )}

      <TableContainer style={{ marginBottom: 8 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Preset</TableCell>
              <TableCell align="center">Throughput</TableCell>
              <TableCell align="center">Sampled</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(presets ?? []).map((preset) => {
              const cell = results?.[preset.id];
              const isRunningThis = testing && progress?.current?.presetId === preset.id;
              const isRecommended = recommended === preset.id;
              return (
                <TableRow key={preset.id}>
                  <TableCell component="th">{preset.label}</TableCell>
                  {isRunningThis && (
                    <TableCell align="center" colSpan={2}>
                      <Chip label="Testing..." size="small" color="info" variant="outlined" />
                    </TableCell>
                  )}
                  {!isRunningThis && !cell && (
                    <TableCell align="center" colSpan={2}>
                      <Chip label="Untested" size="small" variant="outlined" />
                    </TableCell>
                  )}
                  {!isRunningThis && cell && !cell.ok && (
                    <TableCell align="center" colSpan={2}>
                      <Tooltip title={cell.error || 'Failed'}>
                        <Chip label="Failed" color="error" size="small" />
                      </Tooltip>
                    </TableCell>
                  )}
                  {!isRunningThis && cell && cell.ok && (
                    <>
                      <TableCell align="center">
                        <Box className="flex items-center justify-center gap-1">
                          {cell.stderrTail ? (
                            <Tooltip title={cell.stderrTail}>
                              <Chip label={`${cell.throughputMBps?.toFixed(1)} MB/s`} color={isRecommended ? 'success' : 'default'} size="small" variant="outlined" />
                            </Tooltip>
                          ) : (
                            <Chip label={`${cell.throughputMBps?.toFixed(1)} MB/s`} color={isRecommended ? 'success' : 'default'} size="small" />
                          )}
                          {isRecommended && <Chip label="Recommended" size="small" />}
                        </Box>
                      </TableCell>
                      <TableCell align="center">
                        {cell.elapsedSeconds?.toFixed(1)}s / {((cell.bytes ?? 0) / 1024 / 1024).toFixed(0)}MB
                      </TableCell>
                    </>
                  )}
                </TableRow>
              );
            })}
            {!presets && (
              <TableRow>
                <TableCell colSpan={3}>
                  <Typography variant="body2" color="textSecondary">
                    Run the test to measure throughput for each preset.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {recommendedPreset && (
        <Box className="flex items-center gap-1 flex-wrap">
          <Button
            variant="outlined"
            size="small"
            onClick={() => onApplyRecommended(recommendedPreset)}
            disabled={!!applyDisabledReason}
          >
            Apply recommended ({recommendedPreset.label})
          </Button>
          {applyDisabledReason && (
            <Typography variant="caption" color="textSecondary">{applyDisabledReason}</Typography>
          )}
        </Box>
      )}
    </Box>
  );
};
