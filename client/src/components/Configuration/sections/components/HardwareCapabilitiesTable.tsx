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
  Typography,
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

// Decode's hardware list has no 'amf' entry (see hardwareDecodeModule.js's
// doc comment - AMD decode on Linux goes through VAAPI, not a separate
// API), and NVENC's decode counterpart is a different underlying tech
// (NVDEC) worth labeling distinctly from the encode table's "NVIDIA NVENC"
// row just above it.
const DECODE_MODE_LABELS: Record<string, string> = {
  none: 'Software',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVDEC',
  vaapi: 'VAAPI',
};

// Decode's codec axis is the SOURCE codec (what a real DASH fetch would
// serve) - vp9 instead of hevc (YouTube never serves hevc as a source).
const SOURCE_CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  vp9: 'VP9',
  av1: 'AV1',
};

interface HardwareCapabilitiesTableProps {
  matrix: HardwareCapabilityMatrix | null;
  decodeMatrix?: HardwareCapabilityMatrix | null;
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
/** Shared row-of-chips renderer for both the Encoder and Decoder tables below - same "Untested"/"Works"/"Unsupported" shape either way, just a different backend list x codec list. */
function CapabilityRows({
  modeLabels,
  codecLabels,
  matrix,
}: {
  modeLabels: Record<string, string>;
  codecLabels: Record<string, string>;
  matrix: HardwareCapabilityMatrix | null | undefined;
}) {
  return (
    <>
      {Object.keys(modeLabels).map((mode) => (
        <TableRow key={mode}>
          <TableCell component='th'>{modeLabels[mode]}</TableCell>
          {Object.keys(codecLabels).map((codec) => {
            const cell = matrix?.[mode]?.[codec];
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
    </>
  );
}

export const HardwareCapabilitiesTable: React.FC<HardwareCapabilitiesTableProps> = ({
  matrix,
  decodeMatrix,
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
          text='Runs a real 1-second test encode through every hardware backend x codec combo on this host, so you can see what actually works before picking a transcode setting. Also tests hardware DECODE separately (below) - a genuinely different question from encode, since a real sample has to actually be decoded, not just generated.'
          onMobileClick={onMobileTooltipClick}
        />
      </Box>

      {error && (
        <Alert severity='error' style={{ marginBottom: 8 }}>{error}</Alert>
      )}

      <Typography variant='caption' color='textSecondary' className='block mb-1'>Encoder</Typography>
      <TableContainer style={{ marginBottom: 16 }}>
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
            <CapabilityRows modeLabels={HARDWARE_MODE_LABELS} codecLabels={VIDEO_CODEC_LABELS} matrix={matrix} />
          </TableBody>
        </Table>
      </TableContainer>

      <Typography variant='caption' color='textSecondary' className='block mb-1'>
        Decoder (independent of Encoder above - either can be hardware or software regardless of the other)
      </Typography>
      <TableContainer style={{ marginBottom: 8 }}>
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>Decoder</TableCell>
              {Object.keys(SOURCE_CODEC_LABELS).map((codec) => (
                <TableCell key={codec} align='center'>{SOURCE_CODEC_LABELS[codec]}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            <CapabilityRows modeLabels={DECODE_MODE_LABELS} codecLabels={SOURCE_CODEC_LABELS} matrix={decodeMatrix} />
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
};
