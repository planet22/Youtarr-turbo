import React from 'react';
import {
  Box,
  Chip,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '../../../ui';
import type { JobEvent } from '../../../../types/JobEvent';
import { eventLevelColor, formatEventDelta, formatEventTime } from '../eventLogFormat';

interface EventLogTableProps {
  events: JobEvent[];
  // One job's or video's story: entries are oldest-first and show the gap since the previous step.
  timeline: boolean;
  isMobile: boolean;
  onSelectVideo: (youtubeId: string) => void;
  onSelectJob: (jobId: string) => void;
}

const linkStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0, textAlign: 'left' };

function deltaFor(events: JobEvent[], index: number, timeline: boolean): string | null {
  if (!timeline || index === 0) return null;
  return formatEventDelta(events[index - 1].occurredAt, events[index].occurredAt);
}

interface CellProps {
  event: JobEvent;
  onSelectVideo: (youtubeId: string) => void;
  onSelectJob: (jobId: string) => void;
}

const VideoCell: React.FC<CellProps> = ({ event, onSelectVideo }) => {
  if (!event.youtubeId) {
    return <Typography variant="caption" color="secondary">-</Typography>;
  }
  const title = event.videoTitle || event.youtubeId;
  return (
    <Box>
      <Link component="button" type="button" style={linkStyle} onClick={() => onSelectVideo(event.youtubeId as string)}>
        {title}
      </Link>
      {event.channelName && (
        <Typography variant="caption" color="secondary" className="block">{event.channelName}</Typography>
      )}
    </Box>
  );
};

const EventCell: React.FC<CellProps> = ({ event, onSelectJob }) => (
  <Box>
    <Box className="flex items-center gap-2 flex-wrap">
      <span>{event.message}</span>
      {event.level !== 'info' && (
        <Chip size="small" variant="outlined" color={eventLevelColor(event.level)} label={event.level} />
      )}
    </Box>
    <Typography variant="caption" color="secondary" className="block">
      {event.eventType}
      {event.actor ? ` · ${event.actor}` : ''}
    </Typography>
    {event.jobId && (
      <Link component="button" type="button" style={linkStyle} onClick={() => onSelectJob(event.jobId as string)}>
        <Typography variant="caption">{event.jobType || 'Job'}</Typography>
      </Link>
    )}
  </Box>
);

const EventLogTable: React.FC<EventLogTableProps> = ({ events, timeline, isMobile, onSelectVideo, onSelectJob }) => {
  if (isMobile) {
    return (
      <Box className="flex flex-col gap-2.5">
        {events.map((event, index) => {
          const delta = deltaFor(events, index, timeline);
          return (
            <Box
              key={event.id}
              className="p-3"
              style={{ border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}
            >
              <Typography variant="caption" color="secondary" className="block">
                {formatEventTime(event.occurredAt)}
                {delta ? ` (${delta})` : ''}
              </Typography>
              <VideoCell event={event} onSelectVideo={onSelectVideo} onSelectJob={onSelectJob} />
              <EventCell event={event} onSelectVideo={onSelectVideo} onSelectJob={onSelectJob} />
            </Box>
          );
        })}
      </Box>
    );
  }

  return (
    <TableContainer>
      <Table>
        <TableHead>
          <TableRow>
            <TableCell component="th">Time</TableCell>
            {timeline && <TableCell component="th">Since previous</TableCell>}
            <TableCell component="th">Video</TableCell>
            <TableCell component="th">Event</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event, index) => (
            <TableRow key={event.id} hover>
              <TableCell style={{ whiteSpace: 'nowrap' }}>{formatEventTime(event.occurredAt)}</TableCell>
              {timeline && <TableCell style={{ whiteSpace: 'nowrap' }}>{deltaFor(events, index, timeline) ?? ''}</TableCell>}
              <TableCell>
                <VideoCell event={event} onSelectVideo={onSelectVideo} onSelectJob={onSelectJob} />
              </TableCell>
              <TableCell>
                <EventCell event={event} onSelectVideo={onSelectVideo} onSelectJob={onSelectJob} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

export default EventLogTable;
