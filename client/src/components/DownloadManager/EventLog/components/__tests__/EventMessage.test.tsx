import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventMessage from '../EventMessage';

const LONG_MESSAGE = 'Buffered cache promoted to a library file at /videos/Some Channel/Some Channel - A very long video title - abc123/Some Channel - A very long video title [abc123].mp4';

describe('EventMessage', () => {
  test('shows a short message in full with no link', () => {
    render(<EventMessage message="Download started" expanded={false} onMore={jest.fn()} />);

    expect(screen.getByText('Download started')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'more…' })).not.toBeInTheDocument();
  });

  test('cuts a long message and offers more', () => {
    render(<EventMessage message={LONG_MESSAGE} expanded={false} onMore={jest.fn()} />);

    expect(screen.queryByText(LONG_MESSAGE)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'more…' })).toBeInTheDocument();
  });

  test('keeps the start of the message', () => {
    render(<EventMessage message={LONG_MESSAGE} expanded={false} onMore={jest.fn()} />);

    expect(screen.getByText(/^Buffered cache promoted to a library file/)).toBeInTheDocument();
  });

  test('opens the row when more is clicked', async () => {
    const onMore = jest.fn();
    render(<EventMessage message={LONG_MESSAGE} expanded={false} onMore={onMore} />);

    await userEvent.click(screen.getByRole('button', { name: 'more…' }));

    expect(onMore).toHaveBeenCalledTimes(1);
  });

  test('shows the whole message, with no link, once the row is open', () => {
    render(<EventMessage message={LONG_MESSAGE} expanded onMore={jest.fn()} />);

    expect(screen.getByText(LONG_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'more…' })).not.toBeInTheDocument();
  });
});
