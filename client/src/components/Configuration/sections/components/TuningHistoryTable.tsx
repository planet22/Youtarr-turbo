import React from 'react';
import {
  Box,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '../../../ui';
import { TuningBenchmarkHistory } from '../../hooks/useTuningBenchmark';
import { formatDateTime } from '../../../../utils/formatters';

const RESOLUTIONS = [480, 720, 1080, 1440, 2160];

const HARDWARE_MODE_LABELS: Record<string, string> = {
  none: 'Software',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVENC',
  vaapi: 'VAAPI',
  amf: 'AMD AMF',
};

// Decode's labels differ from encode's (see HardwareCapabilitiesTable.tsx -
// no 'amf', NVENC's decode counterpart is NVDEC).
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

// ENCODE target codec - see TuningBenchmarkTable.tsx's own copy of this
// table; ytstream's real playback only ever targets 'h264', hevc/av1 are
// exploratory-only options for this benchmark.
const VIDEO_CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
};

const TUNING_TIER_LABELS: Record<string, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  quality: 'Quality',
};

interface TuningHistoryTableProps {
  history: TuningBenchmarkHistory;
}

/**
 * Every tuning-benchmark run this session, newest first, one row each - a
 * full log rather than "one row per hardwareMode" so runs that differ only
 * by decode mode/source codec/VAAPI quality (all independently selectable -
 * see YtstreamSettingsSection.tsx) don't overwrite each other. Each row's
 * "Options" cell states exactly what was tested, so a result is
 * self-explanatory without needing to remember what was selected at the
 * time. Session-only (in-memory), resets on page reload - see
 * useTuningBenchmark's `history`.
 */
export const TuningHistoryTable: React.FC<TuningHistoryTableProps> = ({ history }) => {
  if (history.length === 0) return null;
  const newestFirst = [...history].reverse();

  return (
    <Box style={{ marginTop: 16 }}>
      <Typography variant="subtitle2" color="textSecondary" className="mb-1">
        Tuning benchmark history
      </Typography>
      <Typography variant="caption" color="textSecondary" className="block mb-1">
        Every run this session, newest first, with the options each one actually tested - resets on page reload.
      </Typography>
      <TableContainer style={{ marginBottom: 8 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Options</TableCell>
              {RESOLUTIONS.map((height) => (
                <TableCell key={height} align="center">{height}p</TableCell>
              ))}
              <TableCell align="right">Tested</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {newestFirst.map((entry, index) => (
              <TableRow key={`${entry.completedAt}-${index}`}>
                <TableCell component="th">
                  <Box className="flex flex-wrap items-center gap-1">
                    <Chip label={`Encode: ${HARDWARE_MODE_LABELS[entry.hardwareMode] || entry.hardwareMode} (${VIDEO_CODEC_LABELS[entry.videoCodec] || entry.videoCodec})`} size="small" variant="outlined" />
                    {entry.hardwareMode === 'vaapi' && entry.vaapiQuality != null && (
                      <Chip label={`Compression: ${entry.vaapiQuality}`} size="small" variant="outlined" />
                    )}
                    <Chip label={`Decode: ${DECODE_MODE_LABELS[entry.decodeMode] || entry.decodeMode}`} size="small" variant="outlined" color="info" />
                    {entry.sourceCodec && (
                      <Chip label={`Source: ${SOURCE_CODEC_LABELS[entry.sourceCodec] || entry.sourceCodec}${entry.decodeSourceHeight ? ` @ ${entry.decodeSourceHeight}p` : ''}`} size="small" variant="outlined" />
                    )}
                  </Box>
                </TableCell>
                {RESOLUTIONS.map((height) => {
                  const row = entry.matrix[String(height)];
                  const anySkipped = row && Object.values(row).some((c) => c.skipped);
                  if (anySkipped) {
                    return (
                      <TableCell key={height} align="center">
                        <Tooltip title={row.fast?.error || 'Skipped'}>
                          <Chip label="Skipped" size="small" variant="outlined" />
                        </Tooltip>
                      </TableCell>
                    );
                  }
                  const tier = entry.recommended[String(height)];
                  const cell = tier ? row?.[tier] : undefined;
                  if (!tier || !cell || !cell.ok) {
                    return (
                      <TableCell key={height} align="center">
                        <Chip label="Failed" color="error" size="small" />
                      </TableCell>
                    );
                  }
                  const label = `${TUNING_TIER_LABELS[tier] || tier} ${cell.realtimeFactor?.toFixed(1)}x`;
                  return (
                    <TableCell key={height} align="center">
                      <Tooltip title={cell.realtime ? 'Real-time safe' : 'Not real-time safe - best available fallback'}>
                        <Chip label={label} color={cell.realtime ? 'success' : 'warning'} size="small" />
                      </Tooltip>
                    </TableCell>
                  );
                })}
                <TableCell align="right">
                  <Typography variant="caption" color="textSecondary">
                    {formatDateTime(entry.completedAt)}
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
