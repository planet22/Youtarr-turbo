import React from 'react';
import {
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  Grid,
  Box,
  Typography,
  Divider,
  SelectChangeEvent,
  Switch,
  FormControlLabel,
} from '../../ui';
import { InfoTooltip } from '../common/InfoTooltip';
import { ConfigState } from '../types';
import { useHardwareCapabilities } from '../hooks/useHardwareCapabilities';
import { HardwareCapabilitiesTable } from './components/HardwareCapabilitiesTable';

type YtstreamConfig = ConfigState['ytstream'];

interface Props {
  config: ConfigState;
  onConfigChange: (updates: Partial<ConfigState>) => void;
  onMobileTooltipClick?: (text: string) => void;
  /** True when the parent STRM target isn't "ytstream" yet (fields still show, just disabled). */
  disabled?: boolean;
  token: string | null;
}

const DEFAULT_YTSTREAM: YtstreamConfig = {
  defaultMode: 'direct',
  container: 'mp4',
  transcode: '',
  quality: null,
  hardwareMode: 'none',
  playerClient: '',
  calculatedLength: false,
  hotSwapToCache: false,
  instantStart: false,
  probeShortcut: false,
  forceServerSettings: false,
};

/**
 * Configuration options for the /api/ytstream direct/ffmpeg playback route
 * (see server/routes/ytstream.js and docs/YTSTREAM.md). Rendered by
 * StrmSettingsSection when strm.target === 'ytstream', but kept as its own
 * component/file so these options aren't tangled up with the rest of the
 * STRM (.strm file writer) settings.
 */
