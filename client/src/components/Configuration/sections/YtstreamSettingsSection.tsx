import React, { useEffect, useState } from 'react';
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
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
  AlertTitle,
  Button,
} from '../../ui';
import { Trash2 as DeleteIcon, Warning as WarningIcon } from '../../../lib/icons';
import { InfoTooltip } from '../common/InfoTooltip';
import { ConfigState } from '../types';
import { formatFileSize } from '../../../utils/formatters';
import { useHardwareCapabilities } from '../hooks/useHardwareCapabilities';
import { useTuningBenchmark } from '../hooks/useTuningBenchmark';
import { useYtstreamModeCompatibility } from '../hooks/useYtstreamModeCompatibility';
import { useUntrackedCache } from '../hooks/useUntrackedCache';
import { useMetadataCache } from '../hooks/useMetadataCache';
import { useSegmentTimingTest } from '../hooks/useSegmentTimingTest';
import { HardwareTestingAccordion } from './components/HardwareTestingAccordion';
import { TuningBenchmarkTable } from './components/TuningBenchmarkTable';
import { TuningHistoryTable } from './components/TuningHistoryTable';
import { SegmentTimingTestButton } from './components/SegmentTimingTestButton';

type YtstreamConfig = ConfigState['ytstream'];

interface Props {
  config: ConfigState;
  onConfigChange: (updates: Partial<ConfigState>) => void;
  onMobileTooltipClick?: (text: string) => void;
  /** True when the parent STRM target isn't "ytstream" yet (fields still show, just disabled). */
  disabled?: boolean;
  token: string | null;
}

export const DEFAULT_YTSTREAM: YtstreamConfig = {
  defaultMode: 'direct',
  container: 'mp4',
  transcode: '',
  quality: null,
  qualityStrictness: 'fallback',
  hardwareMode: 'none',
  hardwareDecodeMode: 'none',
  tuning: 'fast',
  vaapiQuality: null,
  playerClient: '',
  calculatedLength: false,
  hotSwapToCache: false,
  serveCachedFile: false,
  instantStart: false,
  probeShortcut: false,
  forceServerSettings: false,
  historyRetentionDays: 90,
  hlsStorageLocation: 'tmp',
  backfillMissingSegments: false,
  finalizeToMp4: false,
  debugLogging: false,
  forceKeyframesByHardwareMode: {},
};

