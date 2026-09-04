import React from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
} from '../../../ui';
import { InfoTooltip } from '../../common/InfoTooltip';
import { HardwareCapabilityMatrix } from '../../hooks/useHardwareCapabilities';

const HARDWARE_MODE_LABELS: Record<string, string> = {
  none: 'Software',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVENC',
  vaapi: 'VAAPI',
  amf: 'AMD AMF',
};

const VIDEO_CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'H.265/HEVC',
  av1: 'AV1',
};

interface HardwareCapabilitiesTableProps {
  matrix: HardwareCapabilityMatrix | null;
  testing: boolean;
  error: string | null;
  onRunTest: () => void;
  onMobileTooltipClick?: (text: string) => void;
}

/**
 * Test-Hardware-Capabilities button + results table, shared by
 * YtdlpOptionsSection (Settings → YT-DLP, tests the download-transcode
 * encoders) and YtstreamSettingsSection (Settings → Streaming, tests the
 * same encoders for STRM playback transcoding) — same host, same ffmpeg
 * binary, so a test run in either place is equally valid for both.
 *
 * The table always renders, even before the first test (or if it fails) —
 * every cell falls back to an "Untested" chip rather than the whole table
 * disappearing, so the available hardware modes/codecs are visible as soon
 * as either settings page loads.
 */
export const HardwareCapabilitiesTable: React.FC<HardwareCapabilitiesTableProps> = ({
  matrix,
  testing,
  error,
  onRunTest,
  onMobileTooltipClick,
}) => {
  return (
    <Box>
      <Box className='flex items-center gap-1' style={{ marginBottom: 8 }}>
        <Button variant='outlined' onClick={onRunTest} disabled={testing}>
          {testing ? 'Testing (this can take a minute)...' : 'Test Hardware Capabilities'}
        </Button>
        <InfoTooltip
          text='Runs a real 1-second test encode through every hardware backend x codec combo on this host, so you can see what actually works before picking a transcode setting.'
          onMobileClick={onMobileTooltipClick}
        />
      </Box>

      {error && (
        <Alert severity='error' style={{ marginBottom: 8 }}>{error}</Alert>
      )}

      <TableContainer style={{ marginBottom: 8 }}>
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>Encoder</TableCell>
              {Object.keys(VIDEO_CODEC_LABELS).map((codec) => (
                <TableCell key={codec} align='center'>{VIDEO_CODEC_LABELS[codec]}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {Object.keys(HARDWARE_MODE_LABELS).map((hw) => (
              <TableRow key={hw}>
                <TableCell component='th'>{HARDWARE_MODE_LABELS[hw]}</TableCell>
                {Object.keys(VIDEO_CODEC_LABELS).map((codec) => {
                  const cell = matrix?.[hw]?.[codec];
                  if (!cell) {
                    return (
                      <TableCell key={codec} align='center'>
                        <Chip label='Untested' size='small' variant='outlined' />
                      </TableCell>
                    );
                  }
                  return (
                    <TableCell key={codec} align='center'>
                      {cell.ok ? (
                        <Chip label='Works' color='success' size='small' />
                      ) : (
                        <Tooltip title={cell.error || 'Failed'}>
                          <Chip label='Unsupported' color='error' size='small' />
                        </Tooltip>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
