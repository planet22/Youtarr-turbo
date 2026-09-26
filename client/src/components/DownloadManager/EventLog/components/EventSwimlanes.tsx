import React from 'react';
import { Box, Typography } from '../../../ui';
import type { JobEvent } from '../../../../types/JobEvent';
import EventSwimlaneLanes, { LEGEND_ITEMS, LegendDot } from './EventSwimlaneLanes';

interface EventSwimlanesProps {
  events: JobEvent[];
  // A dot was clicked: show that event in the table below.
  onSelectEvent: (eventId: number) => void;
}

// Only meaningful for a single job (one story, video as the natural lane) -
// see EventGroupedTable's own "Timeline" option for the whole-log equivalent,
// grouped by job with video as the inner lane.
const EventSwimlanes: React.FC<EventSwimlanesProps> = ({ events, onSelectEvent }) => {
  if (events.length === 0) return null;

  return (
    <Box
      data-testid="event-swimlanes"
      className="mb-3 p-2 rounded-md"
      style={{ border: 'var(--border-weight) solid var(--border)' }}
    >
      <Box className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <Typography variant="caption" color="secondary">
          Each dot is one recorded step, placed by when it happened. Hover a dot for what it was; click it to jump there below.
        </Typography>
        <Box className="flex items-center gap-3 shrink-0">
          {LEGEND_ITEMS.map((item) => <LegendDot key={item.level} level={item.level} label={item.label} />)}
        </Box>
      </Box>
      <EventSwimlaneLanes events={events} onSelectEvent={onSelectEvent} />
    </Box>
  );
};

export default EventSwimlanes;
