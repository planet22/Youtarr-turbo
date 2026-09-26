import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import DownloadManager from '../DownloadManager';
import WebSocketContext from '../../contexts/WebSocketContext';

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('../../hooks/useConfig', () => ({
  useConfig: () => ({ config: {} }),
}));

jest.mock('../DownloadManager/DownloadNew', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', { 'data-testid': 'download-new' }),
}));
jest.mock('../DownloadManager/DownloadProgress', () => ({
  __esModule: true,
  default: () => require('react').createElement('div', { 'data-testid': 'download-progress' }),
}));
jest.mock('../DownloadManager/DownloadHistory', () => ({
  __esModule: true,
  default: ({ onOpenTimeline }: { onOpenTimeline?: (jobId: string) => void }) =>
    require('react').createElement('div', { 'data-testid': 'download-history' },
      require('react').createElement('button', { onClick: () => onOpenTimeline && onOpenTimeline('job 9') }, 'open timeline')),
}));
jest.mock('../DownloadManager/EventLog', () => ({
  __esModule: true,
  default: ({ token }: { token: string | null }) =>
    require('react').createElement('div', { 'data-testid': 'event-log' }, `token=${token}`),
}));

describe('DownloadManager event log route', () => {
  beforeEach(() => {
    (axios as jest.Mocked<typeof axios>).get.mockResolvedValue({ data: [] });
  });

  const renderAt = (path: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <WebSocketContext.Provider
          value={{ socket: null, isConnected: false, subscribe: jest.fn(), unsubscribe: jest.fn() }}
        >
          <DownloadManager token="tok-1" />
        </WebSocketContext.Provider>
      </MemoryRouter>
    );

  test('renders the event log at /log', () => {
    renderAt('/log');

    expect(screen.getByTestId('event-log')).toBeInTheDocument();
  });

  test('passes the token to the event log', () => {
    renderAt('/log');

    expect(screen.getByTestId('event-log')).toHaveTextContent('token=tok-1');
  });

  test('does not render the event log on the history route', () => {
    renderAt('/history');

    expect(screen.queryByTestId('event-log')).not.toBeInTheDocument();
  });

  test('the Timeline link on a History row lands on the event log', async () => {
    render(
      <MemoryRouter initialEntries={['/downloads/history']}>
        <WebSocketContext.Provider
          value={{ socket: null, isConnected: false, subscribe: jest.fn(), unsubscribe: jest.fn() }}
        >
          <Routes>
            <Route path="/downloads/*" element={<DownloadManager token="tok-1" />} />
          </Routes>
        </WebSocketContext.Provider>
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole('button', { name: 'open timeline' }));

    expect(screen.getByTestId('event-log')).toBeInTheDocument();
  });
});
