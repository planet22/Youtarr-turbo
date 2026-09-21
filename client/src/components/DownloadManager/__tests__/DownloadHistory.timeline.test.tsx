import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DownloadHistory from '../DownloadHistory';
import { Job } from '../../../types/Job';

jest.mock('../../../hooks/useConfig', () => ({
  useConfig: () => ({ config: {} }),
}));

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  jobType: 'Manually Added Urls',
  status: 'Complete',
  output: '',
  timeCreated: Date.parse('2026-09-19T17:12:00Z'),
  timeInitiated: Date.parse('2026-09-19T17:12:00Z'),
  data: {
    videos: [
      {
        id: 1, youtubeId: 'abc', youTubeChannelName: 'Chan', youTubeVideoName: 'A video',
        timeCreated: '', originalDate: null, duration: null, description: null,
      },
    ],
  },
  ...over,
});

const renderHistory = (props: Partial<React.ComponentProps<typeof DownloadHistory>> = {}, isMobile = false) =>
  render(
    <DownloadHistory
      jobs={[job('job-1')]}
      currentTime={new Date()}
      expanded={{}}
      handleExpandCell={jest.fn()}
      isMobile={isMobile}
      token="tok"
      {...props}
    />
  );

describe('DownloadHistory timeline link', () => {
  beforeEach(() => window.localStorage.clear());

  test('offers no Timeline link unless a handler is given', () => {
    renderHistory();

    expect(screen.queryByRole('button', { name: 'Timeline' })).not.toBeInTheDocument();
  });

  test('offers a Timeline link on each job when a handler is given', () => {
    renderHistory({ onOpenTimeline: jest.fn() });

    expect(screen.getByRole('button', { name: 'Timeline' })).toBeInTheDocument();
  });

  test('opens that job\'s timeline when clicked', async () => {
    const onOpenTimeline = jest.fn();
    renderHistory({ onOpenTimeline });

    await userEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    expect(onOpenTimeline).toHaveBeenCalledWith('job-1');
  });

  test('offers a link per job', () => {
    renderHistory({ jobs: [job('job-1'), job('job-2')], onOpenTimeline: jest.fn() });

    expect(screen.getAllByRole('button', { name: 'Timeline' })).toHaveLength(2);
  });

  test('is available on the mobile cards too', () => {
    renderHistory({ onOpenTimeline: jest.fn() }, true);

    expect(screen.getByRole('button', { name: 'Timeline' })).toBeInTheDocument();
  });

  test('clicking it does not toggle a multi-video row open', async () => {
    const handleExpandCell = jest.fn();
    const multi = job('job-1');
    multi.data.videos = [
      { id: 1, youtubeId: 'a', youTubeChannelName: 'C', youTubeVideoName: 'One', timeCreated: '', originalDate: null, duration: null, description: null },
      { id: 2, youtubeId: 'b', youTubeChannelName: 'C', youTubeVideoName: 'Two', timeCreated: '', originalDate: null, duration: null, description: null },
    ];
    renderHistory({ jobs: [multi], handleExpandCell, onOpenTimeline: jest.fn() });

    await userEvent.click(screen.getByRole('button', { name: 'Timeline' }));

    expect(handleExpandCell).not.toHaveBeenCalled();
  });
});
