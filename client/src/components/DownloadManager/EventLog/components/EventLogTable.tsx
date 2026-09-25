import React, { useEffect, useState } from 'react';
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
import { ChevronDown, Library, Link2 } from 'lucide-react';
import type { JobEvent } from '../../../../types/JobEvent';
import type { VideoData } from '../../../../types/VideoData';
import VideoThumbnail from '../../VideoThumbnail';
import {
  componentAbbr,
  componentLabel,
  eventLevelColor,
  formatEventDelta,
  formatEventTime,
  formatEventTimeParts,
  offersDetailLink,
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
  // Opens and scrolls to one row (a swimlane dot was clicked). A new seq re-reveals the same row.
  reveal?: EventReveal | null;
}

export interface EventReveal {
  eventId: number;
  seq: number;
}

export const eventRowId = (eventId: number): string => `event-row-${eventId}`;

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
      {/* isTracked is recorded when the event happened, so it stays true after the row is gone. */}
      <VideoThumbnail
        video={thumbnailVideo(event)}
        width={THUMBNAIL_WIDTH}
        height={THUMBNAIL_HEIGHT}
        onClick={() => onOpenVideo(event)}
        hasError={false}
        onError={noop}
        iconSize={20}
        untracked={event.isTracked === false}
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

// Where the event came from - the label stored with the event (Channels,
// Playlists, NZB (TV), Manual Videos, ...), the same ones Download History
// uses. Plain text - the row's link icon is what selects the job.
const SourceCell: React.FC<CellProps> = ({ event }) => {
  if (!event.source) {
    return <Typography variant="caption" color="secondary">-</Typography>;
  }
  return <span>{event.source}</span>;
};

const LevelCell: React.FC<CellProps> = ({ event }) => (
  <Chip size="small" variant="outlined" color={eventLevelColor(event.level)} label={event.level} />
);

const ExpandChevron: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <ChevronDown style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms' }} />
);

// A row with a job: hovering (or focusing) this highlights every row from
// that job currently on screen, so its steps are easy to pick out from
// whatever else is interleaved with it; clicking it selects the job, the
// same as clicking its Source label.
const JobLinkButton: React.FC<{ jobId: string; onSelectJob: (jobId: string) => void; onHoverJobChange: (jobId: string | null) => void }> = ({
  jobId,
  onSelectJob,
  onHoverJobChange,
}) => (
  <IconButton
    size="small"
    aria-label="Highlight and select this job"
    title="Highlight this job's rows - click to view only this job"
    onMouseEnter={() => onHoverJobChange(jobId)}
    onMouseLeave={() => onHoverJobChange(null)}
    onFocus={() => onHoverJobChange(jobId)}
    onBlur={() => onHoverJobChange(null)}
    onClick={() => onSelectJob(jobId)}
  >
    <Link2 size={14} />
  </IconButton>
);

const HIGHLIGHT_BACKGROUND = 'var(--accent-muted, rgba(255,220,0,0.15))';

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

// Lets a long type name ("video.download_interrupted") wrap at its dot or
// underscore instead of being cut mid-word in a narrow column.
const BreakableType: React.FC<{ type: string }> = ({ type }) => (
  <span>
    {type.split(/(?<=[._])/).map((part, index) => (
      <React.Fragment key={index}>
        {index > 0 && <wbr />}
        {part}
      </React.Fragment>
    ))}
  </span>
);

// Columns in the desktop table before the optional "since previous" column.
const BASE_COLUMN_COUNT = 10;

// The small columns have set widths (their text wraps); Video and Event have
// none, so they share everything that is left and are the widest. The minimums
// keep them from being squeezed on a narrow screen - the table scrolls
// sideways instead.
const COLUMN_WIDTHS = {
  expander: 64,
  time: 118,
  sincePrevious: 80,
  channel: 100,
  library: 48,
  source: 84,
  type: 100,
  component: 84,
  level: 66,
};
const FIXED_WIDTH_TOTAL = Object.values(COLUMN_WIDTHS).reduce((sum, width) => sum + width, 0) - COLUMN_WIDTHS.sincePrevious;
const MIN_VIDEO_COLUMN_WIDTH = 240;
const MIN_EVENT_COLUMN_WIDTH = 260;

const cellStyle = (width?: number, nowrap = false): React.CSSProperties => ({
  padding: '6px 5px',
  overflowWrap: 'anywhere',
  ...(width ? { width } : {}),
  ...(nowrap ? { whiteSpace: 'nowrap' } : {}),
});

