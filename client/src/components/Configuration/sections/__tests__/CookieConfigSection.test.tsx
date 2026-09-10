import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CookieConfigSection } from '../CookieConfigSection';
import { renderWithProviders } from '../../../../test-utils';
import { ConfigState, SnackbarState, CookieStatus, CookieTestResult } from '../../types';
import { DEFAULT_CONFIG } from '../../../../config/configSchema';

const mockUseCookieManagement = jest.fn();

jest.mock('../../hooks/useCookieManagement', () => ({
  useCookieManagement: (...args: unknown[]) => mockUseCookieManagement(...args),
}));

type HookValue = {
  cookieStatus: CookieStatus | null;
  uploadingCookie: boolean;
  uploadCookieFile: jest.Mock;
  deleteCookies: jest.Mock;
  testingCookies: boolean;
  cookieTestResult: CookieTestResult | null;
  testCookies: jest.Mock;
};

const createHookValue = (overrides: Partial<HookValue> = {}) => {
  const value: HookValue = {
    cookieStatus: null,
    uploadingCookie: false,
    uploadCookieFile: jest.fn(),
    deleteCookies: jest.fn(),
    testingCookies: false,
    cookieTestResult: null,
    testCookies: jest.fn(),
    ...overrides,
  };
  mockUseCookieManagement.mockReturnValue(value);
  return value;
};

const createConfig = (overrides: Partial<ConfigState> = {}): ConfigState => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

const createSectionProps = (
  overrides: Partial<React.ComponentProps<typeof CookieConfigSection>> = {}
): React.ComponentProps<typeof CookieConfigSection> => ({
  token: 'test-token',
  config: createConfig(),
  setConfig: jest.fn() as React.Dispatch<React.SetStateAction<ConfigState>>,
  onConfigChange: jest.fn(),
  setSnackbar: jest.fn() as React.Dispatch<React.SetStateAction<SnackbarState>>,
  onMobileTooltipClick: jest.fn(),
  ...overrides,
});

describe('CookieConfigSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls onConfigChange when toggling the cookie switch', async () => {
    const user = userEvent.setup();
    createHookValue();
    const props = createSectionProps();
    renderWithProviders(<CookieConfigSection {...props} />);

    const toggle = await screen.findByRole('checkbox', { name: /enable cookies/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    expect(props.onConfigChange).toHaveBeenCalledWith({ cookiesEnabled: true });
  });

  test('renders cookie upload controls and handles delete action when cookies are enabled', async () => {
    const user = userEvent.setup();
    const hookValue = createHookValue({
      cookieStatus: {
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true,
      },
    });

    const props = createSectionProps({
      config: createConfig({ cookiesEnabled: true }),
    });

    renderWithProviders(<CookieConfigSection {...props} />);

    expect(await screen.findByRole('button', { name: /upload cookie file/i })).toBeEnabled();
    expect(screen.getByText('Custom cookies uploaded')).toBeInTheDocument();
    expect(screen.getByText('Status: Using custom cookies')).toBeInTheDocument();

    const deleteButton = screen.getByRole('button', { name: /delete custom cookies/i });
    await user.click(deleteButton);

    expect(hookValue.deleteCookies).toHaveBeenCalledTimes(1);
  });

  test('clicking Test Cookies calls the hook and shows the result', async () => {
    const user = userEvent.setup();
    const hookValue = createHookValue({
      cookieStatus: {
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true,
      },
      cookieTestResult: {
        success: true,
        message: 'Cookies are working (found 12 subscribed channels).',
        testedAt: new Date().toISOString(),
      },
    });

    const props = createSectionProps({
      config: createConfig({ cookiesEnabled: true }),
    });

    renderWithProviders(<CookieConfigSection {...props} />);

    const testButton = screen.getByRole('button', { name: /test cookies/i });
    await user.click(testButton);

    expect(hookValue.testCookies).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText('Cookies are working (found 12 subscribed channels).')
    ).toBeInTheDocument();
    expect(screen.getByText(/Subscription test: Passed/)).toBeInTheDocument();
  });

  test('shows a failed subscription test line when the cookie test fails', () => {
    createHookValue({
      cookieStatus: {
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true,
      },
      cookieTestResult: {
        success: false,
        error: 'Your cookies appear to be expired or invalid.',
        testedAt: new Date().toISOString(),
      },
    });

    const props = createSectionProps({
      config: createConfig({ cookiesEnabled: true }),
    });

    renderWithProviders(<CookieConfigSection {...props} />);

    expect(screen.getByText(/Subscription test: Failed/)).toBeInTheDocument();
  });

  test('shows an error alert when the cookie test fails', () => {
    createHookValue({
      cookieStatus: {
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true,
      },
      cookieTestResult: {
        success: false,
        error: 'Your cookies appear to be expired or invalid.',
        testedAt: new Date().toISOString(),
      },
    });

    const props = createSectionProps({
      config: createConfig({ cookiesEnabled: true }),
    });

    renderWithProviders(<CookieConfigSection {...props} />);

    expect(
      screen.getByText('Your cookies appear to be expired or invalid.')
    ).toBeInTheDocument();
  });

  test('reveals technical details for a failed test only after clicking the toggle', async () => {
    const user = userEvent.setup();
    createHookValue({
      cookieStatus: {
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true,
      },
      cookieTestResult: {
        success: false,
        error: 'Your cookies appear to be expired or invalid.',
        details: 'ERROR: [youtube:tab] channels: Failed to resolve url (does the playlist exist?)',
        testedAt: new Date().toISOString(),
      },
    });

    const props = createSectionProps({
      config: createConfig({ cookiesEnabled: true }),
    });

    renderWithProviders(<CookieConfigSection {...props} />);

    expect(screen.queryByText(/Failed to resolve url/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /technical details/i }));

    expect(screen.getByText(/Failed to resolve url/)).toBeInTheDocument();
  });

  test('shows expiry metadata for the uploaded cookie file', () => {
    createHookValue({
      cookieStatus: {
        cookiesEnabled: true,
        customCookiesUploaded: true,
        customFileExists: true,
        sizeBytes: 4096,
        uploadedAt: new Date().toISOString(),
        authCookiesFound: 8,
        hasExpiredAuthCookie: true,
        earliestExpiry: new Date(Date.now() - 60_000).toISOString(),
        earliestExpiryName: 'SAPISID',
      },
    });

    const props = createSectionProps({
      config: createConfig({ cookiesEnabled: true }),
    });

    renderWithProviders(<CookieConfigSection {...props} />);

    expect(screen.getByText(/8 login cookies found/i)).toBeInTheDocument();
    expect(screen.getByText(/SAPISID expired/i)).toBeInTheDocument();
  });

  test('passes selected file to uploadCookieFile via the hook', async () => {
    const user = userEvent.setup();
    const hookValue = createHookValue();
    const props = createSectionProps({
      config: createConfig({ cookiesEnabled: true }),
    });

    renderWithProviders(<CookieConfigSection {...props} />);

    const fileInput = screen.getByTestId('cookie-file-input') as HTMLInputElement;
    const file = new File(['cookie-data'], 'cookies.txt', { type: 'text/plain' });

    await user.upload(fileInput, file);

    expect(hookValue.uploadCookieFile).toHaveBeenCalledWith(file);
  });
});
