import { useState, useEffect, useCallback } from 'react';
import { ConfigState, CookieStatus, CookieTestResult, SnackbarState } from '../types';

interface UseCookieManagementParams {
  token: string | null;
  setConfig: React.Dispatch<React.SetStateAction<ConfigState>>;
  setSnackbar: React.Dispatch<React.SetStateAction<SnackbarState>>;
}

export const useCookieManagement = ({
  token,
  setConfig,
  setSnackbar,
}: UseCookieManagementParams) => {
  const [cookieStatus, setCookieStatus] = useState<CookieStatus | null>(null);
  const [uploadingCookie, setUploadingCookie] = useState(false);
  const [testingCookies, setTestingCookies] = useState(false);
  const [cookieTestResult, setCookieTestResult] = useState<CookieTestResult | null>(null);

  // Fetch cookie status on mount
  useEffect(() => {
    if (token) {
      fetch('/api/cookies/status', {
        headers: {
          'x-access-token': token,
        },
      })
        .then((response) => response.json())
        .then((data) => {
          setCookieStatus(data);
        })
        .catch((error) => console.error('Error fetching cookie status:', error));
    }
  }, [token]);

  const uploadCookieFile = useCallback(async (file: File) => {
    setUploadingCookie(true);
    const formData = new FormData();
    formData.append('cookieFile', file);

    try {
      const response = await fetch('/api/cookies/upload', {
        method: 'POST',
        headers: {
          'x-access-token': token || '',
        },
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        setCookieStatus(data.cookieStatus);
        setConfig(prev => ({
          ...prev,
          cookiesEnabled: data.cookieStatus.cookiesEnabled,
          customCookiesUploaded: data.cookieStatus.customCookiesUploaded,
        }));
        setSnackbar({
          open: true,
          message: 'Cookie file uploaded successfully',
          severity: 'success'
        });
      } else {
        const error = await response.json();
        setSnackbar({
          open: true,
          message: error.error || 'Failed to upload cookie file',
          severity: 'error'
        });
      }
    } catch (error) {
      setSnackbar({
        open: true,
        message: 'Failed to upload cookie file',
        severity: 'error'
      });
    } finally {
      setUploadingCookie(false);
    }
  }, [token, setConfig, setSnackbar]);

  const testCookies = useCallback(async () => {
    setTestingCookies(true);
    setCookieTestResult(null);
    try {
      const response = await fetch('/api/cookies/test', {
        method: 'POST',
        headers: {
          'x-access-token': token || '',
        },
      });
      const data = await response.json();
      setCookieTestResult({
        success: !!data.success,
        message: data.message,
        error: data.error,
        channelCount: data.channelCount,
        testedAt: new Date().toISOString(),
      });
    } catch (error) {
      setCookieTestResult({
        success: false,
        error: 'Failed to reach the server to test cookies',
        testedAt: new Date().toISOString(),
      });
    } finally {
      setTestingCookies(false);
    }
  }, [token]);

  const deleteCookies = useCallback(async () => {
    try {
      const response = await fetch('/api/cookies', {
        method: 'DELETE',
        headers: {
          'x-access-token': token || '',
        },
      });

      if (response.ok) {
        const data = await response.json();
        setCookieStatus(data.cookieStatus);
        setCookieTestResult(null);
        setConfig(prev => ({
          ...prev,
          customCookiesUploaded: false,
        }));
        setSnackbar({
          open: true,
          message: 'Custom cookies deleted',
          severity: 'success'
        });
      } else {
        throw new Error('Failed to delete cookies');
      }
    } catch (error) {
      setSnackbar({
        open: true,
        message: 'Failed to delete cookies',
        severity: 'error'
      });
    }
  }, [token, setConfig, setSnackbar]);

  return {
    cookieStatus,
    uploadingCookie,
    uploadCookieFile,
    deleteCookies,
    testingCookies,
    cookieTestResult,
    testCookies,
  };
};
