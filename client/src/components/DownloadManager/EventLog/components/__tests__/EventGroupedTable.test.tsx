import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventGroupedTable from '../EventGroupedTable';
import type { JobEvent } from '../../../../../types/JobEvent';

const at = (ms: number) => new Date(Date.UTC(2026, 8, 21, 20, 0, 0) + ms).toISOString();

const event = (id: number, ms: number, over: Partial<JobEvent> = {}): JobEvent => ({
  id,
  occurredAt: at(ms),
  jobId: 'job-1',
  youtubeId: 'vid-a',
  eventType: 'video.started',
  level: 'info',
  actor: 'downloader',
  message: `Message ${id}`,
  detail: null,
  videoTitle: 'Video A',
  channelName: 'Channel A',
  jobType: 'Channel Downloads',
  source: 'Channels',
  isTracked: true,
  ...over,
});

// job-1 spans two videos; job-2 is a second, unrelated job.
const EVENTS = [
  event(1, 0, { youtubeId: null, videoTitle: null, eventType: 'job.started' }),
  event(2, 100, { eventType: 'video.started' }),
  event(3, 2100, { eventType: 'video.downloaded' }),
  event(4, 300, { youtubeId: 'vid-b', videoTitle: 'Video B', eventType: 'video.started' }),
  event(5, 10000, { jobId: 'job-2', youtubeId: null, videoTitle: null, jobType: 'Manual downloads', eventType: 'job.started' }),
];

const setup = (props: Partial<React.ComponentProps<typeof EventGroupedTable>> = {}) =>
  render(
    <EventGroupedTable
      events={EVENTS}
      isMobile={false}
      onSelectVideo={jest.fn()}
      onSelectJob={jest.fn()}
      onOpenVideo={jest.fn()}
      onSelectEvent={jest.fn()}
      showTimeline={false}
      {...props}
    />
  );

describe('EventGroupedTable', () => {
  test('makes one group per job', () => {
    setup();

    expect(screen.getAllByTestId('event-group')).toHaveLength(2);
  });

  test('starts with every group collapsed', () => {
    setup();

    expect(screen.queryByText('Message 2')).not.toBeInTheDocument();
  });

  test('collapses a job that spans multiple videos into one group', () => {
    setup();

    expect(within(screen.getAllByTestId('event-group')[0]).getByText('Job: Channel Downloads')).toBeInTheDocument();
    expect(screen.getAllByTestId('event-group')[0]).toHaveTextContent('4 events');
  });

  test('shows a job\'s steps at a glance', () => {
    setup();
    const group = screen.getAllByTestId('event-group')[0];

    expect(within(group).getAllByText('started').length).toBeGreaterThan(0);
    expect(within(group).getByText('downloaded')).toBeInTheDocument();
  });

  test('shows how many events a group has and how long they took', () => {
    setup();

    expect(within(screen.getAllByTestId('event-group')[0]).getByText('4 events - 2.100 s')).toBeInTheDocument();
  });

  test('says "1 event" for a single event without a duration', () => {
    setup();

    expect(within(screen.getAllByTestId('event-group')[1]).getByText('1 event')).toBeInTheDocument();
  });

  test('opens a group to show its events', async () => {
    setup();

    await userEvent.click(screen.getByRole('button', { name: 'Expand Job: Channel Downloads' }));

    expect(screen.getByText('Message 2')).toBeInTheDocument();
    expect(screen.getByText('Message 4')).toBeInTheDocument();
  });

  test('keeps other groups closed when one opens', async () => {
    setup();

    await userEvent.click(screen.getByRole('button', { name: 'Expand Job: Channel Downloads' }));

    expect(screen.queryByText('Job created (In Progress)')).not.toBeInTheDocument();
  });

  test('closes an open group again', async () => {
    setup();
    await userEvent.click(screen.getByRole('button', { name: 'Expand Job: Channel Downloads' }));

    await userEvent.click(screen.getByRole('button', { name: 'Collapse Job: Channel Downloads' }));

    expect(screen.queryByText('Message 2')).not.toBeInTheDocument();
  });

  test('opens the group of a revealed event and shows its details', () => {
    setup({ reveal: { eventId: 3, seq: 1 } });

    expect(screen.getByTestId('event-detail')).toHaveTextContent('Message 3');
  });

  test('does not jump back to a revealed event when its group is closed and reopened', async () => {
    setup({ reveal: { eventId: 3, seq: 1 } });
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Job: Channel Downloads' }));

    await userEvent.click(screen.getByRole('button', { name: 'Expand Job: Channel Downloads' }));

    expect(screen.queryByTestId('event-detail')).not.toBeInTheDocument();
  });

  test('shows nothing for no events', () => {
    setup({ events: [] });

    expect(screen.queryByTestId('event-group')).not.toBeInTheDocument();
  });

  test('leaves out the duration when the group\'s timestamps are unusable', () => {
    setup({ events: [event(1, 0, { occurredAt: 'not-a-date' }), event(2, 10, { occurredAt: 'also-not-a-date' })] });

    expect(within(screen.getByTestId('event-group')).getByText('2 events')).toBeInTheDocument();
  });

  test('does nothing for a reveal whose event is not in any group', () => {
    setup({ reveal: { eventId: 9999, seq: 1 } });

    expect(screen.queryByTestId('event-detail')).not.toBeInTheDocument();
  });

  describe('Timeline option', () => {
    test('shows chips, not a timeline, by default', () => {
      setup();

      expect(screen.queryByTestId('event-swimlane')).not.toBeInTheDocument();
    });

    test('shows a mini swimlane per group instead of chips when on', () => {
      setup({ showTimeline: true });

      expect(screen.getAllByTestId('event-swimlane').length).toBeGreaterThan(0);
    });

    test('shows one swimlane lane per video within a job', () => {
      setup({ showTimeline: true });
      const group = screen.getAllByTestId('event-group')[0];

      expect(within(group).getAllByTestId('event-swimlane')).toHaveLength(3); // job lane + vid-a + vid-b
    });

    test('shows a color legend once, not per group', () => {
      setup({ showTimeline: true });

      expect(screen.getAllByText('Info')).toHaveLength(1);
    });

    test('tells the app which event a clicked timeline dot is', async () => {
      const onSelectEvent = jest.fn();
      setup({ showTimeline: true, onSelectEvent });

      await userEvent.click(screen.getByRole('button', { name: 'started - Message 2' }));

      expect(onSelectEvent).toHaveBeenCalledWith(2);
    });

    test('a timeline dot is clickable without expanding its group first', () => {
      setup({ showTimeline: true });

      expect(screen.getByRole('button', { name: 'downloaded - Message 3' })).toBeInTheDocument();
    });
  });
});
