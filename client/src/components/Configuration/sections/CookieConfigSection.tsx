import React from 'react';
import {
  Grid,
  Alert,
  AlertTitle,
  Typography,
  Button,
  Chip,
} from '../../ui';
import { ConfigurationAccordion } from '../common/ConfigurationAccordion';
import { InfoTooltip } from '../common/InfoTooltip';
import { useCookieManagement } from '../hooks/useCookieManagement';
import { ConfigState, SnackbarState } from '../types';
import { formatByteSize, formatDateTime, formatExpiresIn } from '../../../utils/formatters';

const AUTH_COOKIES_EXPLAINER =
  'These are the cookies that carry your YouTube login session (SID/HSID/SSID, ' +
  'APISID/SAPISID and their __Secure- variants, plus LOGIN_INFO) - as opposed to ' +
  'tracking/preference cookies, which do not affect authentication. If these expire ' +
  'or go missing, YouTube quietly falls back to logged-out behavior, which is what ' +
  'triggers "Sign in to confirm you\'re not a bot" and similar errors.';

interface CookieConfigSectionProps {
  token: string | null;
  config: ConfigState;
  setConfig: React.Dispatch<React.SetStateAction<ConfigState>>;
  onConfigChange: (updates: Partial<ConfigState>) => void;
  setSnackbar: React.Dispatch<React.SetStateAction<SnackbarState>>;
  onMobileTooltipClick?: (text: string) => void;
}

export const CookieConfigSection: React.FC<CookieConfigSectionProps> = ({
  token,
  config,
  setConfig,
  onConfigChange,
  setSnackbar,
  onMobileTooltipClick,
}) => {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const {
    cookieStatus,
    uploadingCookie,
    uploadCookieFile,
    deleteCookies,
    testingCookies,
    cookieTestResult,
    testCookies,
  } = useCookieManagement({ token, setConfig, setSnackbar });

  const handleCookieUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await uploadCookieFile(file);
    event.target.value = '';
  };
  return (
    <ConfigurationAccordion
      title="Cookie Configuration"
      chipLabel={config.cookiesEnabled ? "Cookies Enabled" : "Cookies Disabled"}
      chipColor={config.cookiesEnabled ? "success" : "default"}
      statusBanner={{
        enabled: config.cookiesEnabled,
        label: 'Enable Cookies',
        onToggle: (enabled) => onConfigChange({ cookiesEnabled: enabled }),
        onText: 'Cookies Enabled',
        offText: 'Cookies Disabled',
      }}
      defaultExpanded={false}
    >
      <Alert severity="warning" style={{ marginBottom: 16 }}>
        <AlertTitle>Security Warning</AlertTitle>
        <Typography variant="body2" style={{ marginBottom: 16 }}>
          Cookie files contain authentication information for your Google account.
          We strongly recommend using a throwaway account instead of your main account.
        </Typography>
        <Typography variant="body2">
          Learn more about cookie security:{' '}
          <a href="https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies"
             target="_blank"
             rel="noopener noreferrer"
             style={{ color: 'inherit', textDecoration: 'underline' }}>
            yt-dlp Cookie FAQ
          </a>
        </Typography>
      </Alert>

      <Alert severity="info" style={{ marginBottom: 16 }}>
        <Typography variant="body2">
          Cookies help bypass YouTube's bot detection. If you encounter "Sign in to confirm you're not a bot" errors,
          enabling cookies can resolve the issue.
        </Typography>
      </Alert>

      <Grid container spacing={2}>
        {config.cookiesEnabled && (
          <>
            <Grid item xs={12}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <Button
                    variant="contained"
                    disabled={uploadingCookie}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploadingCookie ? 'Uploading...' : 'Upload Cookie File'}
                  </Button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    hidden
                    accept=".txt,text/plain"
                    data-testid="cookie-file-input"
                    onChange={handleCookieUpload}
                  />
                  {cookieStatus?.customFileExists && (
                    <>
                      <Chip
                        label="Custom cookies uploaded"
                        color="success"
                        size="small"
                      />
                      <Button
                        variant="outlined"
                        size="small"
                        disabled={testingCookies}
                        loading={testingCookies}
                        onClick={testCookies}
                      >
                        {testingCookies ? 'Testing...' : 'Test Cookies'}
                      </Button>
                      <Button
                        variant="outlined"
                        color="error"
                        size="small"
                        onClick={deleteCookies}
                      >
                        Delete Custom Cookies
                      </Button>
                    </>
                  )}
                </div>
                <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
                  Upload a Netscape format cookie file exported from your browser.
                  File must be less than 1MB.
                </Typography>
              </div>
            </Grid>

            {cookieTestResult && (
              <Grid item xs={12}>
                <Alert severity={cookieTestResult.success ? 'success' : 'error'}>
                  {cookieTestResult.success
                    ? cookieTestResult.message
                    : cookieTestResult.error || 'Cookie test failed.'}
                </Alert>
              </Grid>
            )}

            {cookieStatus && (
              <Grid item xs={12}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
                    Status: {cookieStatus.customFileExists ?
                      'Using custom cookies' :
                      'No cookie file uploaded'}
                  </Typography>

                  {cookieStatus.customFileExists && (
                    <>
                      {typeof cookieStatus.sizeBytes === 'number' && cookieStatus.uploadedAt && (
                        <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
                          {formatByteSize(cookieStatus.sizeBytes)}, uploaded {formatDateTime(cookieStatus.uploadedAt)}
                        </Typography>
                      )}

                      {typeof cookieStatus.authCookiesFound === 'number' && (
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
                            {cookieStatus.authCookiesFound > 0
                              ? `${cookieStatus.authCookiesFound} login cookie${cookieStatus.authCookiesFound === 1 ? '' : 's'} found`
                              : 'No login cookies found in this file'}
                          </Typography>
                          <InfoTooltip text={AUTH_COOKIES_EXPLAINER} onMobileClick={onMobileTooltipClick} />
                        </div>
                      )}

                      {cookieStatus.earliestExpiry && (
                        <Typography
                          variant="caption"
                          style={{
                            color: cookieStatus.hasExpiredAuthCookie
                              ? 'var(--destructive)'
                              : 'var(--muted-foreground)',
                          }}
                        >
                          {cookieStatus.hasExpiredAuthCookie
                            ? `${cookieStatus.earliestExpiryName} expired ${formatDateTime(cookieStatus.earliestExpiry)}`
                            : `${cookieStatus.earliestExpiryName} ${formatExpiresIn(cookieStatus.earliestExpiry)}`}
                        </Typography>
                      )}
                    </>
                  )}
                </div>
              </Grid>
            )}
          </>
        )}
      </Grid>
    </ConfigurationAccordion>
  );
};
