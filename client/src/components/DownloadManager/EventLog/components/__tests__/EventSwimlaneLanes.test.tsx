import React from 'react';
import { render, screen } from '@testing-library/react';
import EventSwimlaneLanes from '../EventSwimlaneLanes';
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

// EventSwimlanes and EventGroupedTable exercise the shared ruler/dot behavior;
// these tests cover this component's own contract as a standalone piece.
describe('EventSwimlaneLanes', () => {
  test('renders nothing for no events', () => {
    const { container } = render(<EventSwimlaneLanes events={[]} onSelectEvent={jest.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  test('renders lanes without needing the full Swimlanes wrapper', () => {
    render(<EventSwimlaneLanes events={[event(1, 0)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByTestId('event-swimlane')).toBeInTheDocument();
  });

  test('uses a narrower lane label in compact mode', () => {
    render(<EventSwimlaneLanes events={[event(1, 0)]} onSelectEvent={jest.fn()} compact />);

    expect(screen.getByText('Video A')).toHaveStyle({ width: '120px' });
  });

  test('uses the normal lane label width by default', () => {
    render(<EventSwimlaneLanes events={[event(1, 0)]} onSelectEvent={jest.fn()} />);

    expect(screen.getByText('Video A')).toHaveStyle({ width: '160px' });
  });

  test('does not crash when a dot\'s own timestamp is unusable', () => {
    render(<EventSwimlaneLanes events={[event(1, 0), event(2, 1000, { occurredAt: 'not-a-date' })]} onSelectEvent={jest.fn()} />);

    expect(screen.getAllByTestId('event-swimlane').length).toBeGreaterThan(0);
  });
});
