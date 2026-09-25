import React, { useContext } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PipPlayerProvider from '../PipPlayerProvider';
import PipPlayerContext from '../../contexts/PipPlayerContext';

interface MockHlsInstance {
  on: jest.Mock;
  loadSource: jest.Mock;
  attachMedia: jest.Mock;
  destroy: jest.Mock;
}

jest.mock('hls.js', () => {
  function MockHls(this: MockHlsInstance) {
    this.on = jest.fn();
    this.loadSource = jest.fn();
    this.attachMedia = jest.fn();
    this.destroy = jest.fn();
  }
  MockHls.isSupported = jest.fn(() => true);
  MockHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
  MockHls.ErrorDetails = {};
  return { __esModule: true, default: MockHls };
});

function PlayButton() {
  const ctx = useContext(PipPlayerContext);
  return <button onClick={() => ctx?.play('abc123', 'My Video')}>Play</button>;
}

describe('PipPlayerProvider', () => {
  test('a play() call from a consumer surfaces the video in the floating panel', async () => {
    const user = userEvent.setup();
    render(
      <PipPlayerProvider>
        <PlayButton />
      </PipPlayerProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Play' }));

    expect(await screen.findByText('My Video')).toBeInTheDocument();
  });

  test('renders children even before anything plays', () => {
    render(
      <PipPlayerProvider>
        <div>App content</div>
      </PipPlayerProvider>
    );

    expect(screen.getByText('App content')).toBeInTheDocument();
  });
});
