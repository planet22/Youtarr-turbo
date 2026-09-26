import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
    const { unmount } = render(
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
    return { onSelectVideo, onSelectJob, onOpenVideo, unmount };
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

    test('does not offer more on a short message with no detail', () => {
      setup([event(1)]);

      expect(screen.queryByRole('button', { name: 'more…' })).not.toBeInTheDocument();
    });

    test('offers more on a short message when there is detail behind it', () => {
      setup([event(1, { eventType: 'video.failed', detail: { error: 'HTTP 403' } })]);

      expect(screen.getByRole('button', { name: 'more…' })).toBeInTheDocument();
    });

    test('more on a short message opens the row, same as a long one', async () => {
      setup([event(1, { eventType: 'video.failed', detail: { error: 'HTTP 403' } })]);

      await userEvent.click(screen.getByRole('button', { name: 'more…' }));

      expect(screen.getByTestId('event-detail')).toHaveTextContent('HTTP 403');
    });

    test('shows the event type in its own column', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Type' })).toBeInTheDocument();
      expect(screen.getByText('nzb.untracked')).toBeInTheDocument();
    });

    test('shows the component in its own column, abbreviated, in full on hover', () => {
      setup([event(1, { actor: 'media-server' })]);

      expect(screen.getByRole('columnheader', { name: 'Comp.' })).toBeInTheDocument();
      expect(screen.getByText('Media')).toHaveAttribute('title', 'Media server');
    });

    test('shows the channel in its own column', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Channel' })).toBeInTheDocument();
    });

    test('shows the source label stored with the event, as plain text', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument();
      expect(screen.getByText('NZB (TV)')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'NZB (TV)' })).not.toBeInTheDocument();
    });

    test('shows a dash in the source cell when there is no source', () => {
      setup([event(1, { jobId: null, source: null })]);

      expect(screen.getAllByText('-').length).toBeGreaterThan(0);
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
      setup([event(1, { youtubeId: null, videoTitle: null, channelName: null, jobType: null, jobId: null, source: null })]);

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

    test('has no delta column outside a timeline', () => {
      setup([event(1), event(2)]);

      expect(screen.queryByRole('columnheader', { name: 'Δ time' })).not.toBeInTheDocument();
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

    test('labels the Library icon header for hover', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Library' })).toHaveAttribute('title', 'In library');
    });

    test('abbreviates the Component header to keep the column narrow, in full on hover', () => {
      setup([event(1)]);

      expect(screen.getByRole('columnheader', { name: 'Comp.' })).toHaveAttribute('title', 'Component');
    });

    test('abbreviates the maintenance component to keep the column narrow', () => {
      setup([event(1, { actor: 'maintenance' })]);

      expect(screen.getByText('Maint.')).toBeInTheDocument();
    });

    test('shows a long event type in full so it can wrap at its dot or underscore', () => {
      setup([event(1, { eventType: 'video.download_interrupted' })]);

      expect(screen.getByText('video.download_interrupted')).toBeInTheDocument();
    });

    test('makes the table wider in a timeline, for the Since previous column', () => {
      const { unmount } = setup([event(1)]);
      const plainWidth = parseInt(screen.getByRole('table').style.minWidth, 10);
      unmount();

      setup([event(1), event(2)], { timeline: true });

      expect(parseInt(screen.getByRole('table').style.minWidth, 10)).toBeGreaterThan(plainWidth);
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

    test('opens a long message from its more link on a mobile card', async () => {
      const longMessage = 'Failed to fetch video metadata: ' + 'a very long reason '.repeat(10);
      setup([event(1, { message: longMessage })], { isMobile: true });

      await userEvent.click(screen.getByRole('button', { name: 'more…' }));

      expect(screen.getByTestId('event-detail')).toHaveTextContent(longMessage.trim());
    });

    test('opens the details of a revealed event', () => {
      setup([event(1), event(2)], { reveal: { eventId: 2, seq: 1 } });

      expect(screen.getByTestId('event-detail')).toHaveTextContent('Message 2');
    });

    test('ignores a reveal for an event that is not on this page', () => {
      setup([event(1)], { reveal: { eventId: 99, seq: 1 } });

      expect(screen.queryByTestId('event-detail')).not.toBeInTheDocument();
    });

    test('opens a revealed event again after its row was closed', async () => {
      const events = [event(1)];
      const table = (seq: number) => (
        <EventLogTable
          events={events}
          timeline={false}
          isMobile={false}
          onSelectVideo={jest.fn()}
          onSelectJob={jest.fn()}
          onOpenVideo={jest.fn()}
          reveal={{ eventId: 1, seq }}
        />
      );
      const { rerender } = render(table(1));
      await userEvent.click(screen.getByRole('button', { name: 'Hide details' }));

      rerender(table(2));

      expect(screen.getByTestId('event-detail')).toBeInTheDocument();
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

    test('leaves out expansion rows that have no value', async () => {
      setup([event(1, { youtubeId: null, channelName: null, jobId: null, jobType: null })]);

      await userEvent.click(screen.getByRole('button', { name: 'Show details' }));

      const detail = screen.getByTestId('event-detail');
      expect(detail).not.toHaveTextContent('Video id');
      expect(detail).not.toHaveTextContent('Job id');
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

  describe('job link icon', () => {
    test('shows a link icon on a row that has a job', () => {
      setup([event(1)]);

      expect(screen.getByRole('button', { name: 'Highlight and select this job' })).toBeInTheDocument();
    });

    test('has no link icon on a row with no job', () => {
      setup([event(1, { jobId: null })]);

      expect(screen.queryByRole('button', { name: 'Highlight and select this job' })).not.toBeInTheDocument();
    });

    test('selects the job when clicked', async () => {
      const { onSelectJob } = setup([event(1)]);

      await userEvent.click(screen.getByRole('button', { name: 'Highlight and select this job' }));

      expect(onSelectJob).toHaveBeenCalledWith('job-1');
    });

    test('highlights every row from the same job on hover', async () => {
      setup([event(1), event(2, { jobId: 'job-2' }), event(3)]);
      const rows = screen.getAllByRole('row').slice(1); // drop the header row

      await userEvent.hover(screen.getAllByRole('button', { name: 'Highlight and select this job' })[0]);

      expect(rows[0]).toHaveStyle({ backgroundColor: 'var(--accent-muted, rgba(255,220,0,0.15))' });
      expect(rows[2]).toHaveStyle({ backgroundColor: 'var(--accent-muted, rgba(255,220,0,0.15))' });
      expect(rows[1]).not.toHaveStyle({ backgroundColor: 'var(--accent-muted, rgba(255,220,0,0.15))' });
    });

    test('removes the highlight when the pointer leaves', async () => {
      setup([event(1)]);
      const row = screen.getAllByRole('row')[1];
      const link = screen.getByRole('button', { name: 'Highlight and select this job' });

      await userEvent.hover(link);
      await userEvent.unhover(link);

      expect(row).not.toHaveStyle({ backgroundColor: 'var(--accent-muted, rgba(255,220,0,0.15))' });
    });

    test('highlights on keyboard focus too, and clears on blur', () => {
      setup([event(1)]);
      const row = screen.getAllByRole('row')[1];
      const link = screen.getByRole('button', { name: 'Highlight and select this job' });

      fireEvent.focus(link);
      expect(row).toHaveStyle({ backgroundColor: 'var(--accent-muted, rgba(255,220,0,0.15))' });

      fireEvent.blur(link);
      expect(row).not.toHaveStyle({ backgroundColor: 'var(--accent-muted, rgba(255,220,0,0.15))' });
    });

    test('shows the link icon on a mobile card too', () => {
      setup([event(1)], { isMobile: true });

      expect(screen.getByRole('button', { name: 'Highlight and select this job' })).toBeInTheDocument();
    });

    test('highlights a mobile card on hover too', async () => {
      setup([event(1)], { isMobile: true });
      const card = screen.getByTestId('event-row-1');

      await userEvent.hover(screen.getByRole('button', { name: 'Highlight and select this job' }));

      expect(card).toHaveStyle({ backgroundColor: 'var(--accent-muted, rgba(255,220,0,0.15))' });
    });
  });

  describe('timeline', () => {
    test('adds a delta ("since previous") column', () => {
      setup([event(1), event(2)], { timeline: true });

      expect(screen.getByRole('columnheader', { name: 'Δ time' })).toHaveAttribute('title', 'Time since the previous step');
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

    test('offers more on a short message with detail, like the table', () => {
      setup([event(1, { eventType: 'video.failed', detail: { error: 'HTTP 403' } })], { isMobile: true });

      expect(screen.getByRole('button', { name: 'more…' })).toBeInTheDocument();
    });
  });
});
