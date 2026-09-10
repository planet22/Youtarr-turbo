import React from 'react';
import {
  Grid,
  Alert,
  AlertTitle,
  Typography,
  Button,
  Chip,
  Collapse,
} from '../../ui';
import { CheckCircle, Warning, AccessTime, ChevronDown, XCircle } from '../../../lib/icons';
import { ConfigurationAccordion } from '../common/ConfigurationAccordion';
import { InfoTooltip } from '../common/InfoTooltip';
import { useCookieManagement } from '../hooks/useCookieManagement';
import { ConfigState, SnackbarState } from '../types';
import { formatByteSize, formatDateTime, formatExpiresIn } from '../../../utils/formatters';

const AUTH_COOKIES_EXPLAINER =
  'Cookies that carry your YouTube login session (SID/HSID/SSID, APISID/SAPISID, ' +
  '__Secure- variants, LOGIN_INFO). If these expire, YouTube falls back to logged-out ' +
  'mode, causing "Sign in to confirm you\'re not a bot" errors.';

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
  const [showTestDetails, setShowTestDetails] = React.useState(false);
  const {
    cookieStatus,
    uploadingCookie,
    uploadCookieFile,
    deleteCookies,
    testingCookies,
    cookieTestResult,
    testCookies,
  } = useCookieManagement({ token, setConfig, setSnackbar });

  // Collapse a stale disclosure rather than carrying it over to the next test run.
  React.useEffect(() => {
    setShowTestDetails(false);
  }, [cookieTestResult?.testedAt]);

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
          Cookie files contain authentication for your Google account. Use a throwaway account, not your main account.
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
          Cookies bypass YouTube's bot detection and can resolve "Sign in to confirm you're not a bot" errors.
        </Typography>
      </Alert>

      <Grid container spacing={2}>
        {config.cookiesEnabled && (
          <>
            <Grid item xs={12}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <Button
                    variant="contained"
                    size="small"
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
                        size="medium"
                      />
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

            {cookieStatus && (
              <Grid item xs={12}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    padding: 12,
                    borderRadius: 4,
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--muted)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 12,
                    }}
                  >
                    <Typography variant="subtitle2" style={{ fontWeight: 600 }}>
                      Cookie Details
                    </Typography>
                    {cookieStatus.customFileExists && (
                      <Button
                        variant="outlined"
                        size="small"
                        disabled={testingCookies}
                        loading={testingCookies}
                        onClick={testCookies}
                      >
                        {testingCookies ? 'Testing...' : 'Test Cookies'}
                      </Button>
                    )}
                  </div>

                  {cookieTestResult && (
                    <Alert severity={cookieTestResult.success ? 'success' : 'error'}>
                      {cookieTestResult.success
                        ? cookieTestResult.message
                        : cookieTestResult.error || 'Cookie test failed.'}

                      {!cookieTestResult.success && cookieTestResult.details && (
                        <div style={{ marginTop: 8 }}>
                          <button
                            type="button"
                            onClick={() => setShowTestDetails((prev) => !prev)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              color: 'inherit',
                              font: 'inherit',
                              fontWeight: 600,
                              textDecoration: 'underline',
                            }}
                          >
                            Technical details
                            <ChevronDown
                              size={14}
                              style={{
                                transform: showTestDetails ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 200ms',
                              }}
                            />
                          </button>
                          <Collapse in={showTestDetails} timeout="auto" unmountOnExit>
                            <pre
                              style={{
                                marginTop: 8,
                                marginBottom: 0,
                                padding: 8,
                                borderRadius: 4,
                                backgroundColor: 'rgba(0, 0, 0, 0.2)',
                                fontSize: 12,
                                fontFamily: 'monospace',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                maxHeight: 200,
                                overflowY: 'auto',
                              }}
                            >
                              {cookieTestResult.details}
                            </pre>
                          </Collapse>
                        </div>
                      )}
                    </Alert>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {cookieStatus.customFileExists ? (
                        <CheckCircle size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
                      ) : null}
                      <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
                        Status: {cookieStatus.customFileExists ?
                          'Using custom cookies' :
                          'No cookie file uploaded'}
                      </Typography>
                    </div>

                    {cookieTestResult && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {cookieTestResult.success ? (
                          <CheckCircle size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
                        ) : (
                          <XCircle size={14} style={{ color: 'var(--destructive)', flexShrink: 0 }} />
                        )}
                        <Typography
                          variant="caption"
                          style={{
                            color: cookieTestResult.success ? 'var(--muted-foreground)' : 'var(--destructive)',
                          }}
                        >
                          Subscription test: {cookieTestResult.success ? 'Passed' : 'Failed'}
                          {formatDateTime(cookieTestResult.testedAt) ? ` (${formatDateTime(cookieTestResult.testedAt)})` : ''}
                        </Typography>
                      </div>
                    )}

                    {cookieStatus.customFileExists && (
                      <>
                        {typeof cookieStatus.sizeBytes === 'number' && (
                          <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
                            File size: {formatByteSize(cookieStatus.sizeBytes)}
                          </Typography>
                        )}

                        {cookieStatus.uploadedAt && (
                          <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
                            Uploaded: {formatDateTime(cookieStatus.uploadedAt)}
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
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {cookieStatus.hasExpiredAuthCookie ? (
                              <Warning size={14} style={{ color: 'var(--destructive)', flexShrink: 0 }} />
                            ) : (
                              <AccessTime size={14} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
                            )}
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
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </Grid>
            )}
          </>
        )}
      </Grid>
    </ConfigurationAccordion>
  );
};
