import React, { useCallback, useState } from 'react';
import {
  TextField,
  FormHelperText,
  FormControl,
  InputLabel,
  Select,
  SelectChangeEvent,
  MenuItem,
  Grid,
  Alert,
  AlertTitle,
  Typography,
  Button,
  Box,
} from '../../ui';
import { ConfigurationAccordion } from '../common/ConfigurationAccordion';
import { InfoTooltip } from '../common/InfoTooltip';
import { ConfigState } from '../types';
import { validateProxyUrl } from '../utils/configValidation';
import { useYtdlpArgsValidation } from '../hooks/useYtdlpArgsValidation';
import { useHardwareCapabilities } from '../hooks/useHardwareCapabilities';
import { HardwareTestingAccordion } from './components/HardwareTestingAccordion';
import {
  MAX_CUSTOM_ARGS_LENGTH,
  getBlockedFlagInArgs,
  getPositionalTokenInArgs,
  validateRateLimit,
} from './ytdlpOptionsHelpers';

interface YtdlpOptionsSectionProps {
  config: ConfigState;
  onConfigChange: (updates: Partial<ConfigState>) => void;
  onMobileTooltipClick?: (text: string) => void;
  token: string | null;
}

export const YtdlpOptionsSection: React.FC<YtdlpOptionsSectionProps> = ({
  config,
  onConfigChange,
  onMobileTooltipClick,
  token,
}) => {
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [rateLimitError, setRateLimitError] = useState<string | null>(null);
  const { testing: testingHardware, matrix: hardwareMatrix, error: hardwareTestError, runTest: runHardwareTest } = useHardwareCapabilities(token);

  const handleProxyChange = useCallback((value: string) => {
    onConfigChange({ proxy: value });
    setProxyError(null);
  }, [onConfigChange]);

  const handleProxyBlur = useCallback(() => {
    setProxyError(validateProxyUrl(config.proxy || ''));
  }, [config.proxy]);

  const handleRateLimitBlur = useCallback(() => {
    setRateLimitError(validateRateLimit(config.ytdlpDownloadRateLimit));
  }, [config.ytdlpDownloadRateLimit]);

  const customArgs = config.ytdlpCustomArgs || '';
  const blockedFlag = getBlockedFlagInArgs(customArgs);
  const positionalToken = getPositionalTokenInArgs(customArgs);
  const tooLong = customArgs.length > MAX_CUSTOM_ARGS_LENGTH;

  let customArgsError: string | null = null;
  if (blockedFlag) {
    customArgsError = `${blockedFlag} is not allowed in custom args. Use the dedicated setting field instead.`;
  } else if (positionalToken) {
    customArgsError = `"${positionalToken}" looks like a positional argument. Custom args must be yt-dlp flags (start with -). Quote values that contain spaces.`;
  } else if (tooLong) {
    customArgsError = `Custom arguments exceed the ${MAX_CUSTOM_ARGS_LENGTH}-character limit.`;
  }

  const { validating, result, validate, reset } = useYtdlpArgsValidation(token);

  const handleValidate = useCallback(async () => {
    await validate(customArgs);
  }, [validate, customArgs]);

  const handleCustomArgsChange = useCallback(
    (value: string) => {
      onConfigChange({ ytdlpCustomArgs: value });
      reset();
    },
    [onConfigChange, reset]
  );

  return (
    <ConfigurationAccordion
      title='yt-dlp Options'
      chipLabel='Advanced'
      chipColor='default'
      defaultExpanded={false}
    >
      <Grid container spacing={2}>
        <Grid item xs={12}>
          <TextField
            fullWidth
            label='Sleep Between Requests (seconds)'
            type='number'
            inputProps={{ min: 0, max: 30, step: 1 }}
            value={config.sleepRequests ?? 1}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (value >= 0 && value <= 30) onConfigChange({ sleepRequests: value });
            }}
            helperText={
              <span style={{ display: 'flex', alignItems: 'center' }}>
                Delay between yt-dlp API requests (0-30). Higher values prevent YouTube rate limiting but slow downloads.
                <InfoTooltip
                  text='A delay of 1-2 seconds usually works well. Increase to 5-10 seconds if you experience 429 errors or frequent throttling.'
                  onMobileClick={onMobileTooltipClick}
                />
              </span>
            }
          />
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            label='Proxy URL'
            type='text'
            value={config.proxy || ''}
            onChange={(e) => handleProxyChange(e.target.value)}
            onBlur={handleProxyBlur}
            error={Boolean(proxyError)}
            helperText={proxyError || 'Optional proxy URL (e.g., socks5://user:pass@127.0.0.1:1080/). Leave empty for direct connection.'}
          />
        </Grid>

        <Grid item xs={12}>
          <FormControl fullWidth>
            <InputLabel id='ytdlp-ip-family-label'>IP Family</InputLabel>
            <Select
              labelId='ytdlp-ip-family-label'
              label='IP Family'
              value={config.ytdlpIpFamily || 'ipv4'}
              onChange={(e) => onConfigChange({ ytdlpIpFamily: e.target.value as 'ipv4' | 'ipv6' | 'auto' })}
              inputProps={{ 'aria-label': 'IP Family' }}
            >
              <MenuItem value='ipv4'>Force IPv4</MenuItem>
              <MenuItem value='ipv6'>Force IPv6</MenuItem>
              <MenuItem value='auto'>Auto</MenuItem>
            </Select>
            <FormHelperText>
              <span style={{ display: 'flex', alignItems: 'center' }}>
                IPv4 is recommended for YouTube reliability.
                <InfoTooltip
                  text='Force IPv6 or Auto only if your network requires it. Downloads may become unreliable on networks where YouTube responds slowly to IPv6.'
                  onMobileClick={onMobileTooltipClick}
                />
              </span>
            </FormHelperText>
          </FormControl>
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            label='Download Rate Limit'
            type='text'
            placeholder='e.g. 5M'
            value={config.ytdlpDownloadRateLimit || ''}
            onChange={(e) => {
              onConfigChange({ ytdlpDownloadRateLimit: e.target.value });
              setRateLimitError(null);
            }}
            onBlur={handleRateLimitBlur}
            error={Boolean(rateLimitError)}
            helperText={rateLimitError || 'Examples: 500K, 5M, 1G. Leave empty for no limit.'}
          />
        </Grid>

        <Grid item xs={12}>
          <Typography variant='subtitle2' style={{ marginTop: 8, marginBottom: 4 }}>
            Transcode after download
          </Typography>
          <Typography variant='body2' color='textSecondary' style={{ marginBottom: 8 }}>
            Re-encodes the already-downloaded file with ffmpeg. Separate from the
            &quot;Preferred video codec&quot; setting above, which only picks which
            existing YouTube stream to download - this converts the file itself
            afterward, e.g. to a smaller AV1 file or to HEVC, and can use the same
            hardware encoder as STRM playback transcoding.
          </Typography>
        </Grid>

        <Grid item xs={12} md={4}>
          <FormControl fullWidth>
            <InputLabel>Transcode video to</InputLabel>
            <Box className='flex items-center gap-1'>
              <Select
                value={config.downloadTranscodeVideoCodec || 'off'}
                label='Transcode video to'
                onChange={(e: SelectChangeEvent<string>) =>
                  onConfigChange({
                    downloadTranscodeVideoCodec: e.target.value as 'off' | 'h264' | 'hevc' | 'av1',
                  })
                }
                className='flex-1 min-w-0'
              >
                <MenuItem value='off'>Off (keep as downloaded)</MenuItem>
                <MenuItem value='h264'>H.264</MenuItem>
                <MenuItem value='hevc'>H.265 / HEVC</MenuItem>
                <MenuItem value='av1'>AV1 (Apple-compatible tagging)</MenuItem>
              </Select>
              <InfoTooltip
                text='Off leaves the downloaded file exactly as yt-dlp produced it (fastest, no quality loss). HEVC gives ~30-50% smaller files at similar quality. AV1 gives the best compression but software encoding is much slower - only worth it since this runs in the background, not live. AV1 output is tagged av01 in an mp4 container so Apple devices/players recognize it.'
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>

        <Grid item xs={12} md={4}>
          <FormControl fullWidth>
            <InputLabel>Hardware encoder</InputLabel>
            <Box className='flex items-center gap-1'>
              <Select
                value={config.downloadTranscodeHardwareMode || 'none'}
                label='Hardware encoder'
                onChange={(e: SelectChangeEvent<string>) =>
                  onConfigChange({
                    downloadTranscodeHardwareMode: e.target.value as 'none' | 'qsv' | 'nvenc' | 'vaapi' | 'amf',
                  })
                }
                className='flex-1 min-w-0'
                disabled={(config.downloadTranscodeVideoCodec || 'off') === 'off'}
              >
                <MenuItem value='none'>None (software)</MenuItem>
                <MenuItem value='qsv'>Intel Quick Sync</MenuItem>
                <MenuItem value='nvenc'>NVIDIA NVENC</MenuItem>
                <MenuItem value='vaapi'>VAAPI</MenuItem>
                <MenuItem value='amf'>AMD AMF</MenuItem>
              </Select>
              <InfoTooltip
                text='Same options as STRM playback transcoding. Not every GPU generation supports every codec here (AV1 hardware encode in particular needs a recent GPU - RTX 40-series, Intel Arc, or AMD RDNA3+). If the selected hardware encoder fails to open for a given file, Youtarr automatically retries with the software encoder for that codec instead of failing the download.'
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>

        <Grid item xs={12} md={4}>
          <FormControl fullWidth>
            <InputLabel>Audio codec</InputLabel>
            <Box className='flex items-center gap-1'>
              <Select
                value={config.downloadTranscodeAudioCodec || 'copy'}
                label='Audio codec'
                onChange={(e: SelectChangeEvent<string>) =>
                  onConfigChange({
                    downloadTranscodeAudioCodec: e.target.value as 'copy' | 'aac' | 'opus',
                  })
                }
                className='flex-1 min-w-0'
                disabled={(config.downloadTranscodeVideoCodec || 'off') === 'off'}
              >
                <MenuItem value='copy'>Keep original</MenuItem>
                <MenuItem value='aac'>AAC</MenuItem>
                <MenuItem value='opus'>Opus</MenuItem>
              </Select>
              <InfoTooltip
                text="Only applied when video transcode above isn't Off, since it runs in the same ffmpeg pass. Keep original passes the source audio through untouched (fastest). AAC is the most broadly compatible; Opus is smaller at the same quality but less universally supported by older devices/players."
                onMobileClick={onMobileTooltipClick}
              />
            </Box>
          </FormControl>
        </Grid>

        <Grid item xs={12}>
          <HardwareTestingAccordion
            matrix={hardwareMatrix}
            testing={testingHardware}
            error={hardwareTestError}
            onRunTest={runHardwareTest}
            onMobileTooltipClick={onMobileTooltipClick}
          />
        </Grid>

        <Grid item xs={12}>
          <Alert severity='warning' style={{ marginBottom: 8 }}>
            <AlertTitle>Power user feature</AlertTitle>
            <Typography variant='body2'>
              Custom arguments are applied to every yt-dlp call. Incorrect flags can prevent downloads from working entirely or break Youtarr&apos;s behavior in unexpected ways. Use at your own risk; remove the args if you encounter problems.
            </Typography>
          </Alert>

          <TextField
            fullWidth
            multiline
            minRows={4}
            label='Custom yt-dlp Arguments'
            placeholder='--concurrent-fragments 4 --retries 5'
            value={customArgs}
            onChange={(e) => handleCustomArgsChange(e.target.value)}
            error={Boolean(customArgsError)}
            helperText={
              customArgsError ||
              'Space-separated yt-dlp flags. Example: --concurrent-fragments 4 --retries 5 --no-mtime. Quote values that contain spaces.'
            }
            inputProps={{ style: { fontFamily: 'monospace' } }}
          />

          <Box style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 16 }}>
            <Button
              variant='outlined'
              onClick={handleValidate}
              disabled={!customArgs.trim() || validating || Boolean(customArgsError)}
            >
              {validating ? 'Validating...' : 'Validate Arguments'}
            </Button>
            {result?.ok === true && (
              <Typography variant='body2' color='success'>
                {result.message || 'Arguments parsed successfully'}
              </Typography>
            )}
          </Box>

          {result?.ok === false && (
            <Alert severity='error' style={{ marginTop: 8 }}>
              <AlertTitle>yt-dlp rejected the arguments</AlertTitle>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'monospace', fontSize: '0.85rem' }}>
                {result.stderr}
              </pre>
            </Alert>
          )}
        </Grid>
      </Grid>
    </ConfigurationAccordion>
  );
};
