import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WebSocketContext from './contexts/WebSocketContext';
import ProfileContext, { ProfileContextValue, ProfileSummary } from './contexts/ProfileContext';
import { ThemeEngineProvider } from './contexts/ThemeEngineContext';
import { TooltipProvider } from './components/ui/tooltip';

type WebSocketValue = {
  socket: any;
  isConnected: boolean;
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
} | null;

export function createMockWebSocketContext(): NonNullable<WebSocketValue> {
  return {
    socket: null,
    isConnected: false,
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
  };
}

export function renderWithProviders(
  ui: React.ReactElement,
  opts?: { websocketValue?: WebSocketValue }
) {
  const value = opts?.websocketValue ?? createMockWebSocketContext();

  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter>
        <ThemeEngineProvider>
          <WebSocketContext.Provider value={value}>
            <TooltipProvider>
              {children}
            </TooltipProvider>
          </WebSocketContext.Provider>
        </ThemeEngineProvider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper });
}

/**
 * Wrapper for renderHook/render that makes `profile` the active user profile
 * (ProfileContext's default is "no profiles", matching the pre-profiles app).
 */
export function createActiveProfileWrapper(profile: ProfileSummary) {
  const value: ProfileContextValue = {
    profiles: [profile],
    activeProfileId: profile.id,
    activeProfile: profile,
    setActiveProfileId: jest.fn(),
    refresh: jest.fn().mockResolvedValue(undefined),
  };
  return function ActiveProfileWrapper({ children }: { children: React.ReactNode }) {
    return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
  };
}
