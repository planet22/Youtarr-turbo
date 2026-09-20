import React, { useState } from 'react';
import {
  Box,
  Chip,
  IconButton,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '../../../ui';
import { ChevronDown } from 'lucide-react';
import type { JobEvent } from '../../../../types/JobEvent';
import type { VideoData } from '../../../../types/VideoData';
import VideoThumbnail from '../../VideoThumbnail';
import { getJobSourceLabel } from '../../DownloadHistory';
import { eventLevelColor, formatEventDelta, formatEventTime } from '../eventLogFormat';
import EventDetail from './EventDetail';

interface EventLogTableProps {
  events: JobEvent[];
  // One job's or video's story: entries are oldest-first and show the gap since the previous step.
  timeline: boolean;
  isMobile: boolean;
  onSelectVideo: (youtubeId: string) => void;
  onSelectJob: (jobId: string) => void;
  // Opens the video detail popup (the same one Download History uses).
  onOpenVideo: (event: JobEvent) => void;
}

const THUMBNAIL_WIDTH = 96;
const THUMBNAIL_HEIGHT = 54;

// VideoThumbnail wants a VideoData; only the id and title matter to it. It
// tries the local copy, then YouTube's own image, so untracked videos (no
// local copy) still get a picture.
function thumbnailVideo(event: JobEvent): VideoData {
  return {
    id: null,
    youtubeId: event.youtubeId as string,
    youTubeChannelName: event.channelName || '',
    youTubeVideoName: event.videoTitle || (event.youtubeId as string),
    timeCreated: event.occurredAt,
    originalDate: null,
    duration: null,
    description: null,
  };
}

const noop = () => {};

const linkStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0, textAlign: 'left' };

function deltaFor(events: JobEvent[], index: number, timeline: boolean): string | null {
  if (!timeline || index === 0) return null;
  return formatEventDelta(events[index - 1].occurredAt, events[index].occurredAt);
}

interface CellProps {
  event: JobEvent;
  onSelectVideo: (youtubeId: string) => void;
  onSelectJob: (jobId: string) => void;
  onOpenVideo: (event: JobEvent) => void;
}

const VideoCell: React.FC<CellProps> = ({ event, onSelectVideo, onOpenVideo }) => {
  if (!event.youtubeId) {
    // Job-level entry (a multi-video job): say which job instead of a bare dash.
    return event.jobType
      ? <Typography variant="caption" color="secondary">Job: {event.jobType}</Typography>
      : <Typography variant="caption" color="secondary">-</Typography>;
  }
  const youtubeId = event.youtubeId;
  return (
    <Box className="flex items-start gap-2">
      <VideoThumbnail
        video={thumbnailVideo(event)}
        width={THUMBNAIL_WIDTH}
        height={THUMBNAIL_HEIGHT}
        onClick={() => onOpenVideo(event)}
        hasError={false}
        onError={noop}
        iconSize={20}
      />
      <Box className="min-w-0">
        <Link component="button" type="button" style={linkStyle} onClick={() => onSelectVideo(youtubeId)}>
          {event.videoTitle || youtubeId}
        </Link>
      </Box>
    </Box>
  );
};

const ChannelCell: React.FC<CellProps> = ({ event }) => <span>{event.channelName || ''}</span>;

// Where the event came from, labelled exactly as Download History labels a
// job's source (Channels, Playlists, NZB (TV), Manual Videos, ...).
const SourceCell: React.FC<CellProps> = ({ event, onSelectJob }) => {
  if (!event.jobId || !event.jobType) {
    return <Typography variant="caption" color="secondary">-</Typography>;
  }
  const jobId = event.jobId;
  return (
    <Link component="button" type="button" style={linkStyle} onClick={() => onSelectJob(jobId)}>
      {getJobSourceLabel(event.jobType)}
    </Link>
  );
};

const LevelCell: React.FC<CellProps> = ({ event }) => (
  <Chip size="small" variant="outlined" color={eventLevelColor(event.level)} label={event.level} />
);

const ExpandChevron: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <ChevronDown style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms' }} />
);

// Columns in the desktop table before the optional "since previous" column.
const BASE_COLUMN_COUNT = 9;

const EventLogTable: React.FC<EventLogTableProps> = ({ events, timeline, isMobile, onSelectVideo, onSelectJob, onOpenVideo }) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const expander = (event: JobEvent) => (
    <IconButton
      size="small"
      aria-label={expanded.has(event.id) ? 'Hide details' : 'Show details'}
      onClick={() => toggle(event.id)}
    >
      <ExpandChevron expanded={expanded.has(event.id)} />
    </IconButton>
  );

  if (isMobile) {
    return (
      <Box className="flex flex-col gap-2.5">
        {events.map((event, index) => {
          const delta = deltaFor(events, index, timeline);
          const cell = { event, onSelectVideo, onSelectJob, onOpenVideo };
          return (
            <Box
              key={event.id}
              className="p-3"
              style={{ border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}
            >
              <Box className="flex items-start justify-between gap-2">
                <Typography variant="caption" color="secondary" className="block">
                  {formatEventTime(event.occurredAt)}
                  {delta ? ` (${delta})` : ''}
                </Typography>
                {expander(event)}
              </Box>
              <VideoCell {...cell} />
              <Box className="flex items-center gap-2 flex-wrap">
                <span>{event.message}</span>
                <LevelCell {...cell} />
              </Box>
              <Box className="flex items-center gap-3 flex-wrap mt-1">
                <ChannelCell {...cell} />
                <SourceCell {...cell} />
                <Typography variant="caption" color="secondary">{event.eventType}</Typography>
                {event.actor && <Typography variant="caption" color="secondary">{event.actor}</Typography>}
              </Box>
              {expanded.has(event.id) && <EventDetail event={event} />}
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
            <TableCell component="th" />
            <TableCell component="th">Time</TableCell>
            {timeline && <TableCell component="th">Since previous</TableCell>}
            <TableCell component="th">Video</TableCell>
            <TableCell component="th">Channel</TableCell>
            <TableCell component="th">Source</TableCell>
            <TableCell component="th">Type</TableCell>
            <TableCell component="th">Actor</TableCell>
            <TableCell component="th">Level</TableCell>
            <TableCell component="th">Event</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event, index) => {
            const cell = { event, onSelectVideo, onSelectJob, onOpenVideo };
            return (
              <React.Fragment key={event.id}>
                <TableRow hover>
                  <TableCell>{expander(event)}</TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>{formatEventTime(event.occurredAt)}</TableCell>
                  {timeline && <TableCell style={{ whiteSpace: 'nowrap' }}>{deltaFor(events, index, timeline) ?? ''}</TableCell>}
                  <TableCell><VideoCell {...cell} /></TableCell>
                  <TableCell><ChannelCell {...cell} /></TableCell>
                  <TableCell><SourceCell {...cell} /></TableCell>
                  <TableCell>{event.eventType}</TableCell>
                  <TableCell>{event.actor || ''}</TableCell>
                  <TableCell><LevelCell {...cell} /></TableCell>
                  <TableCell>{event.message}</TableCell>
                </TableRow>
                {expanded.has(event.id) && (
                  <TableRow>
                    <TableCell colSpan={BASE_COLUMN_COUNT + (timeline ? 1 : 0)} style={{ padding: 0 }}>
                      <EventDetail event={event} />
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

export default EventLogTable;
