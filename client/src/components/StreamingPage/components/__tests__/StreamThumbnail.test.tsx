import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import StreamThumbnail from '../StreamThumbnail';

describe('StreamThumbnail', () => {
  test('shows the local thumbnail first', () => {
    render(<StreamThumbnail youtubeId="abc123" alt="A Video" />);
    expect(screen.getByRole('img', { name: 'A Video' })).toHaveAttribute('src', '/images/videothumb-abc123.jpg');
  });

  test('falls back to the YouTube thumbnail when the local one is missing', () => {
    render(<StreamThumbnail youtubeId="abc123" alt="A Video" />);
    fireEvent.error(screen.getByRole('img', { name: 'A Video' }));
    expect(screen.getByRole('img', { name: 'A Video' })).toHaveAttribute('src', 'https://i.ytimg.com/vi/abc123/hqdefault.jpg');
  });

  test('shows a blank placeholder instead of alt text when both images fail', () => {
    render(<StreamThumbnail youtubeId="abc123" alt="A Video" />);
    fireEvent.error(screen.getByRole('img', { name: 'A Video' }));
    fireEvent.error(screen.getByRole('img', { name: 'A Video' }));
    expect(screen.getByRole('img', { name: 'A Video' })).not.toHaveAttribute('src');
  });
});
