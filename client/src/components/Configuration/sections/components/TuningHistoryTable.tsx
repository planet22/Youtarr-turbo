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

const TUNING_TIER_LABELS: Record<string, string> = {
  fast: 'Fast',
  balanced: 'Balanced',
  quality: 'Quality',
};

// Fixed display order (matches the Hardware encoder dropdown), independent
// of test order, so re-testing an encoder doesn't reshuffle the comparison
// rows underneath the reader.
const HARDWARE_MODE_ORDER = ['none', 'qsv', 'nvenc', 'vaapi', 'amf'];

interface TuningHistoryTableProps {
  history: TuningBenchmarkHistory;
}

/**
 * Cross-encoder comparison — every hardware encoder tested this session,
 * one row each, so switching Hardware encoder and re-running (which resets
 * the main TuningBenchmarkTable to just that one encoder) doesn't lose the
 * ability to compare against what you tested before. Each cell shows the
 * server's recommended tier for that resolution and its measured speed
 * factor; session-only (in-memory), resets on page reload - see
 * useTuningBenchmark's `history`.
 */
export const TuningHistoryTable: React.FC<TuningHistoryTableProps> = ({ history }) => {
  const testedModes = HARDWARE_MODE_ORDER.filter((mode) => history[mode]);
  if (testedModes.length === 0) return null;

  return (
    <Box style={{ marginTop: 16 }}>
      <Typography variant="subtitle2" color="textSecondary" className="mb-1">
        Tested encoders this session
      </Typography>
      <Typography variant="caption" color="textSecondary" className="block mb-1">
        Recommended tier and its measured real-time factor, per resolution — for comparing encoders side by side. Resets on page reload.
      </Typography>
      <TableContainer style={{ marginBottom: 8 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Encoder</TableCell>
              {RESOLUTIONS.map((height) => (
                <TableCell key={height} align="center">{height}p</TableCell>
              ))}
              <TableCell align="right">Tested</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {testedModes.map((mode) => {
              const entry = history[mode];
              return (
                <TableRow key={mode}>
                  <TableCell component="th">{HARDWARE_MODE_LABELS[mode] || mode}</TableCell>
                  {RESOLUTIONS.map((height) => {
                    const tier = entry.recommended[String(height)];
                    const cell = tier ? entry.matrix[String(height)]?.[tier] : undefined;
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
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