const EventLogTable: React.FC<EventLogTableProps> = ({ events, timeline, isMobile, onSelectVideo, onSelectJob, onOpenVideo, reveal }) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hoveredJobId, setHoveredJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!reveal || !events.some((event) => event.id === reveal.eventId)) return;
    setExpanded((previous) => new Set(previous).add(reveal.eventId));
    document.getElementById(eventRowId(reveal.eventId))?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    // Only a new reveal request should act; a refetch of the same events must not re-open a closed row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

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
              id={eventRowId(event.id)}
              data-testid={eventRowId(event.id)}
              className="p-3"
              style={{
                border: 'var(--border-weight) solid var(--border)',
                borderRadius: 'var(--radius-ui)',
                backgroundColor: hoveredJobId && event.jobId === hoveredJobId ? HIGHLIGHT_BACKGROUND : undefined,
              }}
            >
              <Box className="flex items-start justify-between gap-2">
                <Typography variant="caption" color="secondary" className="block">
                  {formatEventTime(event.occurredAt)}
                  {delta ? ` (${delta})` : ''}
                </Typography>
                <Box className="flex items-center shrink-0">
                  {event.jobId && (
                    <JobLinkButton jobId={event.jobId} onSelectJob={onSelectJob} onHoverJobChange={setHoveredJobId} />
                  )}
                  {expander(event)}
                </Box>
              </Box>
              <VideoCell {...cell} />
              <Box className="flex items-center gap-2 flex-wrap">
                <EventMessage
                  message={event.message}
                  expanded={expanded.has(event.id)}
                  onMore={() => toggle(event.id)}
                  hasDetail={offersDetailLink(event)}
                />
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
          minWidth: FIXED_WIDTH_TOTAL + MIN_VIDEO_COLUMN_WIDTH + MIN_EVENT_COLUMN_WIDTH + (timeline ? COLUMN_WIDTHS.sincePrevious : 0),
        }}
      >
        <TableHead>
          <TableRow>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.expander)} />
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.time)}>Time</TableCell>
            {timeline && (
              <TableCell component="th" title="Time since the previous step" style={cellStyle(COLUMN_WIDTHS.sincePrevious)}>Δ time</TableCell>
            )}
            <TableCell component="th" style={cellStyle()}>Video</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.channel)}>Channel</TableCell>
            <TableCell component="th" title="In library" style={cellStyle(COLUMN_WIDTHS.library)}>
              <Library size={16} aria-hidden="true" />
              <span className="sr-only">Library</span>
            </TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.source)}>Source</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.type)}>Type</TableCell>
            <TableCell component="th" title="Component" style={cellStyle(COLUMN_WIDTHS.component)}>Comp.</TableCell>
            <TableCell component="th" style={cellStyle(COLUMN_WIDTHS.level)}>Level</TableCell>
            <TableCell component="th" style={cellStyle()}>Event</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {events.map((event, index) => {
            const cell = { event, onSelectVideo, onSelectJob, onOpenVideo };
            return (
              <React.Fragment key={event.id}>
                <TableRow
                  hover
                  id={eventRowId(event.id)}
                  style={{ backgroundColor: hoveredJobId && event.jobId === hoveredJobId ? HIGHLIGHT_BACKGROUND : undefined }}
                >
                  <TableCell style={cellStyle()}>
                    <Box className="flex items-center">
                      {event.jobId && (
                        <JobLinkButton jobId={event.jobId} onSelectJob={onSelectJob} onHoverJobChange={setHoveredJobId} />
                      )}
                      {expander(event)}
                    </Box>
                  </TableCell>
                  <TableCell style={cellStyle(undefined, true)}><TimeStack iso={event.occurredAt} /></TableCell>
                  {timeline && <TableCell style={cellStyle(undefined, true)}>{deltaFor(events, index, timeline) ?? ''}</TableCell>}
                  <TableCell style={cellStyle()}><VideoCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}><ChannelCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}>{trackedLabel(event.isTracked)}</TableCell>
                  <TableCell style={cellStyle()}><SourceCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}><BreakableType type={event.eventType} /></TableCell>
                  <TableCell style={cellStyle()} title={componentLabel(event.actor)}>{componentAbbr(event.actor)}</TableCell>
                  <TableCell style={cellStyle()}><LevelCell {...cell} /></TableCell>
                  <TableCell style={cellStyle()}>
                    <EventMessage
                      message={event.message}
                      expanded={expanded.has(event.id)}
                      onMore={() => toggle(event.id)}
                      hasDetail={offersDetailLink(event)}
                    />
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
