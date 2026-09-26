import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import PlexAuthDialog from '../PlexAuthDialog';

const POLL_MS = 5000;

describe('PlexAuthDialog polling and lifecycle', () => {
  const onClose = jest.fn();
  const onSuccess = jest.fn();
  const fetchMock = jest.fn();
  const authWindow = { focus: jest.fn(), close: jest.fn() };
  let originalFetch: typeof fetch | undefined;
  let originalOpen: typeof window.open | undefined;

  const respond = (body: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

  // The first fetch is the auth URL request; every later one is a PIN check.
  const mockPins = (...checks: Array<() => Promise<unknown>>) => {
    let call = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url === '/plex/auth-url') return respond({ authUrl: 'https://plex.example/auth', pinId: 42 });
      const check = checks[Math.min(call, checks.length - 1)];
      call += 1;
      return check();
    });
  };

  const startAuth = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Authenticate with Plex' }));
  };

  const advancePoll = async (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(POLL_MS);
      });
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    originalOpen = window.open;
    window.open = jest.fn(() => authWindow) as unknown as typeof window.open;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    global.fetch = originalFetch as typeof fetch;
    window.open = originalOpen as typeof window.open;
  });

  const renderDialog = () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const view = render(<PlexAuthDialog open onClose={onClose} onSuccess={onSuccess} />);
    return { user, ...view };
  };

  it('opens the Plex auth page in a new window and focuses it', async () => {
    mockPins(() => respond({}));
    const { user } = renderDialog();

    await startAuth(user);

    expect(window.open).toHaveBeenCalledWith('https://plex.example/auth', '_blank');
    expect(authWindow.focus).toHaveBeenCalled();
  });

  it('still authenticates when the popup was blocked', async () => {
    (window.open as jest.Mock).mockReturnValue(null);
    mockPins(() => respond({ authToken: 'token-1' }));
    const { user } = renderDialog();

    await startAuth(user);
    await advancePoll();

    expect(onSuccess).toHaveBeenCalledWith('token-1');
  });

  it('shows a waiting message and disables the buttons while polling', async () => {
    mockPins(() => respond({}));
    const { user } = renderDialog();

    await startAuth(user);

    expect(screen.getByText(/Waiting for Plex authentication/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authenticating...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('checks the PIN every five seconds', async () => {
    mockPins(() => respond({}));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll(3);

    const pinChecks = fetchMock.mock.calls.filter(([url]) => url === '/plex/check-pin/42');
    expect(pinChecks).toHaveLength(3);
  });

  it('keeps waiting while the PIN is not claimed yet', async () => {
    mockPins(() => respond({}));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll(2);

    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByText(/Waiting for Plex authentication/)).toBeInTheDocument();
  });

  it('closes the auth window and reports the token once it is claimed', async () => {
    mockPins(() => respond({}), () => respond({ authToken: 'token-2' }));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll(2);

    expect(authWindow.close).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledWith('token-2');
    expect(screen.getByText('Success!')).toBeInTheDocument();
  });

  it('stops polling after success', async () => {
    mockPins(() => respond({ authToken: 'token-2' }));
    const { user } = renderDialog();
    await startAuth(user);
    await advancePoll();
    const callsAfterSuccess = fetchMock.mock.calls.length;

    await advancePoll(3);

    expect(fetchMock.mock.calls.length).toBe(callsAfterSuccess);
  });

  it('closes the dialog 1.5 seconds after success', async () => {
    mockPins(() => respond({ authToken: 'token-2' }));
    const { user } = renderDialog();
    await startAuth(user);
    await advancePoll();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1500);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close automatically if the dialog is unmounted first', async () => {
    mockPins(() => respond({ authToken: 'token-2' }));
    const { user, unmount } = renderDialog();
    await startAuth(user);
    await advancePoll();

    unmount();
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops polling when the dialog is unmounted mid-authentication', async () => {
    mockPins(() => respond({}));
    const { user, unmount } = renderDialog();
    await startAuth(user);
    await advancePoll();
    const callsBeforeUnmount = fetchMock.mock.calls.length;

    unmount();
    await act(async () => {
      jest.advanceTimersByTime(POLL_MS * 3);
    });

    expect(fetchMock.mock.calls.length).toBe(callsBeforeUnmount);
  });

  it('explains when the Plex account is not the server\'s', async () => {
    mockPins(() => respond({ authToken: 'invalid' }));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll();

    expect(screen.getByText(/Invalid Plex Account/)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(authWindow.close).toHaveBeenCalled();
  });

  it('lets the user try again after an invalid account', async () => {
    mockPins(() => respond({ authToken: 'invalid' }));
    const { user } = renderDialog();
    await startAuth(user);
    await advancePoll();

    expect(screen.getByRole('button', { name: 'Authenticate with Plex' })).toBeEnabled();
  });

  it('gives up with a timeout message after 30 unanswered checks', async () => {
    mockPins(() => respond({}));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll(30);

    expect(screen.getByText('Authentication timeout. Please try again.')).toBeInTheDocument();
    expect(authWindow.close).toHaveBeenCalled();
  });

  it('is still waiting after 29 unanswered checks', async () => {
    mockPins(() => respond({}));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll(29);

    expect(screen.queryByText('Authentication timeout. Please try again.')).not.toBeInTheDocument();
  });

  it('stops checking after the timeout', async () => {
    mockPins(() => respond({}));
    const { user } = renderDialog();
    await startAuth(user);
    await advancePoll(30);
    const callsAtTimeout = fetchMock.mock.calls.length;

    await advancePoll(3);

    expect(fetchMock.mock.calls.length).toBe(callsAtTimeout);
  });

  it('reports a failed status check and stops polling', async () => {
    mockPins(() => Promise.reject(new Error('network down')));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll();

    expect(screen.getByText('Failed to check authentication status. Please try again.')).toBeInTheDocument();
    expect(authWindow.close).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Authenticate with Plex' })).toBeEnabled();
  });

  it('reports a status response that is not JSON the same way', async () => {
    mockPins(() => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('bad json')) }));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll();

    expect(screen.getByText('Failed to check authentication status. Please try again.')).toBeInTheDocument();
  });

  it('clears an earlier error when authentication is started again', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/plex/auth-url') return respond({}, false);
      return respond({});
    });
    const { user } = renderDialog();
    await startAuth(user);
    expect(await screen.findByText('Error: Failed to get Plex authentication URL')).toBeInTheDocument();

    mockPins(() => respond({}));
    await startAuth(user);

    expect(screen.queryByText(/Error: Failed to get Plex/)).not.toBeInTheDocument();
  });

  it('cancelling closes the dialog and clears the error', async () => {
    fetchMock.mockImplementation(() => respond({}, false));
    const { user } = renderDialog();
    await startAuth(user);
    await screen.findByText('Error: Failed to get Plex authentication URL');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Error: Failed to get Plex/)).not.toBeInTheDocument();
  });

  it('shows the success guidance and hides the action buttons', async () => {
    mockPins(() => respond({ authToken: 'token-2' }));
    const { user } = renderDialog();
    await startAuth(user);

    await advancePoll();

    expect(screen.getByText('Plex API Key obtained successfully!')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Authenticate with Plex' })).not.toBeInTheDocument();
  });
});
