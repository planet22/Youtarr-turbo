import React from 'react';
import { Box, Typography } from '../../../ui';
import type { JobEvent } from '../../../../types/JobEvent';
import { componentLabel, describeDetailEntries, trackedLabel } from '../eventLogFormat';

interface EventDetailProps {
  event: JobEvent;
}

interface Row {
  label: string;
  value: string;
}

// The expansion row's contents: identifiers first, then everything the event recorded.
const EventDetail: React.FC<EventDetailProps> = ({ event }) => {
  const identity: Row[] = [
    { label: 'Event id', value: String(event.id) },
    { label: 'Exact time', value: event.occurredAt },
    { label: 'Event type', value: event.eventType },
    { label: 'Level', value: event.level },
    { label: 'Component', value: componentLabel(event.actor) },
    { label: 'In library', value: trackedLabel(event.isTracked) },
    { label: 'Video id', value: event.youtubeId || '' },
    { label: 'Video title', value: event.videoTitle || '' },
    { label: 'Channel', value: event.channelName || '' },
    { label: 'Job id', value: event.jobId || '' },
    { label: 'Job type', value: event.jobType || '' },
  ].filter((row) => row.value !== '');
  const recorded = describeDetailEntries(event.detail);

  return (
    // Capped so a long error wraps here instead of running off the edge of a wide table.
    <Box className="p-3 flex flex-col gap-2" data-testid="event-detail" style={{ maxWidth: '60rem' }}>
      <Typography variant="body2" style={{ overflowWrap: 'anywhere' }}>{event.message}</Typography>
      <Box className="grid gap-x-6 gap-y-1" style={{ gridTemplateColumns: 'max-content minmax(0, 1fr)' }}>
        {[...identity, ...recorded].map((row) => (
          <React.Fragment key={row.label}>
            <Typography variant="caption" color="secondary">{row.label}</Typography>
            <Typography variant="caption" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{row.value}</Typography>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
};

export default EventDetail;