// Each mode's real limitation, stated plainly - see resolvePlaybackPlan's
// execution steps (server/routes/ytstream.js) for the same information in
// dry-run form. No mode falls back to a different mode's behavior; each
// either works as described or fails outright (502).
const MODE_TOOLTIPS: Record<string, string> = {
  direct: 'Resolves a playback URL via yt-dlp and proxies it directly - no ffmpeg, no re-encode. Progressive-only (~360p regardless of Stream quality). A rejected URL just fails, with no automatic retry beyond the same-request extraction-error retry.',
  'direct-pipe': 'Same ~360p progressive-only ceiling as Direct, but fetched through yt-dlp\'s own process, so it survives the session-bound-URL failure Direct can\'t. No Range/seek support - a seek restarts playback from 0.',
  'direct-redirect': 'Resolves a playback URL and sends the player a 302 straight to it - Youtarr never touches the bytes, the lightest mode on its own resources. No cookies/Referer travel with the redirect (age-restricted/members-only videos fail), and whatever happens after is invisible to Youtarr\'s logs.',
  ffmpeg: 'Re-streams through a live ffmpeg pipe fed by yt-dlp\'s DASH formats - real quality beyond progressive\'s ceiling. Requires a working ffmpeg on the host; fails outright (502) if it isn\'t available, no fallback to Direct.',
  hls: 'Same DASH-based quality as Enhanced, but writes real HLS segment files to disk instead of a live pipe - fixes players (Jellyfin included) that won\'t tolerate the live pipe\'s startup wait. Costs local disk space per active stream. Backfill missing segments (below) can apply once Hot-swap to cached file gives it a local source.',
  'hls-buffer': 'Same as Enhanced HLS, but an independent fetch starts immediately and pulls the whole video once, unthrottled, into a local MPEG-TS buffer file that becomes the permanent download - keeps running even if you seek early or stop watching. Calculated length is always on for this mode. Backfill and Finalize .ts to .mp4 (below) can both apply once buffered.',
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
  const { testing: testingHardware, matrix: hardwareMatrix, decodeMatrix: hardwareDecodeMatrix, error: hardwareTestError, runTest: runHardwareTest } = useHardwareCapabilities(token);
  const {
    testing: testingTuning,
    progress: tuningProgress,
    matrix: tuningMatrix,
    recommended: tuningRecommended,
    resultHardwareMode: tuningResultHardwareMode,
    resultDecodeMode: tuningResultDecodeMode,
    resultSourceCodec: tuningResultSourceCodec,
    resultVideoCodec: tuningResultVideoCodec,
    resultDecodeSourceHeight: tuningResultDecodeSourceHeight,
    history: tuningHistory,
    error: tuningTestError,
    runBenchmark: runTuningBenchmark,
  } = useTuningBenchmark(token);
  const {
    fileCount: untrackedCacheFileCount,
    totalBytes: untrackedCacheTotalBytes,
    clearing: clearingUntrackedCache,
    error: untrackedCacheError,
    clear: clearUntrackedCache,
  } = useUntrackedCache(token);
  const [confirmClearUntrackedCache, setConfirmClearUntrackedCache] = useState(false);
  const {
    count: metadataCacheCount,
    clearing: clearingMetadataCache,
    error: metadataCacheError,
    clear: clearMetadataCache,
  } = useMetadataCache(token);
  const [confirmClearMetadataCache, setConfirmClearMetadataCache] = useState(false);
  const {
    testing: testingSegmentTiming,
    result: segmentTimingResult,
    error: segmentTimingError,
    runTest: runSegmentTimingTest,
  } = useSegmentTimingTest(token);

  const setYtstream = (patch: Partial<YtstreamConfig>) => {
    onConfigChange({ ytstream: { ...ytstream, ...patch } });
  };

  // Cache on play / Hot-swap / Revert-to-STRM are strm.* (not ytstream.*)
  // config, but live here now (moved from StrmSettingsSection's own "File
  // Output" section) so every field whose visibility depends on Playback
  // mode - Instant start/Hot-swap via modeCompat, Cache on play/Revert-hours
  // by association since Hot-swap and Revert-hours both only matter once
  // Cache on play is on - changes in exactly one place on the page instead
  // of two disconnected ones.
  const cacheOnPlay = config.strm?.cacheOnPlay === true;
  const setStrm = (patch: Partial<ConfigState['strm']>) => {
    onConfigChange({ strm: { ...config.strm, ...patch } });
  };

  const mode = ytstream.defaultMode || 'direct';
  const forceH264 = ytstream.transcode === 'h264';
  // Single source of truth for every mode-gated field below - see
  // getModeFieldCompatibility's own doc comment in server/routes/ytstream.js
  // and useYtstreamModeCompatibility's. Nothing here is computed locally
  // anymore (no more hand-maintained enhancedMode/calculatedLengthRequired/
  // probeShortcutRequired-style booleans, one per discovery, each needing
  // its own reasoning duplicated into a tooltip) - nine of these once did,
  // found and fixed one at a time over the course of 2026-09-02, which is
  // exactly the pattern this consolidates away. A field's disabled state
  // (`!== 'optional'`) fails closed (disabled) for the brief window before
  // this has loaded, same as `modeCompat.x` being undefined - never a false
  // "looks enabled" flash. 'ignored' fields render nothing at all (not just
  // disabled) - a setting with zero effect for this mode shouldn't be shown;
  // 'forced' fields stay visible, disabled, and reflect the pinned value.
  const modeCompat = useYtstreamModeCompatibility(mode, ytstream.transcode || '', token, ytstream.container || '');
  // enhancedMode is still used below for the tuning-benchmark's own
  // disabled-reason messaging (a UI affordance unrelated to any one
  // field's forced/ignored status) and by Encoding tuning's Recommended
  // badge - not a duplicate of modeCompat, a different, narrower question
  // ("does this mode run an ffmpeg encode at all").
  const enhancedMode = mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-buffer';

  useEffect(() => {
    if (modeCompat.calculatedLength?.status === 'forced' && ytstream.calculatedLength !== true) {
      setYtstream({ calculatedLength: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeCompat.calculatedLength?.status, ytstream.calculatedLength]);

  const currentHardwareMode = ytstream.hardwareMode || 'none';
  // Maps the "Stream quality" dropdown's value onto the resolution keys the
  // tuning benchmark matrix uses (480/720/1080/1440/2160) - '' (Auto) falls
  // back to 720 (this route's own default - see resolveQualityHeight in
  // ytstream.js), and 'best' has no fixed height for the benchmark to key
  // on, so no recommendation applies there.
  const qualityHeightForTuning = !ytstream.quality ? '720' : ytstream.quality === 'best' ? null : ytstream.quality;
  // Only trust tuningRecommended when it was actually measured for the
  // encoder currently selected - switching Hardware encoder after running
  // the benchmark shouldn't silently apply a different encoder's results.
  const recommendedTierForCurrentQuality = qualityHeightForTuning && tuningResultHardwareMode === currentHardwareMode
    ? tuningRecommended?.[qualityHeightForTuning]
    : undefined;
  // The tuning benchmark (and its "Recommended" badges above) only means
  // anything once H.264 re-encoding via Enhanced mode is actually in play.
  const tuningTestDisabledReason = !enhancedMode
    ? 'Set Playback mode to Enhanced (ffmpeg) or Enhanced HLS to test tuning.'
    : !forceH264
      ? 'Set Transcode to "Force re-encode (H.264/AAC)" to test tuning.'
      : null;
  // When on, these fields' values are what every playback request actually
  // uses — query-string overrides (a caller's own URL, or values baked into
  // an already-written .strm file) are ignored server-side. Highlighted so
  // it's clear which settings that guarantee applies to.
  const forced = ytstream.forceServerSettings === true;
  // padding/margin are equal-and-opposite (self-cancelling) so the highlight
  // grows outward from each field without shifting layout when `forced`
  // toggles on/off. Kept small (3px, not the field's full Grid gutter of
  // 8px/side at spacing={2}) so adjacent highlighted fields still have
  // visible breathing room between their boxes instead of nearly touching.
  const forcedFieldStyle: React.CSSProperties = {
    borderRadius: 'var(--radius-ui)',
    boxShadow: '0 0 0 1px var(--warning)',
    backgroundColor: 'color-mix(in srgb, var(--warning) 8%, transparent)',
    padding: 3,
    margin: -3,
  };

  return (
    <Grid container spacing={3}>
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
            text="When on, ignores any mode/quality/etc. a request's URL or an older .strm file carries - the highlighted settings below are always used as-is."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

      {/* Row 1 - what stream gets built: mode, container, and the quality
          knobs that shape it. */}
      <Grid item xs={12} sm={6} md={3}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Playback mode</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={mode}
              label="Playback mode"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({ defaultMode: e.target.value as 'direct' | 'direct-pipe' | 'direct-redirect' | 'ffmpeg' | 'hls' | 'hls-buffer' })
              }
              className="flex-1 min-w-0"
              disabled={disabled}
            >
              <MenuItem value="direct">Direct</MenuItem>
              <MenuItem value="direct-pipe">Direct (piped)</MenuItem>
              <MenuItem value="direct-redirect">Direct (redirect)</MenuItem>
              <MenuItem value="ffmpeg">Enhanced</MenuItem>
              <MenuItem value="hls">Enhanced HLS</MenuItem>
              <MenuItem value="hls-buffer">Enhanced HLS + Buffered</MenuItem>
            </Select>
            <InfoTooltip
              text={MODE_TOOLTIPS[mode] || MODE_TOOLTIPS.direct}
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      {modeCompat.container?.status !== 'ignored' && (
        <Grid item xs={12} sm={6} md={3}>
          <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
            <InputLabel>Container</InputLabel>
            <Box className="flex items-center gap-1">
              <Select
                value={ytstream.container || 'mp4'}
                label="Container"
                onChange={(e: SelectChangeEvent<string>) =>
                  setYtstream({ container: e.target.value as 'mp4' | 'ts' | 'mkv' })
                }
                className="flex-1 min-w-0"
                disabled={disabled || modeCompat.container?.status !== 'optional'}
              >
                <MenuItem value="mp4">MP4</MenuItem>
                <MenuItem value="ts">MPEG-TS</MenuItem>
                {mode !== 'hls' && mode !== 'hls-buffer' && (
                  <MenuItem value="mkv">Matroska</MenuItem>
                )}
              </Select>
              <InfoTooltip
                text={
                  'Matroska (mkv, Enhanced-only) accepts any video/audio codec pair - useful for Copy when the source isn\'t H.264.'
                  + (mode === 'hls-buffer'
                    ? ' For Enhanced HLS + Buffered: this only picks the live segment format - the permanent download is always MPEG-TS regardless.'
                    : '')
                }
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>
      )}

      <Grid item xs={12} sm={6} md={3}>
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
              <MenuItem value="">Auto</MenuItem>
              <MenuItem value="480">480p</MenuItem>
              <MenuItem value="720">720p</MenuItem>
              <MenuItem value="1080">1080p</MenuItem>
              <MenuItem value="1440">1440p</MenuItem>
              <MenuItem value="2160">4K</MenuItem>
              <MenuItem value="best">Best available</MenuItem>
            </Select>
            <InfoTooltip
              text="Maps to yt-dlp format selectors. Enhanced mode is capped at this height; Direct/Direct (piped) can only ever reach ~360p regardless - see Quality strictness for how a mismatch is handled."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      <Grid item xs={12} sm={6} md={3}>
        {/* No forcedFieldStyle here (unlike Playback mode/Container/Stream
            quality/Transcode above): strmGenerator.js never writes
            qualityStrictness into a .strm's URL at all, so Settings is
            always the only source for this regardless of Force these
            settings - there's no URL value for that toggle to actually
            override. */}
        <FormControl fullWidth>
          <InputLabel>Quality strictness</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={ytstream.qualityStrictness || 'fallback'}
              label="Quality strictness"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({ qualityStrictness: e.target.value as 'fixed' | 'fallback' | 'best' })
              }
              className="flex-1 min-w-0"
              disabled={disabled}
            >
              <MenuItem value="fallback">Fall back to lower resolution</MenuItem>
              <MenuItem value="fixed">Fixed</MenuItem>
              <MenuItem value="best">Best available</MenuItem>
            </Select>
            <InfoTooltip
              text="Controls how Stream quality's height becomes a request. Fall back (default) chains down to whatever's available. Fixed matches only that exact height and fails cleanly if this video doesn't have it. Best available ignores Stream quality and always takes the mode's real ceiling."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      {/* Row 2 - transcode method and calculated-length's seek/duration
          behavior. Hardware encoder/decode and Encoding tuning live down in
          Performance Optimizations below, alongside VAAPI compression
          level - one place for every hardware-related dial. */}
      {modeCompat.transcode?.status !== 'ignored' && (
        <Grid item xs={12} sm={6} md={3}>
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
                disabled={disabled || modeCompat.transcode?.status !== 'optional'}
              >
                <MenuItem value="">Auto (match download codec setting)</MenuItem>
                <MenuItem value="copy">Always remux (copy, no re-encode)</MenuItem>
                <MenuItem value="h264">Force re-encode (H.264/AAC)</MenuItem>
              </Select>
              <InfoTooltip
                text="Auto follows your download Video codec setting above (H.264/H.265 forces re-encode, otherwise behaves like Copy). Copy never re-encodes - fast, but whatever codec YouTube served isn't guaranteed compatible. H.264 always re-encodes for compatibility and is required for hardware acceleration below."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>
      )}

      {modeCompat.calculatedLength?.status !== 'ignored' && (
        <Grid item xs={12} sm={6} md={3}>
          <FormControl fullWidth style={forced || modeCompat.calculatedLength?.status === 'forced' ? forcedFieldStyle : undefined}>
            <InputLabel>Calculated length</InputLabel>
            <Box className="flex items-center gap-1">
              <Select
                value={modeCompat.calculatedLength?.status === 'forced' || ytstream.calculatedLength ? 'on' : 'off'}
                label="Calculated length"
                onChange={(e: SelectChangeEvent<string>) =>
                  setYtstream({ calculatedLength: e.target.value === 'on' })
                }
                className="flex-1 min-w-0"
                disabled={disabled || modeCompat.calculatedLength?.status !== 'optional'}
              >
                <MenuItem value="off">Off</MenuItem>
                <MenuItem value="on">On</MenuItem>
              </Select>
              {modeCompat.calculatedLength?.status === 'forced' && (
                <Chip label="Forced" size="small" color="warning" />
              )}
              <InfoTooltip
                text={
                  'Reports an estimated size/duration upfront and can answer seeks faster (approximately) by restarting at the estimated timestamp, instead of the response only ever growing until the real end is known.'
                  + (modeCompat.calculatedLength?.reason ? ` For the current Playback mode (${mode}): ${modeCompat.calculatedLength.reason}` : '')
                }
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>
      )}

      <Grid item xs={12}>
        <Alert severity='warning' style={{ marginBottom: 8 }}>
          <AlertTitle>Power user feature</AlertTitle>
          <Typography variant='body2'>
            Passed directly as yt-dlp&apos;s youtube:player_client extractor-arg on every stream request. An invalid or unsupported client value can break streaming entirely - leave blank unless streams are actually failing, and revert if problems appear.
          </Typography>
        </Alert>
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
            helperText='Leave blank for "default,-tv" (recommended). Try "android", "ios", "web,android", or "tv_embedded" if streams fail.'
          />
          <InfoTooltip
            text={
              'Passed as yt-dlp --extractor-args youtube:player_client=VALUE. The default excludes the "tv" client, the most common cause of YouTube\'s reload error. "android"/"ios" often resolve extraction failures other clients hit; "web,android" tries both in order; "tv_embedded" can help with age-restricted content.'
            }
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

      <Grid item xs={12} md={4}>
        <Box className="flex items-center gap-1">
          <FormControlLabel
            control={
              <Switch
                checked={ytstream.debugLogging ?? false}
                onChange={(e) => setYtstream({ debugLogging: e.target.checked })}
                disabled={disabled}
              />
            }
            label="Streaming debug logging"
          />
          <InfoTooltip
            text="Shows this file's own high-volume diagnostic logs (segment serves, playlist polls, buffer-fetch progress, etc.) at the normal log level, without needing global Log Level set to Debug - which would also show unrelated noise from every other module (e.g. the periodic database health check). Applies regardless of Playback mode."
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

      {/* Calculated length lives up in the forced-settings grid above,
          alongside Transcode - part of the same "how the encode pipeline
          behaves" group, not a performance optimization proper. Hardware
          encoder/decode, Encoding tuning, and VAAPI compression level all
          live here together - one place for every hardware-related dial,
          none of which are ever written into a .strm's URL (so none get
          forcedFieldStyle - Settings always decides these regardless of
          Force these settings). Instant start / Cache on play / Hot-swap to
          cached file / Revert-to-STRM also live here (moved from
          StrmSettingsSection's own "File Output" section) so every
          mode-gated field's visibility changes in one place on the page
          instead of two disconnected ones - see modeCompat's own comment
          above for why. */}

      {modeCompat.hardwareMode?.status !== 'ignored' && (
        <Grid item xs={12} sm={6} md={4}>
          <FormControl fullWidth>
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
                disabled={disabled || modeCompat.hardwareMode?.status !== 'optional'}
              >
                <MenuItem value="none">Software (libx264)</MenuItem>
                <MenuItem value="qsv">Intel Quick Sync (h264_qsv)</MenuItem>
                <MenuItem value="nvenc">NVIDIA NVENC (h264_nvenc)</MenuItem>
                <MenuItem value="vaapi">VAAPI (h264_vaapi)</MenuItem>
                <MenuItem value="amf">AMD AMF (h264_amf)</MenuItem>
              </Select>
              <InfoTooltip
                text="Used only when Playback mode is Enhanced and Transcode is H.264. Requires the matching ffmpeg build and GPU drivers on the Youtarr host (and device passthrough in Docker)."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>
      )}

      {modeCompat.hardwareMode?.status !== 'ignored' && (
        <Grid item xs={12} sm={6} md={4}>
          <FormControl fullWidth>
            <InputLabel>Hardware decode</InputLabel>
            <Box className="flex items-center gap-1">
              <Select
                value={ytstream.hardwareDecodeMode || 'none'}
                label="Hardware decode"
                onChange={(e: SelectChangeEvent<string>) =>
                  setYtstream({
                    hardwareDecodeMode: e.target.value as 'none' | 'qsv' | 'nvenc' | 'vaapi',
                  })
                }
                className="flex-1 min-w-0"
                disabled={disabled}
              >
                <MenuItem value="none">Software</MenuItem>
                <MenuItem value="qsv">Intel Quick Sync</MenuItem>
                <MenuItem value="nvenc">NVIDIA NVDEC</MenuItem>
                <MenuItem value="vaapi">VAAPI</MenuItem>
              </Select>
              <InfoTooltip
                text="Independent of Hardware encoder above - any combination is valid (e.g. software encode + hardware decode). Decodes the source video (often VP9/AV1 from YouTube) on the GPU instead of the CPU, before scaling/encoding proceed exactly as before. No 'AMD AMF' option here - AMD decode acceleration on this app's Linux runtime goes through VAAPI instead of a separate API. Test with 'Test real-time tuning' below (Simulate source codec) to see real decode+encode timing on this host."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>
      )}

      {modeCompat.tuning?.status !== 'ignored' && (
        <Grid item xs={12} sm={6} md={4}>
          <FormControl fullWidth>
            <InputLabel>Encoding tuning</InputLabel>
            <Box className="flex items-center gap-1">
              <Select
                value={ytstream.tuning || 'fast'}
                label="Encoding tuning"
                onChange={(e: SelectChangeEvent<string>) =>
                  setYtstream({ tuning: e.target.value as 'fast' | 'balanced' | 'quality' })
                }
                className="flex-1 min-w-0"
                disabled={disabled || modeCompat.tuning?.status !== 'optional'}
              >
                {[
                  { value: 'fast', label: 'Fast (real-time safe)' },
                  { value: 'balanced', label: 'Balanced' },
                  { value: 'quality', label: 'Quality' },
                ].map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    <Box className="flex items-center gap-1 justify-between w-full">
                      <span>{opt.label}</span>
                      {recommendedTierForCurrentQuality === opt.value && (
                        <Chip label="Recommended" size="small" color="success" />
                      )}
                    </Box>
                  </MenuItem>
                ))}
              </Select>
              <InfoTooltip
                text="Trades encode speed for picture quality at a given resolution/hardware encoder. 'Fast' is the safest choice for real-time streaming; 'Balanced'/'Quality' can fall behind on weaker hardware at higher resolutions. Run 'Test real-time tuning' below to see which tier is actually safe on this host."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>
      )}

      {currentHardwareMode === 'vaapi' && (
        <Grid item xs={12} sm={6} md={4}>
          {/* No forcedFieldStyle: vaapiQuality is never written into a
              .strm's URL - same reasoning as Hardware encoder above. */}
          <FormControl fullWidth>
            <InputLabel>VAAPI compression level</InputLabel>
            <Box className="flex items-center gap-1">
              <Select
                value={ytstream.vaapiQuality != null ? String(ytstream.vaapiQuality) : ''}
                label="VAAPI compression level"
                onChange={(e: SelectChangeEvent<string>) =>
                  setYtstream({ vaapiQuality: e.target.value === '' ? null : Number(e.target.value) })
                }
                className="flex-1 min-w-0"
                disabled={disabled}
              >
                <MenuItem value="">Auto (follows Encoding tuning: 7/4/1)</MenuItem>
                {[1, 2, 3, 4, 5, 6, 7].map((level) => (
                  <MenuItem key={level} value={String(level)}>
                    {level} {level === 1 ? '(best quality, slowest)' : level === 7 ? '(fastest, lowest quality)' : ''}
                  </MenuItem>
                ))}
              </Select>
              <InfoTooltip
                text="ffmpeg's own -quality (compression_level) knob for h264_vaapi, separate from Encoding tuning's -qp - on supporting drivers (notably Intel's iHD), this actually trades encode speed for quality. Each Encoding tuning tier already sets a sensible value on its own (Fast=7, Balanced=4, Quality=1); only change this to manually override that. Ignored on drivers that don't support it (e.g. AMD's Mesa radeonsi). The tuning benchmark above uses this same value."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>
      )}

      {modeCompat.instantStart?.status !== 'ignored' && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.instantStart ?? false}
                  onChange={(e) => setYtstream({ instantStart: e.target.checked })}
                  disabled={disabled || modeCompat.instantStart?.status !== 'optional'}
                />
              }
              label="Instant start"
            />
            <InfoTooltip
              text={
                'Normally the first response blocks until the real encode produces its first segment (10-25s is typical). When applicable, this serves a placeholder clip as segment 0 instead - the video\'s own thumbnail with a \'Loading...\' overlay if cached, otherwise a generic pattern - so playback starts instantly while the real encode catches up.'
                + (modeCompat.instantStart?.reason ? ` For the current Playback mode (${mode}): ${modeCompat.instantStart.reason}` : '')
              }
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {modeCompat.cacheOnPlay?.status !== 'ignored' && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={cacheOnPlay}
                  onChange={(e) => setStrm({ cacheOnPlay: e.target.checked })}
                  disabled={disabled}
                />
              }
              label="Cache on play"
            />
            <InfoTooltip
              text={
                'When a STRM item is played, enqueue a real background download so later plays use a cached file instead of live proxying. Pairs with Automatic Video Removal, which can revert a cached video back to STRM instead of deleting it.'
                + (modeCompat.cacheOnPlay?.reason ? ` For the current Playback mode (${mode}): ${modeCompat.cacheOnPlay.reason}` : '')
              }
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {modeCompat.hotSwapToCache?.status !== 'ignored' && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.hotSwapToCache ?? false}
                  onChange={(e) => setYtstream({ hotSwapToCache: e.target.checked })}
                  disabled={disabled || modeCompat.hotSwapToCache?.status !== 'optional'}
                />
              }
              label="Hot-swap to cached file"
            />
            <InfoTooltip
              text={
                'If the Cache on play download finishes while this video is still playing, the session switches to producing the rest from the local file instead of the network - same picture, no restart, just faster. Has no effect unless Cache on play is also enabled.'
                + (modeCompat.hotSwapToCache?.reason ? ` For the current Playback mode (${mode}): ${modeCompat.hotSwapToCache.reason}` : '')
              }
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {((modeCompat.cacheOnPlay?.status !== 'ignored' && cacheOnPlay) || mode === 'hls-buffer') && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <TextField
              fullWidth
              type="number"
              label="Revert to STRM after (hours)"
              name="cacheOnPlayExpiryHours"
              value={config.strm?.cacheOnPlayExpiryHours ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  setStrm({ cacheOnPlayExpiryHours: null });
                  return;
                }
                const parsed = Number.parseInt(raw, 10);
                setStrm({ cacheOnPlayExpiryHours: Number.isFinite(parsed) && parsed > 0 ? parsed : null });
              }}
              disabled={disabled}
              placeholder="Never"
              helperText="Blank = never auto-expire. A nightly sweep (2:10 AM) checks cache-on-play downloads and Enhanced HLS + Buffered's untracked-video cache files for anything older than this."
              inputProps={{ min: 1 }}
            />
            <InfoTooltip
              text="How long a cache-on-play download stays a real file before Youtarr auto-reverts it back to STRM (never touches a genuine/forced download, regardless of age) - and, separately, how long Enhanced HLS + Buffered's untracked-video cache files (no library entry to revert, so these are just deleted) are kept before the same nightly sweep removes them. One setting governs both."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {modeCompat.probeShortcut?.status !== 'ignored' && (
        <Grid item xs={12} md={4}>
          {/* No forcedFieldStyle: probeShortcut is read straight from config
              with no query-string override path at all (see
              evaluateProbeShortcut) and is never written into a .strm's
              URL - Settings has always been the only source for this. */}
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.probeShortcut ?? false}
                  onChange={(e) => setYtstream({ probeShortcut: e.target.checked })}
                  disabled={disabled || modeCompat.probeShortcut?.status !== 'optional'}
                />
              }
              label="Probe shortcut"
            />
            <InfoTooltip
              text={
                'A media server\'s metadata probe (Jellyfin\'s ffprobe, etc.) hitting a .strm can trigger real work against YouTube just to read codec info. Every .strm this app writes carries a marker that lets the server detect a probe regardless of this setting; the toggle only controls what happens once one IS detected - on serves a tiny cached clip instead, off treats it like any other request.'
                + (modeCompat.probeShortcut?.reason ? ` For the current Playback mode (${mode}): ${modeCompat.probeShortcut.reason}` : '')
                + ' Existing .strm files need to be rewritten (re-download, or a channel resync) to pick up the marker.'
              }
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
        <HardwareTestingAccordion
          matrix={hardwareMatrix}
          decodeMatrix={hardwareDecodeMatrix}
          testing={testingHardware}
          error={hardwareTestError}
          onRunTest={runHardwareTest}
          onMobileTooltipClick={onMobileTooltipClick}
        />
      </Grid>

      <Grid item xs={12}>
        <Accordion style={{ border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}>
          <AccordionSummary>
            <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
              Encoding &amp; Decoding Tuning
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <TuningBenchmarkTable
                  hardwareMode={currentHardwareMode}
                  decodeMode={ytstream.hardwareDecodeMode || 'none'}
                  matrix={tuningMatrix}
                  recommended={tuningRecommended}
                  resultHardwareMode={tuningResultHardwareMode}
                  resultDecodeMode={tuningResultDecodeMode}
                  resultSourceCodec={tuningResultSourceCodec}
                  resultVideoCodec={tuningResultVideoCodec}
                  resultDecodeSourceHeight={tuningResultDecodeSourceHeight}
                  progress={tuningProgress}
                  testing={testingTuning}
                  error={tuningTestError}
                  onRunTest={(sourceCodec, videoCodec, decodeSourceHeight) => runTuningBenchmark(currentHardwareMode, ytstream.vaapiQuality, ytstream.hardwareDecodeMode || 'none', sourceCodec, videoCodec, decodeSourceHeight)}
                  disabledReason={tuningTestDisabledReason}
                  onMobileTooltipClick={onMobileTooltipClick}
                />
                <TuningHistoryTable history={tuningHistory} />
              </Grid>
              <Grid item xs={12}>
                <Divider className="my-1" />
                <SegmentTimingTestButton
                  hardwareMode={currentHardwareMode}
                  currentlyEnabled={(ytstream.forceKeyframesByHardwareMode || {})[currentHardwareMode] === true}
                  testing={testingSegmentTiming}
                  result={segmentTimingResult}
                  error={segmentTimingError}
                  onRunTest={() => runSegmentTimingTest(currentHardwareMode, ytstream.vaapiQuality)}
                  onMobileTooltipClick={onMobileTooltipClick}
                />
              </Grid>
            </Grid>
          </AccordionDetails>
        </Accordion>
      </Grid>

      <Grid item xs={12}>
        <Divider className="my-2" />
        <Typography variant="subtitle2" color="textSecondary" className="mb-1">
          Storage &amp; background processing
        </Typography>
      </Grid>

      <Grid item xs={12} md={4}>
        <Box className="flex items-center gap-1">
          <FormControl fullWidth disabled={disabled}>
            <InputLabel>HLS segment storage</InputLabel>
            <Select
              label="HLS segment storage"
              value={ytstream.hlsStorageLocation || 'tmp'}
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({ hlsStorageLocation: e.target.value as 'tmp' | 'cache' })
              }
            >
              <MenuItem value="tmp">OS temp directory (default)</MenuItem>
              <MenuItem value="cache">Youtarr's persistent cache folder</MenuItem>
            </Select>
          </FormControl>
          <InfoTooltip
            text="Where a live session's segment files are written. OS temp directory is fastest but can be small/volatile; Youtarr's persistent cache folder avoids that. Either way segments are cleaned up on the same idle schedule - this only changes where they live."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

      {modeCompat.backfillMissingSegments?.status !== 'ignored' && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.backfillMissingSegments ?? false}
                  onChange={(e) => setYtstream({ backfillMissingSegments: e.target.checked })}
                  disabled={disabled || modeCompat.backfillMissingSegments?.status !== 'optional'}
                />
              }
              label="Backfill missing segments"
            />
            <InfoTooltip
              text={
                'A forward seek permanently skips whatever segments lie in between. When on, once encoding reaches the real end, a background pass (local source only) fills those gaps so the rest of the session can seek anywhere instantly. Never affects live playback itself.'
                + (modeCompat.backfillMissingSegments?.reason ? ` For the current Playback mode (${mode}): ${modeCompat.backfillMissingSegments.reason}` : '')
              }
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      {modeCompat.finalizeToMp4?.status !== 'ignored' && (
        <Grid item xs={12} md={4}>
          <Box className="flex items-center gap-1">
            <FormControlLabel
              control={
                <Switch
                  checked={ytstream.finalizeToMp4 ?? false}
                  onChange={(e) => setYtstream({ finalizeToMp4: e.target.checked })}
                  disabled={disabled || modeCompat.finalizeToMp4?.status !== 'optional'}
                />
              }
              label="Finalize .ts to .mp4"
            />
            <InfoTooltip
              text={
                'Browsers and some players (Jellyfin included) can\'t direct-play raw .ts. When on, once this mode\'s permanent .ts is fully finalized, a background pass remuxes it (no re-encode) into a sibling .mp4 - playback prefers that .mp4 automatically once it exists.'
                + (modeCompat.finalizeToMp4?.reason ? ` For the current Playback mode (${mode}): ${modeCompat.finalizeToMp4.reason}` : '')
              }
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>
      )}

      <Grid item xs={12}>
        <Divider className="my-2" />
        <Typography variant="subtitle2" color="textSecondary" className="mb-1">
          History
        </Typography>
      </Grid>

      <Grid item xs={12} md={4}>
        <Box className="flex items-center gap-1">
          <TextField
            fullWidth
            type="number"
            label="History retention (days)"
            name="ytstreamHistoryRetentionDays"
            value={String(ytstream.historyRetentionDays ?? 90)}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              setYtstream({ historyRetentionDays: Number.isFinite(parsed) && parsed > 0 ? parsed : 90 });
            }}
            disabled={disabled}
            helperText="Stream history entries older than this are pruned nightly."
            inputProps={{ min: 1 }}
          />
          <InfoTooltip
            text="How long Streaming -> History keeps past playback sessions before a nightly prune (3:15 AM). Doesn't affect the live Streaming page, which only shows currently-active sessions."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

      <Grid item xs={12} md={4}>
        <Box className="flex items-center gap-1">
          <Typography variant="body2">
            Untracked buffer cache: {untrackedCacheFileCount === null ? '…' : `${untrackedCacheFileCount} file${untrackedCacheFileCount === 1 ? '' : 's'}, ${formatFileSize(untrackedCacheTotalBytes ?? 0) || '0MB'}`}
          </Typography>
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DeleteIcon size={14} />}
            disabled={!untrackedCacheFileCount || clearingUntrackedCache}
            onClick={() => setConfirmClearUntrackedCache(true)}
          >
            Delete
          </Button>
          <InfoTooltip
            text="Buffered modes save a finished download here instead of the library whenever the video has no library entry to attach to (e.g. an untracked NZB grab) - a same-video speed-up, never shown in the library. Safe to delete anytime; a later replay just re-fetches."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
        {untrackedCacheError && (
          <Typography variant="caption" color="error">{untrackedCacheError}</Typography>
        )}
      </Grid>

      <Grid item xs={12} md={4}>
        <Box className="flex items-center gap-1">
          <Typography variant="body2">
            Cached video metadata: {metadataCacheCount === null ? '…' : `${metadataCacheCount} video${metadataCacheCount === 1 ? '' : 's'}`}
          </Typography>
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DeleteIcon size={14} />}
            disabled={!metadataCacheCount || clearingMetadataCache}
            onClick={() => setConfirmClearMetadataCache(true)}
          >
            Delete
          </Button>
          <InfoTooltip
            text="Per-video fps/duration/etc. learned from yt-dlp (via streaming, download, or STRM generation) so later streams of the same video skip a live yt-dlp lookup. Safe to delete anytime; each video relearns its info the next time it's streamed, downloaded, or STRM-generated."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
        {metadataCacheError && (
          <Typography variant="caption" color="error">{metadataCacheError}</Typography>
        )}
      </Grid>

      <Dialog open={confirmClearMetadataCache} onClose={() => setConfirmClearMetadataCache(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <WarningIcon size={20} color="var(--warning)" className="shrink-0" />
          Delete Cached Video Metadata
        </DialogTitle>
        <DialogContent>
          <div className="space-y-4">
            <Alert severity="warning">
              <Typography variant="body2">
                You are about to permanently delete cached metadata for {metadataCacheCount ?? 0} video{metadataCacheCount === 1 ? '' : 's'}. Each one relearns its info (a live yt-dlp lookup) the next time it's streamed, downloaded, or STRM-generated.
              </Typography>
            </Alert>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClearMetadataCache(false)} variant="contained" color="primary" autoFocus>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setConfirmClearMetadataCache(false);
              clearMetadataCache();
            }}
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon size={16} />}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmClearUntrackedCache} onClose={() => setConfirmClearUntrackedCache(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <WarningIcon size={20} color="var(--warning)" className="shrink-0" />
          Delete Untracked Buffer Cache
        </DialogTitle>
        <DialogContent>
          <div className="space-y-4">
            <Alert severity="warning">
              <Typography variant="body2">
                You are about to permanently delete {untrackedCacheFileCount ?? 0} cached file{untrackedCacheFileCount === 1 ? '' : 's'} ({formatFileSize(untrackedCacheTotalBytes ?? 0) || '0MB'}). A later replay of any of these videos re-fetches from scratch instead of using this speed-up.
              </Typography>
            </Alert>
            <Typography variant="body2" color="text.secondary">
              This action cannot be undone.
            </Typography>
          </div>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClearUntrackedCache(false)} variant="contained" color="primary" autoFocus>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setConfirmClearUntrackedCache(false);
              clearUntrackedCache();
            }}
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon size={16} />}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

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
