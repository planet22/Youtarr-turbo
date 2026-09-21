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
import {
  componentLabel,
  eventLevelColor,
  formatEventDelta,
  formatEventTime,
  formatEventTimeParts,
  trackedLabel,
} from '../eventLogFormat';
import EventDetail from './EventDetail';
import EventMessage from './EventMessage';

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
      <Box className="relative shrink-0" style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT }}>
        <VideoThumbnail
          video={thumbnailVideo(event)}
          width={THUMBNAIL_WIDTH}
          height={THUMBNAIL_HEIGHT}
          onClick={() => onOpenVideo(event)}
          hasError={false}
          onError={noop}
          iconSize={20}
        />
        {/* Recorded when the event happened, so it stays true after the row is gone.
            Same banner the Videos library puts across an untracked row's thumbnail. */}
        {event.isTracked === false && (
          <Box
            data-testid="untracked-badge"
            className="pointer-events-none"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              backgroundColor: 'var(--media-overlay-background, rgba(0,0,0,0.6))',
              color: 'var(--media-overlay-foreground)',
              padding: '2px 4px',
              fontSize: '0.6rem',
              fontWeight: 'bold',
              textAlign: 'center',
              zIndex: 2,
            }}
          >
            Untracked
          </Box>
        )}
      </Box>
      <Box className="min-w-0">
        <Link component="button" type="button" style={linkStyle} onClick={() => onSelectVideo(youtubeId)}>
          {event.videoTitle || youtubeId}
        </Link>
      </Box>
    </Box>
  );
};

const ChannelCell: React.FC<CellProps> = ({ event }) => <span>{event.channelName || ''}</span>;

// Where the event came from - the label stored with the event (Channels,
// Playlists, NZB (TV), Manual Videos, ...), the same ones Download History uses.
const SourceCell: React.FC<CellProps> = ({ event, onSelectJob }) => {
  if (!event.jobId || !event.source) {
    return <Typography variant="caption" color="secondary">-</Typography>;
  }
  const jobId = event.jobId;
  return (
    <Link component="button" type="button" style={linkStyle} onClick={() => onSelectJob(jobId)}>
      {event.source}
    </Link>
  );
};

const LevelCell: React.FC<CellProps> = ({ event }) => (
  <Chip size="small" variant="outlined" color={eventLevelColor(event.level)} label={event.level} />
);

const ExpandChevron: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <ChevronDown style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms' }} />
);

// The date over the time, so the column stays narrow.
const TimeStack: React.FC<{ iso: string }> = ({ iso }) => {
  const { date, time } = formatEventTimeParts(iso);
  return (
    <span className="block leading-tight whitespace-nowrap">
      <span className="block">{date}</span>
      <span className="block text-muted-foreground">{time}</span>
    </span>
  );
};

// Columns in the desktop table before the optional "since previous" column.
const BASE_COLUMN_COUNT = 10;

// Every column but Event has a set width; Event takes whatever is left, which
// makes it the widest. minWidth keeps Event from being squeezed on a narrow
// screen - the table scrolls sideways instead.
const COLUMN_WIDTHS = {
  expander: 40,
  time: 118,
  sincePrevious: 80,
  video: 240,
  channel: 120,
  library: 64,
  source: 104,
  type: 128,
  component: 100,
  level: 68,
};
const FIXED_WIDTH_TOTAL = Object.values(COLUMN_WIDTHS).reduce((sum, width) => sum + width, 0) - COLUMN_WIDTHS.sincePrevious;
const MIN_EVENT_COLUMN_WIDTH = 340;

const cellStyle = (width?: number, nowrap = false): React.CSSProperties => ({
  padding: '6px 8px',
  overflowWrap: 'anywhere',
  ...(width ? { width } : {}),
  ...(nowrap ? { whiteSpace: 'nowrap' } : {}),
});

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
                <EventMessage message={event.message} expanded={expanded.has(event.id)} onMore={() => toggle(event.id)} />
                <LevelCell {...cell} />
              </Box>
              <Box className="flex items-center gap-3 flex-wrap mt-1">
                <ChannelCell {...cell} />
                <SourceCell {...cell} />
                <Typography variant="caption" color="secondary">{event.eventType}</Typography>
                {event.actor && <Typography variant="caption" color="secondary">{componentLabel(event.actor)}</Typography>}
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
      <Table
        style={{
          tableLayout: 'fixed',
          minWidth: FIXED_WIDTH_TOTAL + MIN_EVENT_COLUMN_WIDTH + (timeline ? COLUMN_WIDTHS.sincePrevious : 0),
        }}
      >
        <TableHead>
          <TableRow>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.expander)} />
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.time)}>Time</TableCell>
            {timeline && <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.sincePrevious)}>Since previous</TableCell>}
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.video)}>Video</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.channel)}>Channel</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.library)}>Library</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.source)}>Source</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.type)}>Type</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.component)}>Component</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.level)}>Level</TableCell>
            <TableCell component="th" style={cellStyle()}>Event</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event, index) => {
            const cell = { event, onSelectVideo, onSelectJob, onOpenVideo };
            return (
              <React.Fragment key={event.id}>
                <TableRow hover>
                  <TableCell style={cellStyle()}>{expander(event)}</TableCell>
                  <TableCell style={cellStyle(undefined, true)}><TimeStack iso={event.occurredAt} /></TableCell>
                  {timeline && <TableCell style={cellStyle(undefined, true)}>{deltaFor(events, index, timeline) ?? ''}</TableCell>}
                  <TableCell style={cellStyle()}><VideoCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}><ChannelCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}>{trackedLabel(event.isTracked)}</TableCell>
                  <TableCell style={cellStyle()}><SourceCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}>{event.eventType}</TableCell>
                  <TableCell style={cellStyle()}>{componentLabel(event.actor)}</TableCell>
                  <TableCell style={cellStyle()}><LevelCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}>
                    <EventMessage message={event.message} expanded={expanded.has(event.id)} onMore={() => toggle(event.id)} />
                  </TableCell>
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
