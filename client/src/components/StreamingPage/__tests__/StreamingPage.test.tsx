import React from 'react';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import StreamingPage from '../index';
import { renderWithProviders } from '../../../test-utils';
import type { StreamSnapshot } from '../../../hooks/useActiveStreams';

const mockRefetch = jest.fn();
let mockStreams: StreamSnapshot[] = [];
let mockByteRange: { total: number; encoding: number; finished: number } | null = null;
let mockLoading = false;
let mockIsMobile = false;

jest.mock('../../../hooks/useMediaQuery', () => ({
  useMediaQuery: () => mockIsMobile,
}));
jest.mock('../../../hooks/useActiveStreams', () => ({
  useActiveStreams: () => ({ streams: mockStreams, byteRangeSessions: mockByteRange, loading: mockLoading, refetch: mockRefetch }),
}));

// The row/card views and dialogs have their own tests; stub them so this
// file checks what the page hands them and how it reacts to their callbacks.
jest.mock('../components/StreamsTable', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: (props: { streams: Array<{ streamId: string }>; onStopped: () => void; onOpenSegments: (id: string) => void; onOpenByteRange: (id: string) => void }) =>
      React.createElement(
        'div',
        { 'data-testid': 'table-view' },
        React.createElement('span', { 'data-testid': 'table-order' }, props.streams.map((s) => s.streamId).join(',')),
        React.createElement('button', { onClick: props.onStopped }, 'table stopped'),
        React.createElement('button', { onClick: () => props.onOpenSegments(props.streams[0].streamId) }, 'table segments'),
        React.createElement('button', { onClick: () => props.onOpenByteRange(props.streams[0].streamId) }, 'table byterange')
      ),
  };
});
jest.mock('../components/StreamCard', () => {
  const React = require('react');
  return { __esModule: true, default: (props: { stream: { streamId: string } }) => React.createElement('div', null, `card ${props.stream.streamId}`) };
});
jest.mock('../components/StreamsListMobile', () => {
  const React = require('react');
  return { __esModule: true, default: (props: { streams: Array<{ streamId: string }> }) => React.createElement('div', null, `list: ${props.streams.map((s) => s.streamId).join(',')}`) };
});
jest.mock('../components/SegmentActivityGrid', () => {
  const React = require('react');
  return {
    SegmentActivityDialog: (props: { open: boolean; title: string; variant: string; onClose: () => void }) =>
      props.open ? React.createElement('div', null, `segments dialog: ${props.title} (${props.variant})`, React.createElement('button', { onClick: props.onClose }, 'close segments')) : null,
    segmentVariantForMode: (mode: string) => (mode === 'hls-buffer' ? 'buffer' : 'encode'),
  };
});
jest.mock('../components/ByteRangeProgressGrid', () => {
  const React = require('react');
  return {
    ByteRangeProgressDialog: (props: { open: boolean; title: string; youtubeId: string; sessionKey: string; onClose: () => void }) =>
      props.open ? React.createElement('div', null, `byterange dialog: ${props.title} ${props.youtubeId} ${props.sessionKey}`, React.createElement('button', { onClick: props.onClose }, 'close byterange')) : null,
  };
});
jest.mock('../components/StreamingSettingsLine', () => {
  const React = require('react');
  return { StreamingSettingsLine: () => React.createElement('div', null, 'settings line') };
});

const stream = (overrides: Partial<StreamSnapshot>): StreamSnapshot => ({
  streamId: 's1',
  youtubeId: 'yt1',
  title: 'First video',
  clientIp: '10.0.0.1',
  userAgent: 'Jellyfin',
  mode: 'hls',
  startedAt: 1000,
  bytesPerSecond: 100,
  bytesTransferred: 500,
  ...overrides,
} as StreamSnapshot);

const renderPage = () => {
  const user = userEvent.setup({ delay: null });
  const view = renderWithProviders(<StreamingPage token="tok" />);
  return { user, ...view };
};

