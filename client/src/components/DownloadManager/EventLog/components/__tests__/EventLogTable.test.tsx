import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventLogTable from '../EventLogTable';
import type { JobEvent } from '../../../../../types/JobEvent';

const event = (id: number, over: Partial<JobEvent> = {}): JobEvent => ({
  id,
  occurredAt: `2026-09-19T17:12:00.${String(id * 100).padStart(3, '0')}Z`,
  jobId: 'job-1',
  youtubeId: 'abc123',
  eventType: 'nzb.untracked',
  level: 'info',
  actor: 'nzb',
  message: `Message ${id}`,
  detail: null,
  videoTitle: 'Celebrity Juice S26E09',
  channelName: 'pcrobec',
  jobType: 'Sonarr/Radarr: TV [abc123]',
  source: 'NZB (TV)',
  isTracked: true,
  ...over,
});

describe('EventLogTable', () => {
  const setup = (events: JobEvent[], props: Partial<React.ComponentProps<typeof EventLogTable>> = {}) => {
    const onSelectVideo = jest.fn();
    const onSelectJob = jest.fn();
    const onOpenVideo = jest.fn();
    render(
      <EventLogTable
        events={events}
        timeline={false}
        isMobile={false}
        onSelectVideo={onSelectVideo}
        onSelectJob={onSelectJob}
        onOpenVideo={onOpenVideo}
        {...props}
      />
    );
    return { onSelectVideo, onSelectJob, onOpenVideo };
  };

  describe('desktop table', () => {
    test('shows each event message', () => {
      setup([event(1), event(2)]);

      expect(screen.getByText('Message 1')).toBeInTheDocument();
      expect(screen.getByText('Message 2')).toBeInTheDocument();
    });

    test('shows the time with milliseconds', () => {
      setup([event(5)]);

      expect(screen.getByText(/\.500/)).toBeInTheDocument();
    });

    test('stacks the date over the time so the column can be narrow', () => {
      setup([event(5)]);

      expect(screen.getByText(/^[A-Z][a-z]{2} \d{1,2}$/)).toBeInTheDocument();
      expect(screen.getByText(/:\d{2}\.500/)).toBeInTheDocument();
    });

    test('cuts a long event message and offers more', () => {
      setup([event(1, { message: 'File finalized at ' + '/very/long/path/segment'.repeat(10) })]);

      expect(screen.getByRole('button', { name: 'more…' })).toBeInTheDocument();
    });

    test('opens the row, showing the whole message, when more is clicked', async () => {
      const message = 'File finalized at ' + '/very/long/path/segment'.repeat(10);
      setup([event(1, { message })]);

      await userEvent.click(screen.getByRole('button', { name: 'more…' }));

      expect(screen.getByRole('button', { name: 'Hide details' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'more…' })).not.toBeInTheDocument();
    });

    test('does not offer more on a short message', () => {
      setup([event(1)]);

      expect(screen.queryByRole('button', { name: 'more…' })).not.toBeInTheDocument();
    });

    test('shows the event type in its own column', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Type' })).toBeInTheDocument();
      expect(screen.getByText('nzb.untracked')).toBeInTheDocument();
    });

    test('shows the component in its own column, in plain words', () => {
      setup([event(1, { actor: 'media-server' })]);

      expect(screen.getByRole('columnheader', { name: 'Component' })).toBeInTheDocument();
      expect(screen.getByText('Media server')).toBeInTheDocument();
    });

    test('shows the channel in its own column', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Channel' })).toBeInTheDocument();
    });

    test('shows the source label stored with the event', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'NZB (TV)' })).toBeInTheDocument();
    });

    test('shows the video snapshot title and channel', () => {
      setup([event(1)]);

      expect(screen.getByRole('button', { name: 'Celebrity Juice S26E09' })).toBeInTheDocument();
      expect(screen.getByText('pcrobec')).toBeInTheDocument();
    });

    test('falls back to the youtube id when there is no title snapshot', () => {
      setup([event(1, { videoTitle: null })]);

      expect(screen.getByRole('button', { name: 'abc123' })).toBeInTheDocument();
    });

    test('names the job for a job-level event with no video, instead of a dash', () => {
      setup([event(1, { youtubeId: null, videoTitle: null, channelName: null, jobType: 'Channel Downloads' })]);

      expect(screen.getByText('Job: Channel Downloads')).toBeInTheDocument();
    });

    test('shows a dash in the video and source cells when there is neither a video nor a job', () => {
      setup([event(1, { youtubeId: null, videoTitle: null, channelName: null, jobType: null, jobId: null })]);

      expect(screen.getAllByText('-')).toHaveLength(2);
    });

    test('shows a thumbnail for a video event', () => {
      setup([event(1)]);

      expect(screen.getByTestId('video-thumbnail')).toBeInTheDocument();
    });

    test('shows no thumbnail for a job-level event', () => {
      setup([event(1, { youtubeId: null, videoTitle: null })]);

      expect(screen.queryByTestId('video-thumbnail')).not.toBeInTheDocument();
    });

    test('opens the video popup with the entry when its thumbnail is clicked', async () => {
      const events = [event(1)];
      const { onOpenVideo } = setup(events);

      await userEvent.click(screen.getByTestId('video-thumbnail'));

      expect(onOpenVideo).toHaveBeenCalledWith(events[0]);
    });

    test('clicking the thumbnail does not filter to the video', async () => {
      const { onSelectVideo } = setup([event(1)]);

      await userEvent.click(screen.getByTestId('video-thumbnail'));

      expect(onSelectVideo).not.toHaveBeenCalled();
    });

    test('has no "since previous" column outside a timeline', () => {
      setup([event(1), event(2)]);

      expect(screen.queryByRole('columnheader', { name: 'Since previous' })).not.toBeInTheDocument();
    });

    test('shows the level of every event, including info', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Level' })).toBeInTheDocument();
      expect(screen.getByText('info')).toBeInTheDocument();
    });

    test('shows a level chip for a warning', () => {
      setup([event(1, { level: 'warn' })]);

      expect(screen.getByText('warn')).toBeInTheDocument();
    });

    test('shows a level chip for an error', () => {
      setup([event(1, { level: 'error' })]);

      expect(screen.getByText('error')).toBeInTheDocument();
    });

    test('selects the video when its title is clicked', async () => {
      const { onSelectVideo } = setup([event(1)]);

      await userEvent.click(screen.getByRole('button', { name: 'Celebrity Juice S26E09' }));

      expect(onSelectVideo).toHaveBeenCalledWith('abc123');
    });

    test('selects the job when its source is clicked', async () => {
      const { onSelectJob } = setup([event(1)]);

      await userEvent.click(screen.getByRole('button', { name: 'NZB (TV)' }));

      expect(onSelectJob).toHaveBeenCalledWith('job-1');
    });

    test('offers no job link for an event without a job', () => {
      setup([event(1, { jobId: null })]);

      expect(screen.queryByRole('button', { name: 'NZB (TV)' })).not.toBeInTheDocument();
    });
  });

  describe('tracked state', () => {
    test('marks an untracked video on its thumbnail', () => {
      setup([event(1, { isTracked: false })]);

      expect(screen.getByTestId('untracked-badge')).toHaveTextContent('Untracked');
    });

    test('shows no badge for a tracked video', () => {
      setup([event(1, { isTracked: true })]);

      expect(screen.queryByTestId('untracked-badge')).not.toBeInTheDocument();
    });

    test('shows no badge when tracked state was not known', () => {
      setup([event(1, { isTracked: null })]);

      expect(screen.queryByTestId('untracked-badge')).not.toBeInTheDocument();
    });

    test('has a Library column', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Library' })).toBeInTheDocument();
    });

    test.each([[true, 'Yes'], [false, 'No']])('shows %p as %s in the Library column', (isTracked, label) => {
      setup([event(1, { isTracked })]);

      expect(screen.getByRole('cell', { name: label })).toBeInTheDocument();
    });

    test('leaves the Library cell empty when it was not known', () => {
      setup([event(1, { isTracked: null })]);

      expect(screen.queryByRole('cell', { name: 'Yes' })).not.toBeInTheDocument();
      expect(screen.queryByRole('cell', { name: 'No' })).not.toBeInTheDocument();
    });

    test('shows the badge on the mobile cards too', () => {
      setup([event(1, { isTracked: false })], { isMobile: true });

      expect(screen.getByTestId('untracked-badge')).toBeInTheDocument();
    });
  });

  describe('long text in the expansion row', () => {
    const LONG = 'Failed to fetch video metadata: ERROR: [youtube] VyJRZmWDIps: Sign in to confirm your age. ' + 'Use --cookies-from-browser or --cookies for the authentication. '.repeat(3);

    test('shows the full error in the expansion row', async () => {
      setup([event(1, { detail: { error: LONG } })]);

      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      expect(screen.getByTestId('event-detail')).toHaveTextContent(LONG.trim());
    });

    test('lets a long value wrap instead of running off the table', async () => {
      setup([event(1, { detail: { error: LONG } })]);
      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      expect(screen.getByText(LONG.trim(), { selector: 'span' })).toHaveStyle({ overflowWrap: 'anywhere' });
    });

    test('caps the width of the expansion row', async () => {
      setup([event(1, { detail: { error: LONG } })]);

      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      expect(screen.getByTestId('event-detail')).toHaveStyle({ maxWidth: '60rem' });
    });

    test('shows whether the video was in the library in the expansion row', async () => {
      setup([event(1, { isTracked: false })]);

      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      expect(screen.getByTestId('event-detail')).toHaveTextContent('In library');
    });
  });

  describe('expansion row', () => {
    const withDetail = () => event(1, { detail: { filePath: '/lib/x.mp4', fileSize: 2048, error: 'HTTP 403' } });

    test('hides the details until asked', () => {
      setup([withDetail()]);

      expect(screen.queryByTestId('event-detail')).not.toBeInTheDocument();
    });

    test('shows the recorded details when expanded', async () => {
      setup([withDetail()]);

      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      expect(screen.getByTestId('event-detail')).toHaveTextContent('/lib/x.mp4');
    });

    test('hides them again when collapsed', async () => {
      setup([withDetail()]);
      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      await userEvent.click(screen.getByRole('button', { name: 'Hide details' }));

      expect(screen.queryByTestId('event-detail')).not.toBeInTheDocument();
    });

    test('expands one event without expanding the others', async () => {
      setup([withDetail(), event(2)]);

      await userEvent.click(screen.getAllByRole('button', { name: 'Show details' })[0]);

      expect(screen.getAllByTestId('event-detail')).toHaveLength(1);
    });

    test('works on the mobile cards too', async () => {
      setup([withDetail()], { isMobile: true });

      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      expect(screen.getByTestId('event-detail')).toBeInTheDocument();
    });
  });

  describe('timeline', () => {
    test('adds a "since previous" column', () => {
      setup([event(1), event(2)], { timeline: true });

      expect(screen.getByRole('columnheader', { name: 'Since previous' })).toBeInTheDocument();
    });

    test('shows the gap to the previous step', () => {
      setup([event(1), event(3)], { timeline: true });

      expect(screen.getByText('+200 ms')).toBeInTheDocument();
    });

    test('shows no gap for the first step', () => {
      setup([event(1)], { timeline: true });

      expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
    });
  });

  describe('mobile cards', () => {
    test('shows each event message', () => {
      setup([event(1), event(2)], { isMobile: true });

      expect(screen.getByText('Message 2')).toBeInTheDocument();
    });

    test('renders cards instead of a table', () => {
      setup([event(1)], { isMobile: true });

      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    test('shows the gap next to the time in a timeline', () => {
      setup([event(1), event(3)], { isMobile: true, timeline: true });

      expect(screen.getByText(/\(\+200 ms\)/)).toBeInTheDocument();
    });

    test('still lets the video be selected', async () => {
      const { onSelectVideo } = setup([event(1)], { isMobile: true });

      await userEvent.click(screen.getByRole('button', { name: 'Celebrity Juice S26E09' }));

      expect(onSelectVideo).toHaveBeenCalledWith('abc123');
    });

    test('cuts a long message and offers more, like the table', () => {
      setup([event(1, { message: 'File finalized at ' + '/very/long/path/segment'.repeat(10) })], { isMobile: true });

      expect(screen.getByRole('button', { name: 'more…' })).toBeInTheDocument();
    });
  });
});
