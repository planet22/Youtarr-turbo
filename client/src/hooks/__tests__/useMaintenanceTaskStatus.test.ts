import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import axios from 'axios';
import { useMaintenanceTaskStatus, MaintenanceTaskStatusConfig } from '../useMaintenanceTaskStatus';
import WebSocketContext from '../../contexts/WebSocketContext';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: (err: unknown): boolean =>
    typeof err === 'object' && err !== null && 'response' in err
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

interface TestLastRun {
  startedAt: string;
  status: string;
}

type Subscriber = {
  filter: (msg: unknown) => boolean;
  callback: (msg: unknown) => void;
};

function makeWrapper(subscribers: Subscriber[]) {
  const value = {
    socket: null,
    isConnected: false,
    subscribe: (filter: (msg: unknown) => boolean, callback: (msg: unknown) => void) => {
      subscribers.push({ filter, callback });
    },
    unsubscribe: (callback: (msg: unknown) => void) => {
      const idx = subscribers.findIndex((s) => s.callback === callback);
      if (idx >= 0) subscribers.splice(idx, 1);
    }
  };
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(WebSocketContext.Provider, { value }, children);
  }
  return Wrapper;
}

const config: MaintenanceTaskStatusConfig = {
  statusUrl: '/api/maintenance/example-status',
  triggerUrl: '/api/maintenance/example-run',
  wsMessageType: 'exampleTaskStatus',
  loadErrorMessage: 'Failed to load example status',
  alreadyRunningMessage: 'Example task already in progress',
  triggerErrorMessage: 'Failed to start example task',
};

describe('useMaintenanceTaskStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fetches initial status from the configured statusUrl on mount', async () => {
    const lastRun: TestLastRun = { startedAt: '2026-05-04T15:00:00.000Z', status: 'completed' };
    mockedAxios.get.mockResolvedValueOnce({ data: { running: false, lastRun } });

    const { result } = renderHook(
      () => useMaintenanceTaskStatus<TestLastRun>('tok', config),
      { wrapper: makeWrapper([]) }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.running).toBe(false);
    expect(result.current.lastRun).toEqual(lastRun);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      '/api/maintenance/example-status',
      expect.objectContaining({ headers: { 'x-access-token': 'tok' } })
    );
  });

  test('surfaces a load failure via the configured loadErrorMessage', async () => {
    mockedAxios.get.mockRejectedValueOnce('not an Error instance');

    const { result } = renderHook(
      () => useMaintenanceTaskStatus<TestLastRun>('tok', config),
      { wrapper: makeWrapper([]) }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to load example status');
  });

  test('updates state from WebSocket messages matching wsMessageType', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { running: false, lastRun: null } });

    const subscribers: Subscriber[] = [];
    const { result } = renderHook(
      () => useMaintenanceTaskStatus<TestLastRun>('tok', config),
      { wrapper: makeWrapper(subscribers) }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      const startMsg = { type: 'exampleTaskStatus', payload: { running: true } };
      subscribers.forEach((s) => s.filter(startMsg) && s.callback(startMsg.payload));
    });
    expect(result.current.running).toBe(true);

    const lastRun: TestLastRun = { startedAt: '2026-05-04T15:00:00.000Z', status: 'completed' };
    act(() => {
      const endMsg = { type: 'exampleTaskStatus', payload: { running: false, lastRun } };
      subscribers.forEach((s) => s.filter(endMsg) && s.callback(endMsg.payload));
    });
    expect(result.current.running).toBe(false);
    expect(result.current.lastRun).toEqual(lastRun);
  });

  test('ignores WebSocket messages of a different type', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { running: false, lastRun: null } });

    const subscribers: Subscriber[] = [];
    const { result } = renderHook(
      () => useMaintenanceTaskStatus<TestLastRun>('tok', config),
      { wrapper: makeWrapper(subscribers) }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      const otherMsg = { type: 'someOtherTaskStatus', payload: { running: true } };
      subscribers.forEach((s) => s.filter(otherMsg) && s.callback(otherMsg.payload));
    });
    expect(result.current.running).toBe(false);
  });

  test('trigger() POSTs to triggerUrl and clears prior error', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { running: false, lastRun: null } });
    mockedAxios.post.mockResolvedValueOnce({ status: 202, data: { status: 'started' } });

    const { result } = renderHook(
      () => useMaintenanceTaskStatus<TestLastRun>('tok', config),
      { wrapper: makeWrapper([]) }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.trigger();
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/maintenance/example-run',
      undefined,
      expect.objectContaining({ headers: { 'x-access-token': 'tok' } })
    );
    expect(result.current.error).toBeNull();
    expect(result.current.running).toBe(true);
  });

  test('trigger() surfaces a 409 conflict using alreadyRunningMessage as a fallback', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { running: false, lastRun: null } });
    const err = new Error('Conflict') as Error & { response: { status: number; data: Record<string, never> } };
    err.response = { status: 409, data: {} };
    mockedAxios.post.mockRejectedValueOnce(err);

    const { result } = renderHook(
      () => useMaintenanceTaskStatus<TestLastRun>('tok', config),
      { wrapper: makeWrapper([]) }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.trigger();
    });

    expect(result.current.error).toBe('Example task already in progress');
    expect(result.current.running).toBe(true);
  });

  test('trigger() reverts optimistic running state and uses triggerErrorMessage when the error has no message', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { running: false, lastRun: null } });
    mockedAxios.post.mockRejectedValueOnce('not an Error instance');

    const { result } = renderHook(
      () => useMaintenanceTaskStatus<TestLastRun>('tok', config),
      { wrapper: makeWrapper([]) }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.trigger();
    });

    expect(result.current.running).toBe(false);
    expect(result.current.error).toBe('Failed to start example task');
  });
});
