import React, { ChangeEvent } from 'react';
import {
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
  TextField,
  Grid,
  Box,
  Typography,
  Divider,
  SelectChangeEvent,
} from '../../ui';
import { ConfigurationCard } from '../common/ConfigurationCard';
import { InfoTooltip } from '../common/InfoTooltip';
import { ConfigState } from '../types';
import { YtstreamSettingsSection, DEFAULT_YTSTREAM } from './YtstreamSettingsSection';

interface Props {
  config: ConfigState;
  onConfigChange: (updates: Partial<ConfigState>) => void;
  onMobileTooltipClick?: (text: string) => void;
  token: string | null;
}

export const StrmSettingsSection: React.FC<Props> = ({
  config,
  onConfigChange,
  onMobileTooltipClick,
  token,
}) => {
  const strm = config.strm || {
    target: 'ytstream',
    proxyBaseUrl: '',
    writeNfo: true,
    writeThumbnail: true,
    writeMediaInfoCache: true,
    cacheOnPlay: false,
    quality: null,
  };

  const setStrm = (patch: Partial<typeof strm>) => {
    onConfigChange({ strm: { ...strm, ...patch } });
  };

  const ytstream = config.ytstream || DEFAULT_YTSTREAM;
  const setYtstream = (patch: Partial<ConfigState['ytstream']>) => {
    onConfigChange({ ytstream: { ...ytstream, ...patch } });
  };
  // Instant start and Hot-swap to cached file are Enhanced HLS-only (see
  // their tooltips below) - mirrors the same mode/forceH264 gating
  // YtstreamSettingsSection uses for its own fields.
  const ytstreamMode = ytstream.defaultMode || 'direct';
  const ytstreamForceH264 = ytstream.transcode === 'h264';

  const mediaIsDownload = (config.mediaMode || 'download') === 'download';
  const ytstreamSelected = strm.target === 'ytstream';

  return (
    <ConfigurationCard title="STRM (stream-only)">
      <Grid container spacing={2} className="mt-2">
        <Grid item xs={12}>
          <Typography variant="subtitle2" color="textSecondary" className="mb-1">
            Media Mode &amp; Target
          </Typography>
        </Grid>

        <Grid item xs={12} md={6}>
          <FormControl fullWidth>
            <InputLabel>Media mode</InputLabel>
            <Box className="flex items-center gap-1">
              <Select
                value={config.mediaMode || 'download'}
                label="Media mode"
                onChange={(e: SelectChangeEvent<string>) =>
                  onConfigChange({ mediaMode: e.target.value as ConfigState['mediaMode'] })
                }
                className="flex-1 min-w-0"
              >
                <MenuItem value="download">Download full files (default)</MenuItem>
                <MenuItem value="strm">STRM only (no media download)</MenuItem>
                <MenuItem value="both">Both (download + STRM)</MenuItem>
              </Select>
              <InfoTooltip
                text="STRM only writes .strm (+ NFO/thumb) so Jellyfin streams on demand. Download keeps current behavior."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>

        <Grid item xs={12} md={6}>
          <FormControl fullWidth>
            <InputLabel>STRM target</InputLabel>
            <Box className="flex items-center gap-1">
              <Select
                value={strm.target || 'ytstream'}
                label="STRM target"
                onChange={(e: SelectChangeEvent<string>) =>
                  setStrm({ target: e.target.value as 'youtube' | 'ytstream' })
                }
                className="flex-1 min-w-0"
                disabled={mediaIsDownload}
              >
                <MenuItem value="ytstream">Youtarr direct/ffmpeg (/api/ytstream/:id)</MenuItem>
                <MenuItem value="youtube">YouTube watch URL</MenuItem>
              </Select>
              <InfoTooltip
                text="Direct/ffmpeg resolves and streams via /api/ytstream when played (redirect or ffmpeg re-mux). YouTube puts the watch URL in the .strm (client must handle YouTube)."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>

        {ytstreamSelected && (
          <Grid item xs={12}>
            <Box className="flex items-center gap-1">
              <FormControlLabel
                control={
                  <Switch
                    checked={ytstream.serveCachedFile ?? false}
                    onChange={(e) => setYtstream({ serveCachedFile: e.target.checked })}
                    disabled={mediaIsDownload}
                  />
                }
                label="Serve already-downloaded files directly"
              />
              <InfoTooltip
                text="Checked on every /api/ytstream request, before anything else - if this video is already fully downloaded (via STRM cache-on-play, or any genuine download), the real local file is served directly with real Range/seek support, instead of live-proxying or transcoding it all over again through yt-dlp/ffmpeg. Off by default; safe to enable any time - it never affects a video that's still STRM-only, and Jellyfin never needs to rescan for this to take effect since it's the same /api/ytstream URL either way, just answered faster once a real file exists."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </Grid>
        )}

        <Grid item xs={12}>
          <Box className="flex items-center gap-1">
            <TextField
              fullWidth
              label="Base URL"
              name="proxyBaseUrl"
              value={strm.proxyBaseUrl || ''}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setStrm({ proxyBaseUrl: e.target.value })
              }
              placeholder="http://192.168.1.10:3087"
              disabled={mediaIsDownload || strm.target !== 'ytstream'}
              helperText="Must be reachable by Jellyfin (LAN IP or reverse proxy). Not 127.0.0.1 unless Jellyfin shares the host."
            />
            <InfoTooltip
              text="Written into each .strm when target is ytstream. Example: http://192.168.1.10:3087"
              onMobileClick={onMobileTooltipClick}
            />
          </Box>
        </Grid>

        {ytstreamSelected && (
          <Grid item xs={12}>
            <Divider className="my-2" />
            <YtstreamSettingsSection
              config={config}
              onConfigChange={onConfigChange}
              onMobileTooltipClick={onMobileTooltipClick}
              disabled={mediaIsDownload}
              token={token}
            />
          </Grid>
        )}

        <Grid item xs={12}>
          <Divider className="my-2" />
          <Typography variant="subtitle2" color="textSecondary" className="mb-1">
            File Output
          </Typography>
        </Grid>

        <Grid item xs={12} md={4}>
          <FormControlLabel
            control={
              <Switch
                checked={strm.writeNfo !== false}
                onChange={(e) => setStrm({ writeNfo: e.target.checked })}
                disabled={mediaIsDownload}
              />
            }
            label="Write NFO with STRM"
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <FormControlLabel
            control={
              <Switch
                checked={strm.writeThumbnail !== false}
                onChange={(e) => setStrm({ writeThumbnail: e.target.checked })}
                disabled={mediaIsDownload}
              />
            }
            label="Write thumbnail with STRM"
          />
        </Grid>

        {ytstreamSelected && (
          <Grid item xs={12} md={4}>
            <Box className="flex items-center gap-1">
              <FormControlLabel
                control={
                  <Switch
                    checked={strm.writeMediaInfoCache !== false}
                    onChange={(e) => setStrm({ writeMediaInfoCache: e.target.checked })}
                    disabled={mediaIsDownload}
                  />
                }
                label="Write Jellyfin StrmTool cache"
              />
              <InfoTooltip
                text="Writes a .strmtool.json sidecar (duration, codecs, resolution) next to each .strm so the jinlin-teck/StrmTool Jellyfin plugin can skip probing the stream. Requires that plugin installed in Jellyfin; harmless without it."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </Grid>
        )}

        {ytstreamSelected && (ytstreamMode === 'hls' || ytstreamMode === 'hls-tap' || ytstreamMode === 'hls-buffer') && (
          <Grid item xs={12} md={4}>
            <Box className="flex items-center gap-1">
              <FormControlLabel
                control={
                  <Switch
                    checked={ytstream.instantStart ?? false}
                    onChange={(e) => setYtstream({ instantStart: e.target.checked })}
                    disabled={mediaIsDownload || !ytstream.calculatedLength || !ytstreamForceH264}
                  />
                }
                label="Instant start"
              />
              <InfoTooltip
                text="Enhanced HLS (or Tap-to-Download / Buffered Download) + Calculated length + Transcode=H.264 only. Normally the very first response blocks until the real encode produces its first segment (10-25s is typical for a cold start). This serves a short placeholder clip as segment 0 instead - the video's own thumbnail with a 'Loading...' overlay when it's already cached locally, otherwise a generic moving test pattern - so playback starts within milliseconds while the real encode catches up in the background. Generated once per video/codec/hardware combination and reused after that. No effect for Transcode=Copy, since no single placeholder could match every video's own passthrough codec."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </Grid>
        )}

        {ytstreamSelected && (
          <Grid item xs={12} md={4}>
            <Box className="flex items-center gap-1">
              <FormControlLabel
                control={
                  <Switch
                    checked={strm.cacheOnPlay === true}
                    onChange={(e) => setStrm({ cacheOnPlay: e.target.checked })}
                    disabled={mediaIsDownload}
                  />
                }
                label="Cache on play"
              />
              <InfoTooltip
                text="When a STRM item is played, enqueue a real background download of it (same pipeline as a manual download) so later plays use a cached file instead of live proxying. Uses disk space; off by default. Pairs with the Automatic Video Removal settings, which can revert a cached video back to STRM instead of deleting it outright."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </Grid>
        )}

        {ytstreamSelected && ytstreamMode === 'hls' && (
          <Grid item xs={12} md={4}>
            <Box className="flex items-center gap-1">
              <FormControlLabel
                control={
                  <Switch
                    checked={ytstream.hotSwapToCache ?? false}
                    onChange={(e) => setYtstream({ hotSwapToCache: e.target.checked })}
                    disabled={mediaIsDownload}
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

        {ytstreamSelected && strm.cacheOnPlay === true && (
          <Grid item xs={12} md={4}>
            <Box className="flex items-center gap-1">
              <TextField
                fullWidth
                type="number"
                label="Revert to STRM after (hours)"
                name="cacheOnPlayExpiryHours"
                value={strm.cacheOnPlayExpiryHours ?? ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') {
                    setStrm({ cacheOnPlayExpiryHours: null });
                    return;
                  }
                  const parsed = Number.parseInt(raw, 10);
                  setStrm({ cacheOnPlayExpiryHours: Number.isFinite(parsed) && parsed > 0 ? parsed : null });
                }}
                disabled={mediaIsDownload}
                placeholder="Never"
                helperText="Blank = never auto-revert. A nightly sweep (2:10 AM) checks for cached videos older than this."
                inputProps={{ min: 1 }}
              />
              <InfoTooltip
                text="How long a cache-on-play download stays a real file before Youtarr automatically reverts it back to STRM (freeing the disk space), reusing the same revert-to-STRM logic Automatic Video Removal already uses. Only ever applies to videos cache-on-play itself downloaded - a genuine/forced download (mediaMode=download, or a channel switched to download mode) is never touched by this, regardless of age."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </Grid>
        )}


        {(config.mediaMode === 'strm' || config.mediaMode === 'both') && (
          <Grid item xs={12}>
            <Typography variant="body2" color="textSecondary">
              STRM mode does not store full video files. Playback needs working
              yt-dlp/cookies and a reachable proxy URL. SponsorBlock does not
              apply to pure streams.
            </Typography>
          </Grid>
        )}
      </Grid>
    </ConfigurationCard>
  );
};
