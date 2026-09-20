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
  ...over,
});

describe('EventLogTable', () => {
  const setup = (events: JobEvent[], props: Partial<React.ComponentProps<typeof EventLogTable>> = {}) => {
    const onSelectVideo = jest.fn();
    const onSelectJob = jest.fn();
    render(
      <EventLogTable
        events={events}
        timeline={false}
        isMobile={false}
        onSelectVideo={onSelectVideo}
        onSelectJob={onSelectJob}
        {...props}
      />
    );
    return { onSelectVideo, onSelectJob };
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

    test('shows the event type and actor', () => {
      setup([event(1)]);

      expect(screen.getByText('nzb.untracked · nzb')).toBeInTheDocument();
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

    test('shows a dash for a job-level event with no video', () => {
      setup([event(1, { youtubeId: null, videoTitle: null, channelName: null })]);

      expect(screen.getByText('-')).toBeInTheDocument();
    });

    test('has no "since previous" column outside a timeline', () => {
      setup([event(1), event(2)]);

      expect(screen.queryByRole('columnheader', { name: 'Since previous' })).not.toBeInTheDocument();
    });

    test('shows a level chip for a warning', () => {
      setup([event(1, { level: 'warn' })]);

      expect(screen.getByText('warn')).toBeInTheDocument();
    });

    test('shows a level chip for an error', () => {
      setup([event(1, { level: 'error' })]);

      expect(screen.getByText('error')).toBeInTheDocument();
    });

    test('shows no level chip for an info event', () => {
      setup([event(1)]);

      expect(screen.queryByText('info')).not.toBeInTheDocument();
    });

    test('selects the video when its title is clicked', async () => {
      const { onSelectVideo } = setup([event(1)]);

      await userEvent.click(screen.getByRole('button', { name: 'Celebrity Juice S26E09' }));

      expect(onSelectVideo).toHaveBeenCalledWith('abc123');
    });

    test('selects the job when its type is clicked', async () => {
      const { onSelectJob } = setup([event(1)]);

      await userEvent.click(screen.getByRole('button', { name: 'Sonarr/Radarr: TV [abc123]' }));

      expect(onSelectJob).toHaveBeenCalledWith('job-1');
    });

    test('offers no job link for an event without a job', () => {
      setup([event(1, { jobId: null })]);

      expect(screen.queryByRole('button', { name: 'Sonarr/Radarr: TV [abc123]' })).not.toBeInTheDocument();
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
  });
});
