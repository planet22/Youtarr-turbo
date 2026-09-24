import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import StreamThumbnail from '../StreamThumbnail';

describe('StreamThumbnail', () => {
  test('loads the shared video thumbnail', () => {
    render(<StreamThumbnail youtubeId="abc123" alt="A Video" />);
    expect(screen.getByRole('img', { name: 'A Video' })).toHaveAttribute('src', '/images/videothumb-abc123.jpg');
  });

  test('shows a blank placeholder instead of alt text when the thumbnail fails', () => {
    render(<StreamThumbnail youtubeId="abc123" alt="A Video" />);
    fireEvent.error(screen.getByRole('img', { name: 'A Video' }));
    expect(screen.getByRole('img', { name: 'A Video' })).not.toHaveAttribute('src');
  });
});
