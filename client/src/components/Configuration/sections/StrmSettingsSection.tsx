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
import { YtstreamSettingsSection } from './YtstreamSettingsSection';

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
