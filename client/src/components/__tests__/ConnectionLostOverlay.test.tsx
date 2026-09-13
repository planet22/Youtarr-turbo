import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConnectionLostOverlay from '../ConnectionLostOverlay';
import WebSocketContext from '../../contexts/WebSocketContext';

const renderWithConnection = (isConnected: boolean) =>
  render(
    <WebSocketContext.Provider
      value={{
        socket: null,
        isConnected,
        subscribe: jest.fn(),
        unsubscribe: jest.fn(),
      }}
    >
      <ConnectionLostOverlay />
    </WebSocketContext.Provider>
  );

describe('ConnectionLostOverlay', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  test('renders nothing while connected', () => {
    renderWithConnection(true);
    expect(screen.queryByTestId('connection-lost-overlay')).not.toBeInTheDocument();
  });

  test('does not flash immediately on disconnect', () => {
    renderWithConnection(false);
    expect(screen.queryByTestId('connection-lost-overlay')).not.toBeInTheDocument();
  });

  test('shows the overlay after the disconnect persists past the debounce delay', () => {
    renderWithConnection(false);

    act(() => {
      jest.advanceTimersByTime(1200);
    });

    expect(screen.getByTestId('connection-lost-overlay')).toBeInTheDocument();
    expect(screen.getByText('Connection to Backend Lost')).toBeInTheDocument();
  });

  test('hides again once reconnected', () => {
    const { rerender } = render(
      <WebSocketContext.Provider
        value={{ socket: null, isConnected: false, subscribe: jest.fn(), unsubscribe: jest.fn() }}
      >
        <ConnectionLostOverlay />
      </WebSocketContext.Provider>
    );

    act(() => {
      jest.advanceTimersByTime(1200);
    });
    expect(screen.getByTestId('connection-lost-overlay')).toBeInTheDocument();

    rerender(
      <WebSocketContext.Provider
        value={{ socket: {} as WebSocket, isConnected: true, subscribe: jest.fn(), unsubscribe: jest.fn() }}
      >
        <ConnectionLostOverlay />
      </WebSocketContext.Provider>
    );

    expect(screen.queryByTestId('connection-lost-overlay')).not.toBeInTheDocument();
  });
});
