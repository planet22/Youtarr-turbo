import React from 'react';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { NotificationsSection } from '../NotificationsSection';
import { renderWithProviders } from '../../../../test-utils';
import { ConfigState } from '../../types';
import { DEFAULT_CONFIG } from '../../../../config/configSchema';

const mockFetch = jest.fn();
global.fetch = mockFetch;

const DISCORD = { url: 'discord://webhook_id/token', name: 'My Discord', richFormatting: true };
const TELEGRAM = { url: 'tgram://bot/chat', name: 'My Telegram', richFormatting: true };
const GOTIFY = { url: 'gotify://host/token', name: 'My Gotify', richFormatting: false };

const createConfig = (overrides: Partial<ConfigState> = {}): ConfigState => ({
  ...DEFAULT_CONFIG,
  notificationsEnabled: true,
  ...overrides,
});

const createProps = (
  overrides: Partial<React.ComponentProps<typeof NotificationsSection>> = {}
): React.ComponentProps<typeof NotificationsSection> => ({
  token: 'test-token',
  config: createConfig({ appriseUrls: [DISCORD, TELEGRAM] }),
  onConfigChange: jest.fn(),
  setSnackbar: jest.fn(),
  onMobileTooltipClick: jest.fn(),
  ...overrides,
});

const setupUser = () => userEvent.setup({ delay: null });