export const YtstreamSettingsSection: React.FC<Props> = ({
  config,
  onConfigChange,
  onMobileTooltipClick,
  disabled = false,
  token,
}) => {
  const ytstream = config.ytstream || DEFAULT_YTSTREAM;
  const { testing: testingHardware, matrix: hardwareMatrix, error: hardwareTestError, runTest: runHardwareTest } = useHardwareCapabilities(token);

  const setYtstream = (patch: Partial<YtstreamConfig>) => {
    onConfigChange({ ytstream: { ...ytstream, ...patch } });
  };

  const mode = ytstream.defaultMode || 'direct';
  // Container/transcode/hardware apply to both ffmpeg-mode's live pipe and
  // hls-mode's segmented output. calculatedLength applies to both too, but
  // means different things — see the checkbox's tooltip below.
  const enhancedMode = mode === 'ffmpeg' || mode === 'hls';
  const forceH264 = ytstream.transcode === 'h264';
  // When on, these fields' values are what every playback request actually
  // uses — query-string overrides (a caller's own URL, or values baked into
  // an already-written .strm file) are ignored server-side. Highlighted so
  // it's clear which settings that guarantee applies to.
  const forced = ytstream.forceServerSettings === true;
  const forcedFieldStyle: React.CSSProperties = {
    borderRadius: 'var(--radius-ui)',
    boxShadow: '0 0 0 1px var(--warning)',
    backgroundColor: 'color-mix(in srgb, var(--warning) 8%, transparent)',
    padding: 6,
    margin: -6,
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12}>
        <Typography variant="subtitle2" color="textSecondary">
          Playback &amp; Quality
        </Typography>
        <Typography variant="caption" color="textSecondary" className="block mb-1">
          ytstream (yt-dlp resolve + optional ffmpeg)
        </Typography>
      </Grid>

      <Grid item xs={12}>
        <Box className="flex items-center gap-1">
          <FormControlLabel
            control={
              <Switch
                checked={forced}
                onChange={(e) => setYtstream({ forceServerSettings: e.target.checked })}
                disabled={disabled}
              />
            }
            label="Force these settings (ignore URL / .strm overrides)"
          />
          <InfoTooltip
            text="Playback requests can carry their own mode/quality/container/transcode/hardware/calculated-length — either a caller's own URL, or values baked into a .strm file's URL back when it was written. When on, the highlighted settings below are always used as-is instead, even if they've changed since older .strm files were written."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

      <Grid item xs={12} md={4}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Playback mode</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={mode}
              label="Playback mode"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({ defaultMode: e.target.value as 'direct' | 'ffmpeg' | 'hls' })
              }
              className="flex-1 min-w-0"
              disabled={disabled}
            >
              <MenuItem value="direct">Direct / Simple (redirect, no ffmpeg)</MenuItem>
              <MenuItem value="ffmpeg">Enhanced (ffmpeg, live pipe)</MenuItem>
              <MenuItem value="hls">Enhanced HLS (segmented, most compatible)</MenuItem>
            </Select>
            <InfoTooltip
              text="Direct redirects the player to a resolved stream URL (plugin Simple mode). Enhanced (ffmpeg) re-streams through a single live ffmpeg connection. Enhanced HLS instead writes real segment files and only responds once the first one exists — fixes players (Jellyfin included) that won't tolerate the live pipe's startup wait and retry forever instead of playing; costs some local disk space per active stream. Both fall back to Direct automatically if ffmpeg is unavailable."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      <Grid item xs={12} md={4}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Stream quality</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={ytstream.quality ?? ''}
              label="Stream quality"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({
                  quality: e.target.value === '' ? null : e.target.value,
                })
              }
              className="flex-1 min-w-0"
              disabled={disabled}
            >
              <MenuItem value="">Auto (preferred resolution / 720)</MenuItem>
              <MenuItem value="720">720p progressive (broad compatibility)</MenuItem>
              <MenuItem value="1080">1080p balanced</MenuItem>
              <MenuItem value="480">480p</MenuItem>
              <MenuItem value="1440">1440p</MenuItem>
              <MenuItem value="2160">2160p / 4K</MenuItem>
              <MenuItem value="best">Best available</MenuItem>
            </Select>
            <InfoTooltip
              text="Maps to yt-dlp format selectors used by the Jellyfin YouTube plugin: 720 = progressive MP4, 1080 = balanced, best = maximum quality (may be HLS). Enhanced mode uses separate AVC+AAC inputs capped at this height."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      <Grid item xs={12} md={4}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Container</InputLabel>
          <Select
            value={ytstream.container || 'mp4'}
            label="Container"
            onChange={(e: SelectChangeEvent<string>) =>
              setYtstream({ container: e.target.value as 'mp4' | 'ts' })
            }
            disabled={disabled || !enhancedMode}
          >
            <MenuItem value="mp4">MP4 (fragmented pipe, or fMP4 segments in HLS mode)</MenuItem>
            <MenuItem value="ts">MPEG-TS (player-friendly; MPEG-TS segments in HLS mode)</MenuItem>
          </Select>
        </FormControl>
      </Grid>

      <Grid item xs={12} md={4}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Transcode</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={ytstream.transcode || ''}
              label="Transcode"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({ transcode: e.target.value as '' | 'copy' | 'h264' })
              }
              className="flex-1 min-w-0"
              disabled={disabled || !enhancedMode}
            >
              <MenuItem value="">Auto (match download codec setting)</MenuItem>
              <MenuItem value="copy">Always remux (copy, no re-encode)</MenuItem>
              <MenuItem value="h264">Force re-encode (H.264/AAC)</MenuItem>
            </Select>
            <InfoTooltip
              text="Copy remuxes without re-encoding (fast). H.264 re-encodes for maximum client compatibility and is required to use hardware acceleration below."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      <Grid item xs={12} md={4}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Hardware encoder</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={ytstream.hardwareMode || 'none'}
              label="Hardware encoder"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({
                  hardwareMode: e.target.value as 'none' | 'qsv' | 'nvenc' | 'vaapi' | 'amf',
                })
              }
              className="flex-1 min-w-0"
              disabled={disabled || !enhancedMode || !forceH264}
            >
              <MenuItem value="none">None (software libx264)</MenuItem>
              <MenuItem value="qsv">Intel Quick Sync (h264_qsv)</MenuItem>
              <MenuItem value="nvenc">NVIDIA NVENC (h264_nvenc)</MenuItem>
              <MenuItem value="vaapi">VAAPI (h264_vaapi)</MenuItem>
              <MenuItem value="amf">AMD AMF (h264_amf)</MenuItem>
            </Select>
            <InfoTooltip
              text="Used only when Playback mode is Enhanced and Transcode is H.264. Same options as the Jellyfin YouTube plugin managed transcode path. Requires the matching ffmpeg build and GPU drivers on the Youtarr host (and device passthrough in Docker)."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      <Grid item xs={12}>
        <HardwareCapabilitiesTable
          matrix={hardwareMatrix}
          testing={testingHardware}
          error={hardwareTestError}
          onRunTest={runHardwareTest}
          onMobileTooltipClick={onMobileTooltipClick}
        />
      </Grid>

      <Grid item xs={12} md={4}>
        <Box className="flex items-center gap-1">
          <TextField
            fullWidth
            label="yt-dlp player client override"
            name="ytstreamPlayerClient"
            value={ytstream.playerClient || ''}
            onChange={(e) => setYtstream({ playerClient: e.target.value })}
            placeholder="default,-tv"
            disabled={disabled}
            helperText='Leave blank for "default,-tv" (recommended). Only change this if streams still fail after an update.'
          />
          <InfoTooltip
            text={
              'Passed as yt-dlp --extractor-args youtube:player_client=VALUE. The default excludes the "tv" client, which is the most common source of YouTube\'s "The page needs to be reloaded." error. Try "android" or "web,android" if problems persist after updating yt-dlp.'
            }
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

      <Grid item xs={12}>
        <Divider className="my-2" />
        <Typography variant="subtitle2" color="textSecondary" className="mb-1">
          Performance Optimizations
        </Typography>
      </Grid>

      <Grid item xs={12} md={4}>
        <Box className="flex items-center gap-1" style={forced ? forcedFieldStyle : undefined}>
          <FormControlLabel
            control={
              <Switch
                checked={ytstream.calculatedLength ?? false}
                onChange={(e) => setYtstream({ calculatedLength: e.target.checked })}
                disabled={disabled || !enhancedMode}
              />
            }
            label="Calculated length"
          />
          <InfoTooltip
            text="Enhanced modes only. In Enhanced (ffmpeg): reports an estimated file size/duration and answers seek (Range) requests by restarting the live pipe at the matching estimated timestamp — the estimate is approximate, seeking has the same multi-second restart latency as a cold start, and playback near the very end can show a few seconds of silence if the real encode finished early. In Enhanced HLS: builds the real, exact-duration playlist upfront (no estimate) so the player sees a full seekable timeline immediately; seeking past what's been encoded so far restarts the encode at that segment instead of the whole stream, which is faster and only ever approximate for the segment currently being (re)encoded. Off, HLS still plays fine but the timeline only grows as segments are produced, so some players won't show a scrub bar until near the end."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

      {mode === 'hls' && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.hotSwapToCache ?? false}
                  onChange={(e) => setYtstream({ hotSwapToCache: e.target.checked })}
                  disabled={disabled}
                />
              }
              label="Hot-swap to cached file"
            />
            <InfoTooltip
              text="Enhanced HLS only. If the STRM 'Cache on play' background download finishes while this video is still playing, the session switches to producing the remaining segments from the local cached file instead of the live network pull - same picture, no restart, just faster and more reliable for the rest of the video. Has no effect unless Cache on play is also enabled."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {mode === 'hls' && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.instantStart ?? false}
                  onChange={(e) => setYtstream({ instantStart: e.target.checked })}
                  disabled={disabled || !ytstream.calculatedLength || !forceH264}
                />
              }
              label="Instant start"
            />
            <InfoTooltip
              text="Enhanced HLS + Calculated length + Transcode=H.264 only. Normally the very first response blocks until the real encode produces its first segment (10-25s is typical for a cold start). This serves a small pre-generated 'loading' clip as segment 0 instead, so playback starts within milliseconds while the real encode catches up in the background - the placeholder is generated once (matching your codec/hardware settings) and reused after that. No effect for Transcode=Copy, since no single placeholder could match every video's own passthrough codec."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {forceH264 && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.probeShortcut ?? false}
                  onChange={(e) => setYtstream({ probeShortcut: e.target.checked })}
                  disabled={disabled || !forceH264}
                />
              }
              label="Probe shortcut"
            />
            <InfoTooltip
              text="Transcode=H.264 only. A media server's metadata probe (Jellyfin's ffprobe, or similar) hitting a .strm's URL normally triggers a real yt-dlp/ffmpeg session against YouTube just to read codec info. When on, every .strm this app writes gets a custom User-Agent marker that real playback honors but a bare probe request doesn't (a known Jellyfin quirk) - a detected probe gets a tiny cached clip in the right codec instead, with zero YouTube traffic. Existing .strm files need to be rewritten (re-download, or a channel resync) to pick up the marker."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {enhancedMode && forceH264 && (ytstream.hardwareMode || 'none') !== 'none' && (
        <Grid item xs={12}>
          <Typography variant="body2" color="textSecondary">
            Hardware encoding needs a matching ffmpeg binary and GPU access
            on the Youtarr host. Docker: pass through the device (e.g.{' '}
            <code>--device /dev/dri</code> for VAAPI/QSV, or NVIDIA
            Container Toolkit for NVENC). If the encoder fails mid-stream,
            the client will see a stalled playback — switch back to
            software (None) to confirm.
          </Typography>
        </Grid>
      )}

      <Grid item xs={12}>
        <Divider className="my-2" />
        <Typography variant="body2" color="textSecondary">
          Seeing "The page needs to be reloaded." or streams failing to
          start? Youtarr automatically retries once with a different player
          client, and update yt-dlp (Settings → yt-dlp) first if it keeps
          happening — YouTube changes break extraction often and fixes ship
          quickly. See docs/YTSTREAM.md → Troubleshooting for details.
        </Typography>
      </Grid>
    </Grid>
  );
};
