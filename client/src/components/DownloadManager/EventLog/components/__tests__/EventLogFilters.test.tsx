import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventLogFilters from '../EventLogFilters';
import type { JobEventFilters } from '../../../../../types/JobEvent';

describe('EventLogFilters', () => {
  const setup = (filters: JobEventFilters = {}, props: Partial<React.ComponentProps<typeof EventLogFilters>> = {}) => {
    const handlers = {
      onSearchTextChange: jest.fn(),
      onLevelChange: jest.fn(),
      onClearJob: jest.fn(),
      onClearVideo: jest.fn(),
    };
    render(<EventLogFilters filters={filters} searchText="" {...handlers} {...props} />);
    return handlers;
  };

  test('shows the current search text', () => {
    setup({}, { searchText: 'juice' });

    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveValue('juice');
  });

  test('reports typing in the search box', () => {
    const { onSearchTextChange } = setup();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: 'juice' } });

    expect(onSearchTextChange).toHaveBeenCalledWith('juice');
  });

  test('has a level filter', () => {
    setup();

    expect(screen.getByText('Level')).toBeInTheDocument();
  });

  test('shows no filter chips when nothing is filtered', () => {
    setup();

    expect(screen.queryByText(/^Job:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Video:/)).not.toBeInTheDocument();
  });

  test('shows a job chip with the friendly label when known', () => {
    setup({ jobId: 'job-1' }, { jobLabel: 'Channel Downloads' });

    expect(screen.getByText('Job: Channel Downloads')).toBeInTheDocument();
  });

  test('falls back to the raw job id on the chip', () => {
    setup({ jobId: 'job-1' });

    expect(screen.getByText('Job: job-1')).toBeInTheDocument();
  });

  test('shows a video chip with the video title when known', () => {
    setup({ youtubeId: 'abc' }, { videoLabel: 'Celebrity Juice S26E09' });

    expect(screen.getByText('Video: Celebrity Juice S26E09')).toBeInTheDocument();
  });

  test('clears the job filter from its chip', async () => {
    const { onClearJob } = setup({ jobId: 'job-1' });

    await userEvent.click(screen.getByLabelText('Remove'));

    expect(onClearJob).toHaveBeenCalled();
  });

  test('clears the video filter from its chip', async () => {
    const { onClearVideo } = setup({ youtubeId: 'abc' });

    await userEvent.click(screen.getByLabelText('Remove'));

    expect(onClearVideo).toHaveBeenCalled();
  });
});