describe('NotificationsSection editing, deleting and testing services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('how configured services are shown', () => {
    it('accepts services stored as plain URL strings and names them by service', async () => {
      const user = setupUser();
      mockFetch.mockResolvedValue({ ok: true });
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: ['discord://a/b'] as never }) })} />);

      await user.click(screen.getByRole('button', { name: 'Test notification' }));

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ url: 'discord://a/b', name: 'Discord', richFormatting: true });
    });

    it('treats a missing or non-array list as empty', () => {
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: undefined as never }) })} />);

      expect(screen.getByText('Add a Notification Service')).toBeInTheDocument();
    });

    it('offers to add another service when some exist', () => {
      renderWithProviders(<NotificationsSection {...createProps()} />);

      expect(screen.getByText('Add Another Service')).toBeInTheDocument();
    });

    it('shortens a long URL in the subtitle but keeps the full URL as its title', () => {
      const longUrl = `discord://${'a'.repeat(80)}/token`;
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [{ url: longUrl, name: 'Long', richFormatting: true }] }) })} />);

      const subtitle = screen.getByTitle(longUrl);
      expect(subtitle.textContent).toBe(`${longUrl.substring(0, 25)}...${longUrl.slice(-20)}`);
    });

    it('shows a short URL in full', () => {
      renderWithProviders(<NotificationsSection {...createProps()} />);

      expect(screen.getByTitle('discord://webhook_id/token')).toHaveTextContent('discord://webhook_id/token');
    });

    it('marks services that use rich formatting', () => {
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [DISCORD] }) })} />);

      expect(screen.getByText('✨')).toBeInTheDocument();
    });

    it('marks services where rich formatting is turned off', () => {
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [{ ...DISCORD, richFormatting: false }] }) })} />);

      expect(screen.getByText('📝')).toBeInTheDocument();
    });

    it('shows no formatting marker for services that do not support it', () => {
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [GOTIFY] }) })} />);

      expect(screen.queryByText('✨')).not.toBeInTheDocument();
      expect(screen.queryByText('📝')).not.toBeInTheDocument();
    });
  });

  describe('editing a service', () => {
    const startEditing = async (user: ReturnType<typeof setupUser>, index = 0) => {
      await user.click(screen.getAllByRole('button', { name: 'Edit notification URL' })[index]);
    };

    it('opens an editor filled with the current name and URL', async () => {
      const user = setupUser();
      renderWithProviders(<NotificationsSection {...createProps()} />);

      await startEditing(user);

      expect(screen.getByLabelText('Name')).toHaveValue('My Discord');
      expect(screen.getByLabelText('URL')).toHaveValue('discord://webhook_id/token');
    });

    it('saves the changed name and URL', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);

      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'Renamed');
      await user.clear(screen.getByLabelText('URL'));
      await user.type(screen.getByLabelText('URL'), '  discord://new/hook  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(onConfigChange).toHaveBeenCalledWith({
        appriseUrls: [{ url: 'discord://new/hook', name: 'Renamed', richFormatting: true }, TELEGRAM],
      });
    });

    it('names the service after its type when the name is cleared', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);

      await user.clear(screen.getByLabelText('Name'));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(onConfigChange.mock.calls[0][0].appriseUrls[0].name).toBe('Discord');
    });

    it('can turn rich formatting off', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);

      await user.click(screen.getByRole('checkbox', { name: /rich formatting/i }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(onConfigChange.mock.calls[0][0].appriseUrls[0].richFormatting).toBe(false);
    });

    it('starts the editor with the service\'s own rich formatting setting', async () => {
      const user = setupUser();
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [{ ...DISCORD, richFormatting: false }] }) })} />);

      await startEditing(user);

      expect(screen.getByRole('checkbox', { name: /rich formatting/i })).not.toBeChecked();
    });

    it('offers no rich formatting option for a service that does not support it', async () => {
      const user = setupUser();
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [GOTIFY] }) })} />);

      await startEditing(user);

      expect(screen.queryByRole('checkbox', { name: /rich formatting/i })).not.toBeInTheDocument();
    });

    it('stores rich formatting off when the URL is changed to a service that does not support it', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);

      await user.clear(screen.getByLabelText('URL'));
      await user.type(screen.getByLabelText('URL'), 'gotify://host/token');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(onConfigChange.mock.calls[0][0].appriseUrls[0].richFormatting).toBe(false);
    });

    it('refuses an empty URL with a warning', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      const setSnackbar = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange, setSnackbar })} />);
      await startEditing(user);

      await user.clear(screen.getByLabelText('URL'));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(setSnackbar).toHaveBeenCalledWith({ open: true, message: 'URL cannot be empty', severity: 'warning' });
      expect(onConfigChange).not.toHaveBeenCalled();
    });

    it('refuses a URL that another service already uses', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      const setSnackbar = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange, setSnackbar })} />);
      await startEditing(user);

      await user.clear(screen.getByLabelText('URL'));
      await user.type(screen.getByLabelText('URL'), TELEGRAM.url);
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(setSnackbar).toHaveBeenCalledWith({ open: true, message: 'This URL is already added', severity: 'warning' });
      expect(onConfigChange).not.toHaveBeenCalled();
    });

    it('allows saving a service with its own unchanged URL', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(onConfigChange).toHaveBeenCalledTimes(1);
    });

    it('closes the editor after saving', async () => {
      const user = setupUser();
      renderWithProviders(<NotificationsSection {...createProps()} />);
      await startEditing(user);

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(screen.queryByLabelText('URL')).not.toBeInTheDocument();
    });

    it('cancelling discards the changes', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);
      await user.type(screen.getByLabelText('Name'), ' changed');

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onConfigChange).not.toHaveBeenCalled();
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    it('saves when Enter is pressed in the URL field', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);

      await user.type(screen.getByLabelText('URL'), '{Enter}');

      expect(onConfigChange).toHaveBeenCalledTimes(1);
    });

    it('cancels when Escape is pressed', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user);

      await user.type(screen.getByLabelText('Name'), '{Escape}');

      expect(screen.queryByLabelText('URL')).not.toBeInTheDocument();
      expect(onConfigChange).not.toHaveBeenCalled();
    });

    it('edits only the chosen service', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await startEditing(user, 1);

      await user.clear(screen.getByLabelText('Name'));
      await user.type(screen.getByLabelText('Name'), 'Second');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(onConfigChange).toHaveBeenCalledWith({ appriseUrls: [DISCORD, { ...TELEGRAM, name: 'Second' }] });
    });
  });

  describe('adding a service', () => {
    it('leaves rich formatting off for a service that does not support it', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [] }), onConfigChange })} />);

      await user.type(screen.getByLabelText('Notification URL'), 'gotify://host/token');
      await user.click(screen.getByRole('button', { name: /^Add/ }));

      expect(onConfigChange).toHaveBeenCalledWith({ appriseUrls: [{ url: 'gotify://host/token', name: 'Gotify', richFormatting: false }] });
    });

    it('lets rich formatting be turned off for a service that supports it', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [] }), onConfigChange })} />);

      await user.type(screen.getByLabelText('Notification URL'), 'discord://a/b');
      await user.click(screen.getByRole('checkbox', { name: /rich formatting/i }));
      await user.click(screen.getByRole('button', { name: /^Add/ }));

      expect(onConfigChange.mock.calls[0][0].appriseUrls[0].richFormatting).toBe(false);
    });

    it('uses the name that was typed', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [] }), onConfigChange })} />);

      await user.type(screen.getByLabelText('Name (optional)'), '  Work Server  ');
      await user.type(screen.getByLabelText('Notification URL'), 'discord://a/b');
      await user.click(screen.getByRole('button', { name: /^Add/ }));

      expect(onConfigChange.mock.calls[0][0].appriseUrls[0].name).toBe('Work Server');
    });

    it('resets rich formatting to on for the next service', async () => {
      const user = setupUser();
      renderWithProviders(<NotificationsSection {...createProps({ config: createConfig({ appriseUrls: [] }) })} />);
      await user.type(screen.getByLabelText('Notification URL'), 'discord://a/b');
      await user.click(screen.getByRole('checkbox', { name: /rich formatting/i }));
      await user.click(screen.getByRole('button', { name: /^Add/ }));

      await user.type(screen.getByLabelText('Notification URL'), 'discord://c/d');

      expect(screen.getByRole('checkbox', { name: /rich formatting/i })).toBeChecked();
    });
  });

  describe('removing a service', () => {
    it('asks for confirmation before removing', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);

      await user.click(screen.getAllByRole('button', { name: 'Remove notification URL' })[0]);

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(onConfigChange).not.toHaveBeenCalled();
    });

    it('keeps the service when the confirmation is cancelled', async () => {
      const user = setupUser();
      const onConfigChange = jest.fn();
      renderWithProviders(<NotificationsSection {...createProps({ onConfigChange })} />);
      await user.click(screen.getAllByRole('button', { name: 'Remove notification URL' })[0]);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onConfigChange).not.toHaveBeenCalled();
      expect(screen.getByText('My Discord')).toBeInTheDocument();
    });

    it('keeps the editor open when a different service is removed', async () => {
      const user = setupUser();
      renderWithProviders(<NotificationsSection {...createProps()} />);
      await user.click(screen.getAllByRole('button', { name: 'Edit notification URL' })[0]);

      await user.click(screen.getAllByRole('button', { name: 'Remove notification URL' })[0]);
      await user.click(screen.getByRole('button', { name: /^Remove$/ }));

      expect(screen.getByLabelText('URL')).toBeInTheDocument();
    });
  });

  describe('sending a test notification', () => {
    it('shows a sending state while the request is in flight', async () => {
      const user = setupUser();
      mockFetch.mockImplementation(() => new Promise(() => {}));
      renderWithProviders(<NotificationsSection {...createProps()} />);

      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);

      expect(screen.getByText('Sending test...')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Test notification' })[0]).toBeDisabled();
    });

    it('shows the server\'s reason when the test fails', async () => {
      const user = setupUser();
      mockFetch.mockResolvedValue({ ok: false, json: jest.fn().mockResolvedValue({ message: 'Unauthorized' }) });
      renderWithProviders(<NotificationsSection {...createProps()} />);

      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);

      expect(await screen.findByText('✗ Unauthorized')).toBeInTheDocument();
    });

    it('shows a generic message when the server gives no reason', async () => {
      const user = setupUser();
      mockFetch.mockResolvedValue({ ok: false, json: jest.fn().mockResolvedValue({}) });
      renderWithProviders(<NotificationsSection {...createProps()} />);

      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);

      expect(await screen.findByText('✗ Failed to send')).toBeInTheDocument();
    });

    it('reports a network error', async () => {
      const user = setupUser();
      mockFetch.mockRejectedValue(new Error('offline'));
      renderWithProviders(<NotificationsSection {...createProps()} />);

      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);

      expect(await screen.findByText('✗ Network error - check console')).toBeInTheDocument();
    });

    it('reports a network error when the failure response is not JSON', async () => {
      const user = setupUser();
      mockFetch.mockResolvedValue({ ok: false, json: jest.fn().mockRejectedValue(new SyntaxError('bad json')) });
      renderWithProviders(<NotificationsSection {...createProps()} />);

      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);

      expect(await screen.findByText('✗ Network error - check console')).toBeInTheDocument();
    });

    it('tests only the chosen service', async () => {
      const user = setupUser();
      mockFetch.mockResolvedValue({ ok: true });
      renderWithProviders(<NotificationsSection {...createProps()} />);

      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[1]);

      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ url: TELEGRAM.url, name: 'My Telegram', richFormatting: true });
    });

    it('sends an empty token header when there is no token', async () => {
      const user = setupUser();
      mockFetch.mockResolvedValue({ ok: true });
      renderWithProviders(<NotificationsSection {...createProps({ token: null })} />);

      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);

      expect(mockFetch.mock.calls[0][1].headers['x-access-token']).toBe('');
    });

    describe('the success message', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
      });

      it('disappears after five seconds', async () => {
        const user = userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });
        mockFetch.mockResolvedValue({ ok: true });
        renderWithProviders(<NotificationsSection {...createProps()} />);

        await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);
        expect(await screen.findByText('✓ Sent successfully!')).toBeInTheDocument();

        act(() => {
          jest.advanceTimersByTime(5000);
        });

        expect(screen.queryByText('✓ Sent successfully!')).not.toBeInTheDocument();
      });

      it('restarts its countdown when tested again', async () => {
        const user = userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });
        mockFetch.mockResolvedValue({ ok: true });
        renderWithProviders(<NotificationsSection {...createProps()} />);
        await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);
        await screen.findByText('✓ Sent successfully!');

        act(() => {
          jest.advanceTimersByTime(3000);
        });
        await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);
        await screen.findByText('✓ Sent successfully!');
        act(() => {
          jest.advanceTimersByTime(3000);
        });

        expect(screen.getByText('✓ Sent successfully!')).toBeInTheDocument();
      });
    });

    it('drops the test result of a removed service and keeps the others aligned', async () => {
      const user = setupUser();
      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: false, json: jest.fn().mockResolvedValue({ message: 'Bad token' }) });
      const props = createProps();
      const { rerender } = renderWithProviders(<NotificationsSection {...props} />);
      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[0]);
      await screen.findByText('✓ Sent successfully!');
      await user.click(screen.getAllByRole('button', { name: 'Test notification' })[1]);
      await screen.findByText('✗ Bad token');

      await user.click(screen.getAllByRole('button', { name: 'Remove notification URL' })[0]);
      await user.click(screen.getByRole('button', { name: /^Remove$/ }));
      rerender(<NotificationsSection {...props} config={createConfig({ appriseUrls: [TELEGRAM] })} />);

      expect(screen.queryByText('✓ Sent successfully!')).not.toBeInTheDocument();
      expect(screen.getByText('✗ Bad token')).toBeInTheDocument();
    });
  });
});
