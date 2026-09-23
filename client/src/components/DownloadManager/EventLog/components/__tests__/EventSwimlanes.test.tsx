import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EventSwimlanes from '../EventSwimlanes';
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

describe('EventSwimlanes', () => {
  test('shows nothing when there are no events', () => {
    render(<EventSwimlanes events={[]} onSelectEvent={jest.fn()} />);

    expect(screen.queryByTestId('event-swimlanes')).not.toBeInTheDocument();
  });

  test('draws one lane per video and one for the job', () => {
    render(
      <EventSwimlanes
        events={[
          event(1, 0, { youtubeId: null, videoTitle: null, eventType: 'job.started' }),
          event(2, 10),
          event(3, 20, { youtubeId: 'vid-b', videoTitle: 'Video B' }),
        ]}
        onSelectEvent={jest.fn()}
      />
    );

    expect(screen.getAllByTestId('event-swimlane')).toHaveLength(3);
  });

  test('labels each lane with its video title', () => {
    render(<EventSwimlanes events={[event(1, 0)]} onSelectEvent={jest.fn()} />);

    expect(within(screen.getByTestId('event-swimlane')).getByText('Video A')).toBeInTheDocument();
  });

  test('names a dot by its step, in plain words, and its message', () => {
    render(
      <EventSwimlanes
        events={[event(1, 0), event(2, 1000, { eventType: 'video.downloaded' })]}
        onSelectEvent={jest.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'downloaded - Message 2' })).toBeInTheDocument();
  });

  test('shows the elapsed time and message when hovering a dot', () => {
    render(<EventSwimlanes events={[event(1, 0)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'started - Message 1' })).toHaveAttribute(
      'title',
      expect.stringContaining('Message 1')
    );
  });

  test('tells the app which event a clicked dot is', async () => {
    const onSelectEvent = jest.fn();
    render(<EventSwimlanes events={[event(1, 0), event(2, 1000)]} onSelectEvent={onSelectEvent} />);

    await userEvent.click(screen.getByRole('button', { name: 'started - Message 2' }));

    expect(onSelectEvent).toHaveBeenCalledWith(2);
  });

  test.each([
    ['error', 'bg-destructive'],
    ['warn', 'bg-warning'],
    ['info', 'bg-muted-foreground'],
  ])('colours a %s dot with %s', (level, colourClass) => {
    render(<EventSwimlanes events={[event(1, 0, { level })]} onSelectEvent={jest.fn()} />);

    expect(screen.getByRole('button', { name: 'started - Message 1' })).toHaveClass(colourClass);
  });

  test('explains what a dot is', () => {
    render(<EventSwimlanes events={[event(1, 0)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByText(/Each dot is one recorded step/)).toBeInTheDocument();
  });

  test('shows a color legend for the three levels', () => {
    render(<EventSwimlanes events={[event(1, 0)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByText('Info')).toBeInTheDocument();
    expect(screen.getByText('Warning')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  test('marks the start of the ruler as elapsed zero', () => {
    render(<EventSwimlanes events={[event(1, 0), event(2, 9111)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByText('0')).toBeInTheDocument();
  });

  test('marks the end of the ruler with the total elapsed time', () => {
    render(<EventSwimlanes events={[event(1, 0), event(2, 9111)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByText('9.111 s')).toBeInTheDocument();
  });

  test('marks the midpoint of the ruler with the halfway elapsed time', () => {
    render(<EventSwimlanes events={[event(1, 0), event(2, 10000)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByText('5.000 s')).toBeInTheDocument();
  });
});
