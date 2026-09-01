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
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from '../../ui';
import { InfoTooltip } from '../common/InfoTooltip';
import { ConfigState } from '../types';
import { useHardwareCapabilities } from '../hooks/useHardwareCapabilities';
import { useTuningBenchmark } from '../hooks/useTuningBenchmark';
import { HardwareCapabilitiesTable } from './components/HardwareCapabilitiesTable';
import { TuningBenchmarkTable } from './components/TuningBenchmarkTable';
import { TuningHistoryTable } from './components/TuningHistoryTable';

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
  tuning: 'fast',
  playerClient: '',
  calculatedLength: false,
  hotSwapToCache: false,
  serveCachedFile: false,
  instantStart: false,
  probeShortcut: false,
  forceServerSettings: false,
  historyRetentionDays: 90,
};

// Each mode's real limitation, stated plainly - see resolvePlaybackPlan's
// execution steps (server/routes/ytstream.js) for the same information in
// dry-run form. No mode falls back to a different mode's behavior; each
// either works as described or fails outright (502).
const MODE_TOOLTIPS: Record<string, string> = {
  direct: 'Resolves a playback URL via yt-dlp, then proxies it directly - no ffmpeg, no re-encode. Progressive-only: YouTube currently serves exactly one muxed video+audio format for virtually any video (~360p), so Stream quality rarely changes anything here. If the resolved URL is rejected (a session-bound "vprv" 403), this mode just fails - no automatic retry beyond the same-request extraction-error retry. Use Direct (yt-dlp piped) if you want resilience against that specific failure instead.',
  'direct-pipe': 'Same progressive-only ceiling as Direct (effectively ~360p), but fetches through yt-dlp\'s own process instead of proxying a separately-resolved URL - survives the session-bound-URL 403 plain Direct can\'t recover from. Trade-off: no Range/seek support, since this is a live sequential pipe, not a byte-range fetch - a seek restarts playback from 0. Still zero ffmpeg, zero re-encode.',
  'direct-redirect': 'Resolves a playback URL via yt-dlp, then sends the player a 302 straight to it - Youtarr never touches the video bytes at all, the lightest mode on Youtarr\'s own bandwidth/CPU. Real trade-offs: no cookies/Referer/User-Agent travel with the redirect, so age-restricted or members-only videos (which need those) fail outright for a player that can\'t supply them; a session-bound "vprv" URL is if anything more likely to 403 here than under Direct, since the fetch now comes from the player\'s own network entirely; and whatever happens after the redirect is invisible to Youtarr - a failure here never reaches this server\'s logs.',
  ffmpeg: 'Re-streams through a single live ffmpeg connection fed by yt-dlp\'s DASH (video-only + audio-only) formats - real quality up to whatever height this video truly has, not capped by progressive-format availability. Requires ffmpeg installed and working on the Youtarr host - if it isn\'t, this mode fails outright (502); it does not silently fall back to Direct.',
  hls: 'Same DASH-based quality ceiling as Enhanced, but writes real segment files to local disk instead of a live pipe, only responding once the first segment exists - fixes players (Jellyfin included) that won\'t tolerate the live pipe\'s startup wait. Costs local disk space per active stream. Same ffmpeg-required, no-fallback rule as Enhanced.',
  'hls-tap': 'Same DASH-based quality ceiling and disk cost as Enhanced HLS - but the same ffmpeg process also writes a second, untouched full-quality copy (-c copy, no re-encode, no scaling) straight to disk from the same yt-dlp video/audio pipes, before any Transcode/Container filtering is applied - no second network pull, and not a copy of the scaled-down stream. That file becomes this video\'s permanent downloaded copy once the whole video has played through once, uninterrupted, without a seek. Replaces STRM cache-on-play entirely for videos played this way - that separate background download is skipped whenever this mode\'s tap is active for a play. Limitation: only the very first, un-seeked play-through of a session can produce a complete file - if the very first request already starts mid-video (e.g. a media server resuming playback), or the viewer seeks before the video ends, the partial tap is discarded, not saved, and normal STRM cache-on-play (if enabled) picks it up instead. Same ffmpeg-required, no-fallback rule as Enhanced.',
  'hls-buffer': 'Same DASH-based quality ceiling as Enhanced HLS - but instead of tapping the live encode, a completely independent yt-dlp+ffmpeg pull starts immediately and fetches the whole video once, unthrottled by anything the live stream is doing, remuxing it into a local MPEG-TS buffer file (a hard requirement of this mechanism - see the Container tooltip). Playback itself starts exactly like Enhanced HLS - network-sourced, no extra wait, so instant-start (if enabled) behaves identically. Only a later seek (or, with Calculated length on, catching up to a gap) waits briefly for the buffer to have already reached that point before reading it directly instead of pulling from the network again - fast once buffered. Once the fetch finishes, that MPEG-TS file becomes this video\'s permanent downloaded copy (always .ts, regardless of the Container setting below - only Tap-to-Download\'s permanent file follows Container) and STRM cache-on-play is skipped for this play, same as Tap-to-Download - but without Tap\'s limitation: the fetch keeps running and still finishes even if you seek early or stop watching partway through. For a video Youtarr doesn\'t itself catalogue (e.g. an NZB grab Sonarr/Radarr owns) there\'s no library entry to attach that permanent copy to, so it lands in Youtarr\'s own untracked-buffer cache instead - not visible in the library or Download History, but still reused automatically (skips the network fetch entirely) the next time that same video plays. Same ffmpeg-required, no-fallback rule as Enhanced.',
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
  const {
    testing: testingTuning,
    progress: tuningProgress,
    matrix: tuningMatrix,
    recommended: tuningRecommended,
    resultHardwareMode: tuningResultHardwareMode,
    history: tuningHistory,
    error: tuningTestError,
    runBenchmark: runTuningBenchmark,
  } = useTuningBenchmark(token);

  const setYtstream = (patch: Partial<YtstreamConfig>) => {
    onConfigChange({ ytstream: { ...ytstream, ...patch } });
  };

  const mode = ytstream.defaultMode || 'direct';
  // Container/transcode/hardware apply to both ffmpeg-mode's live pipe and
  // hls-mode's segmented output. calculatedLength applies to both too, but
  // means different things — see the checkbox's tooltip below.
  const enhancedMode = mode === 'ffmpeg' || mode === 'hls' || mode === 'hls-tap' || mode === 'hls-buffer';
  const forceH264 = ytstream.transcode === 'h264';
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
            text="Playback requests can carry their own mode/quality/container/transcode/hardware/calculated-length — either a caller's own URL, or values baked into a .strm file's URL back when it was written. When on, the highlighted settings below are always used as-is instead, even if they've changed since older .strm files were written."
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
                setYtstream({ defaultMode: e.target.value as 'direct' | 'direct-pipe' | 'direct-redirect' | 'ffmpeg' | 'hls' | 'hls-tap' | 'hls-buffer' })
              }
              className="flex-1 min-w-0"
              disabled={disabled}
            >
              <MenuItem value="direct">Direct</MenuItem>
              <MenuItem value="direct-pipe">Direct (piped)</MenuItem>
              <MenuItem value="direct-redirect">Direct (redirect)</MenuItem>
              <MenuItem value="ffmpeg">Enhanced</MenuItem>
              <MenuItem value="hls">Enhanced HLS</MenuItem>
              <MenuItem value="hls-tap">Enhanced HLS + Tap</MenuItem>
              <MenuItem value="hls-buffer">Enhanced HLS + Buffered</MenuItem>
            </Select>
            <InfoTooltip
              text={MODE_TOOLTIPS[mode] || MODE_TOOLTIPS.direct}
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

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
              disabled={disabled || !enhancedMode}
            >
              <MenuItem value="mp4">MP4</MenuItem>
              <MenuItem value="ts">MPEG-TS</MenuItem>
              {mode !== 'hls' && mode !== 'hls-tap' && mode !== 'hls-buffer' && (
                <MenuItem value="mkv">Matroska</MenuItem>
              )}
            </Select>
            <InfoTooltip
              text={
                'Matroska (mkv) is Enhanced (ffmpeg) mode only, not offered for Enhanced HLS - HLS segments must be fMP4 or MPEG-TS. Useful for Transcode=Copy when the source track isn\'t H.264: unlike MP4, Matroska\'s muxer accepts essentially any video/audio codec pair without container-specific signaling concerns.'
                + (mode === 'hls-buffer'
                  ? ' Note for Enhanced HLS + Buffered Download: this only picks the live segment format. The permanent downloaded file this mode produces is always saved as MPEG-TS regardless of this setting (a hard requirement of the buffer-fetch mechanism, unlike Tap-to-Download, which does follow this setting) - see the Playback mode tooltip.'
                  : '')
              }
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

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
              text="Maps to yt-dlp format selectors used by the Jellyfin YouTube plugin: 720 = progressive MP4, 1080 = balanced, best = maximum quality. Enhanced mode uses separate AVC+AAC inputs capped at this height; Direct/Direct (piped) can only ever reach whatever progressive (muxed) format YouTube actually serves for a video, which today is effectively just ~360p regardless of this setting - see Quality strictness for how a mismatch is handled."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      <Grid item xs={12} sm={6} md={3}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
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
              text="Controls how Stream quality's configured height is turned into a request. Fall back to lower resolution (default, unchanged behavior) chains from the exact height down to whatever's actually available. Fixed matches only that exact height and fails cleanly (no silent substitution) if this video doesn't have it - honest but likely to fail often in Direct/Direct (piped) mode, since YouTube serves almost no heights progressively other than ~360p. Best available ignores Stream quality entirely and always takes the mode's real ceiling (the best progressive format for Direct/Direct (piped), the video's true best DASH height for Enhanced/Enhanced HLS)."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      {/* Row 2 - how the encode pipeline behaves: transcode method, hardware,
          tuning, and calculated-length's seek/duration behavior. */}
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

      <Grid item xs={12} sm={6} md={3}>
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

      <Grid item xs={12} sm={6} md={3}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Encoding tuning</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={ytstream.tuning || 'fast'}
              label="Encoding tuning"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({ tuning: e.target.value as 'fast' | 'balanced' | 'quality' })
              }
              className="flex-1 min-w-0"
              disabled={disabled || !enhancedMode || !forceH264}
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
              text="Trades encode speed for picture quality at a given resolution/hardware encoder. 'Fast' is this app's long-standing default and the safest choice for real-time HLS/live-pipe streaming; 'Balanced'/'Quality' push CRF/QP lower and presets slower, which can fall behind real time on weaker hardware at higher resolutions. Run the 'Test real-time tuning' benchmark below to see which tier is actually safe on this host, per resolution — the recommended tier (based on the current Hardware encoder and Stream quality) is marked above once benchmarked."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
      </Grid>

      <Grid item xs={12} sm={6} md={3}>
        <FormControl fullWidth style={forced ? forcedFieldStyle : undefined}>
          <InputLabel>Calculated length</InputLabel>
          <Box className="flex items-center gap-1">
            <Select
              value={ytstream.calculatedLength ? 'on' : 'off'}
              label="Calculated length"
              onChange={(e: SelectChangeEvent<string>) =>
                setYtstream({ calculatedLength: e.target.value === 'on' })
              }
              className="flex-1 min-w-0"
              disabled={disabled || !enhancedMode}
            >
              <MenuItem value="off">Off</MenuItem>
              <MenuItem value="on">On</MenuItem>
            </Select>
            <InfoTooltip
              text="Enhanced modes only. In Enhanced (ffmpeg): reports an estimated file size/duration and answers seek (Range) requests by restarting the live pipe at the matching estimated timestamp — the estimate is approximate, seeking has the same multi-second restart latency as a cold start, and playback near the very end can show a few seconds of silence if the real encode finished early. In Enhanced HLS: builds the real, exact-duration playlist upfront (no estimate) so the player sees a full seekable timeline immediately; seeking past what's been encoded so far restarts the encode at that segment instead of the whole stream, which is faster and only ever approximate for the segment currently being (re)encoded. Off, HLS still plays fine but the timeline only grows as segments are produced, so some players won't show a scrub bar until near the end."
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </FormControl>
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

      {/* Calculated length now lives up in the forced-settings grid above,
          as a dropdown alongside Transcode/Hardware encoder/Encoding tuning
          - it's part of the same "how the encode pipeline behaves" group,
          not a performance optimization proper. Instant start / Cache on
          play / Hot-swap to cached file live together in
          StrmSettingsSection's "File Output" area - they're all about
          serving from a file (a placeholder segment, a cached download, or
          a hot-swapped local file) rather than a playback setting proper.
          That leaves Probe shortcut as the only thing here. */}

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
        <Accordion style={{ border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}>
          <AccordionSummary>
            <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
              Hardware Testing &amp; Tuning
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <HardwareCapabilitiesTable
                  matrix={hardwareMatrix}
                  testing={testingHardware}
                  error={hardwareTestError}
                  onRunTest={runHardwareTest}
                  onMobileTooltipClick={onMobileTooltipClick}
                />
              </Grid>

              <Grid item xs={12}>
                <TuningBenchmarkTable
                  hardwareMode={currentHardwareMode}
                  matrix={tuningMatrix}
                  recommended={tuningRecommended}
                  resultHardwareMode={tuningResultHardwareMode}
                  progress={tuningProgress}
                  testing={testingTuning}
                  error={tuningTestError}
                  onRunTest={() => runTuningBenchmark(currentHardwareMode)}
                  disabledReason={tuningTestDisabledReason}
                  onMobileTooltipClick={onMobileTooltipClick}
                />
                <TuningHistoryTable history={tuningHistory} />
              </Grid>
            </Grid>
          </AccordionDetails>
        </Accordion>
      </Grid>

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
            text="How long Settings -> Streaming -> History keeps past playback sessions (server/models/streamhistory.js). A nightly job (3:15 AM) deletes anything older than this. Doesn't affect the live Streaming page, which only ever shows currently-active sessions."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </Grid>

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
