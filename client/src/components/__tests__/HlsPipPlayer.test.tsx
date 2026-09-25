import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HlsPipPlayer from '../HlsPipPlayer';
import { PipPlayerState, UseHlsPipPlayerReturn } from '../../hooks/useHlsPipPlayer';

function makePlayer(state: PipPlayerState, close = jest.fn()): UseHlsPipPlayerReturn {
  return {
    videoRef: { current: null },
    state,
    play: jest.fn(),
    close,
  };
}

describe('HlsPipPlayer', () => {
  test('shows the title and a loading label while loading', () => {
    render(
      <HlsPipPlayer
        player={makePlayer({ youtubeId: 'abc123', title: 'My Video', status: 'loading', errorMessage: null })}
      />
    );

    expect(screen.getByText('My Video')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  test('shows the Picture-in-Picture status once handed off to the browser window', () => {
    render(
      <HlsPipPlayer
        player={makePlayer({ youtubeId: 'abc123', title: 'My Video', status: 'pip', errorMessage: null })}
      />
    );

    expect(screen.getByText('Playing in Picture-in-Picture')).toBeInTheDocument();
  });

  test('shows the error message when playback fails', () => {
    render(
      <HlsPipPlayer
        player={makePlayer({ youtubeId: 'abc123', title: 'My Video', status: 'error', errorMessage: 'bufferStalledError' })}
      />
    );

    expect(screen.getByText('bufferStalledError')).toBeInTheDocument();
    expect(screen.getByText('Failed to play')).toBeInTheDocument();
  });

  test('clicking Stop calls close()', async () => {
    const user = userEvent.setup();
    const close = jest.fn();
    render(
      <HlsPipPlayer
        player={makePlayer({ youtubeId: 'abc123', title: 'My Video', status: 'playing', errorMessage: null }, close)}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Stop PiP preview' }));
    expect(close).toHaveBeenCalled();
  });
});