describe('StreamingPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockStreams = [
      stream({ streamId: 'a', youtubeId: 'ytA', title: 'Alpha cats', clientIp: '10.0.0.1', userAgent: 'Jellyfin', startedAt: 1000, bytesPerSecond: 300, bytesTransferred: 10 }),
      stream({ streamId: 'b', youtubeId: 'ytB', title: 'Beta dogs', clientIp: '192.168.1.5', userAgent: 'Chrome', startedAt: 3000, bytesPerSecond: 100, bytesTransferred: 30 }),
      stream({ streamId: 'c', youtubeId: 'ytC', title: 'Gamma', clientIp: '172.16.0.9', userAgent: 'Safari', startedAt: 2000, bytesPerSecond: 200, bytesTransferred: 20 }),
    ];
    mockByteRange = null;
    mockLoading = false;
    mockIsMobile = false;
  });

  describe('header', () => {
    it('shows how many streams are active', () => {
      renderPage();

      expect(screen.getByText('Live Streams (3 active)')).toBeInTheDocument();
    });

    it('shows zero when nothing is streaming', () => {
      mockStreams = [];

      renderPage();

      expect(screen.getByText('Live Streams (0 active)')).toBeInTheDocument();
    });

    it('shows byte-range session counts when some are held', () => {
      mockByteRange = { total: 3, encoding: 1, finished: 2 };

      renderPage();

      expect(screen.getByText(/Byte-range sessions held: 3 \(1 encoding, 2 finished/)).toBeInTheDocument();
    });

    it.each([[null], [{ total: 0, encoding: 0, finished: 0 }]])('hides the byte-range line for %p', (value) => {
      mockByteRange = value;

      renderPage();

      expect(screen.queryByText(/Byte-range sessions held/)).not.toBeInTheDocument();
    });

    it('always shows the streaming settings summary', () => {
      renderPage();

      expect(screen.getByText('settings line')).toBeInTheDocument();
    });
  });

  describe('views', () => {
    it('shows the table on desktop', () => {
      renderPage();

      expect(screen.getByTestId('table-view')).toBeInTheDocument();
    });

    it('shows the dense list on mobile', () => {
      mockIsMobile = true;

      renderPage();

      expect(screen.getByText(/^list:/)).toBeInTheDocument();
      expect(screen.queryByTestId('table-view')).not.toBeInTheDocument();
    });

    it('switches a stored list view back to the table on desktop', () => {
      window.localStorage.setItem('youtarr:viewMode', 'list');
      window.localStorage.setItem('viewMode', 'list');

      renderPage();

      expect(screen.getByTestId('table-view')).toBeInTheDocument();
    });
  });

  describe('sorting', () => {
    const order = () => screen.getByTestId('table-order').textContent;

    it('lists the most recently started stream first by default', () => {
      renderPage();

      expect(order()).toBe('b,c,a');
    });
  });

  describe('search', () => {
    const search = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
      await user.type(screen.getByPlaceholderText('Search by video, IP, or client...'), text);
    };

    it.each([
      ['title', 'cats', 'a'],
      ['YouTube id', 'ytb', 'b'],
      ['client IP', '172.16', 'c'],
      ['user agent', 'safari', 'c'],
    ])('finds a stream by its %s', async (_label, text, expected) => {
      const { user } = renderPage();

      await search(user, text);

      await waitFor(() => expect(screen.getByTestId('table-order')).toHaveTextContent(new RegExp(`^${expected}$`)));
    });

    it('ignores case and surrounding spaces', async () => {
      const { user } = renderPage();

      await search(user, '  ALPHA  ');

      await waitFor(() => expect(screen.getByTestId('table-order')).toHaveTextContent(/^a$/));
    });

    it('updates the active count only from the total, not the filter', async () => {
      const { user } = renderPage();

      await search(user, 'cats');

      expect(screen.getByText('Live Streams (3 active)')).toBeInTheDocument();
    });

    it('tolerates streams with missing fields', async () => {
      mockStreams = [stream({ streamId: 'x', title: undefined as never, clientIp: undefined as never, userAgent: undefined as never, youtubeId: 'ytX' })];
      const { user } = renderPage();

      await search(user, 'ytx');

      await waitFor(() => expect(screen.getByTestId('table-order')).toHaveTextContent(/^x$/));
    });
  });

  describe('refreshing', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('re-reads the streams every ten seconds', () => {
      renderPage();

      act(() => {
        jest.advanceTimersByTime(30000);
      });

      expect(mockRefetch).toHaveBeenCalledTimes(3);
    });

    it('stops refreshing when the page is left', () => {
      const { unmount } = renderWithProviders(<StreamingPage token="tok" />);
      act(() => {
        jest.advanceTimersByTime(10000);
      });

      unmount();
      act(() => {
        jest.advanceTimersByTime(30000);
      });

      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('dialogs and callbacks', () => {
    it('refetches when a stream is stopped', async () => {
      const { user } = renderPage();

      await user.click(screen.getByRole('button', { name: 'table stopped' }));

      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });

    it('opens the segment dialog for the chosen stream with its variant', async () => {
      mockStreams = [stream({ streamId: 'a', title: 'Alpha', mode: 'hls-buffer' })];
      const { user } = renderPage();

      await user.click(screen.getByRole('button', { name: 'table segments' }));

      expect(screen.getByText('segments dialog: Alpha (buffer)')).toBeInTheDocument();
    });

    it('titles the segment dialog by YouTube id when the stream has no title', async () => {
      mockStreams = [stream({ streamId: 'a', title: '', youtubeId: 'ytOnly' })];
      const { user } = renderPage();

      await user.click(screen.getByRole('button', { name: 'table segments' }));

      expect(screen.getByText(/segments dialog: ytOnly/)).toBeInTheDocument();
    });

    it('closes the segment dialog', async () => {
      const { user } = renderPage();
      await user.click(screen.getByRole('button', { name: 'table segments' }));

      await user.click(screen.getByRole('button', { name: 'close segments' }));

      expect(screen.queryByText(/segments dialog/)).not.toBeInTheDocument();
    });

    it('opens the byte-range dialog for the chosen stream', async () => {
      const { user } = renderPage();

      await user.click(screen.getByRole('button', { name: 'table byterange' }));

      expect(screen.getByText('byterange dialog: Beta dogs ytB b')).toBeInTheDocument();
    });

    it('closes the byte-range dialog', async () => {
      const { user } = renderPage();
      await user.click(screen.getByRole('button', { name: 'table byterange' }));

      await user.click(screen.getByRole('button', { name: 'close byterange' }));

      expect(screen.queryByText(/byterange dialog/)).not.toBeInTheDocument();
    });
  });
});
