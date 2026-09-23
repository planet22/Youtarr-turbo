import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Box, Chip, Typography } from '../../../ui';
import type { JobEvent } from '../../../../types/JobEvent';
import { eventLevelColor, formatEventDelta, stepLabel } from '../eventLogFormat';
import { groupEventsByJob, type EventGroup } from '../jobViewData';
import EventLogTable, { type EventReveal } from './EventLogTable';
import EventSwimlaneLanes, { LEGEND_ITEMS, LegendDot } from './EventSwimlaneLanes';

interface EventGroupedTableProps {
  events: JobEvent[];
  isMobile: boolean;
  onSelectVideo: (youtubeId: string) => void;
  onSelectJob: (jobId: string) => void;
  onOpenVideo: (event: JobEvent) => void;
  reveal?: EventReveal | null;
  // A group's mini-swimlane dot was clicked (only used when showTimeline is true).
  onSelectEvent: (eventId: number) => void;
  // Chips (default) or a mini swimlane per group, grouped by video within it.
  showTimeline: boolean;
}

// The step chain of one video as short words, "queued > started > downloaded".
// A step repeated back to back (retries, progress) is shown once.
function stepChain(events: JobEvent[]): JobEvent[] {
  return events.filter((event, index) => index === 0 || event.eventType !== events[index - 1].eventType);
}

function totalTime(events: JobEvent[]): string {
  if (events.length < 2) return '';
  return (formatEventDelta(events[0].occurredAt, events[events.length - 1].occurredAt) ?? '').replace(/^\+/, '');
}

interface GroupHeaderProps {
  group: EventGroup;
  open: boolean;
  onToggle: () => void;
  showTimeline: boolean;
  onSelectEvent: (eventId: number) => void;
}

// The toggle button (chevron, title, count) and the content row below it
// (chips or a mini swimlane) are siblings, not nested - a swimlane's dots are
// themselves buttons, and a button cannot contain another interactive button.
const GroupHeader: React.FC<GroupHeaderProps> = ({ group, open, onToggle, showTimeline, onSelectEvent }) => {
  const total = totalTime(group.events);
  return (
    <Box className="p-2 flex flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${group.title}`}
        className="w-full text-left flex items-center gap-2 min-w-0 hover:bg-muted"
        style={{ background: 'none', border: 'none', padding: 0 }}
      >
        <ChevronDown
          size={16}
          className="shrink-0"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms' }}
        />
        <Typography variant="body2" className="font-semibold truncate">{group.title}</Typography>
        {group.channelName && <Typography variant="caption" color="secondary" className="truncate">{group.channelName}</Typography>}
        <Typography variant="caption" color="secondary" className="ml-auto shrink-0">
          {group.events.length} event{group.events.length === 1 ? '' : 's'}{total ? ` - ${total}` : ''}
        </Typography>
      </button>
      {showTimeline ? (
        <Box className="pl-6">
          <EventSwimlaneLanes events={group.events} onSelectEvent={onSelectEvent} compact />
        </Box>
      ) : (
        <Box className="flex flex-wrap items-center gap-1 pl-6">
          {stepChain(group.events).map((event) => (
            <Chip
              key={event.id}
              size="small"
              variant="outlined"
              color={eventLevelColor(event.level)}
              label={stepLabel(event.eventType)}
            />
          ))}
        </Box>
      )}
    </Box>
  );
};

// Every job (and any job-less video or event) as a collapsed group: its
// title, how many steps and how long they took, and either its step chips or
// (Timeline option) a mini per-video swimlane at a glance. Opening a group
// shows the same rows as the flat table, oldest first.
const EventGroupedTable: React.FC<EventGroupedTableProps> = ({
  events,
  isMobile,
  onSelectVideo,
  onSelectJob,
  onOpenVideo,
  reveal,
  onSelectEvent,
  showTimeline,
}) => {
  const groups = useMemo(() => groupEventsByJob(events), [events]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // A reveal is handed to its group's table once, so closing and reopening the group later does not jump back to it.
  const [consumedSeq, setConsumedSeq] = useState<number | null>(null);

  const revealGroupKey = useMemo(
    () => (reveal ? groups.find((group) => group.events.some((event) => event.id === reveal.eventId))?.key ?? null : null),
    [groups, reveal]
  );

  useEffect(() => {
    if (!revealGroupKey) return;
    setOpen((previous) => new Set(previous).add(revealGroupKey));
  }, [revealGroupKey, reveal]);

  useEffect(() => {
    if (reveal && revealGroupKey && open.has(revealGroupKey)) setConsumedSeq(reveal.seq);
  }, [reveal, revealGroupKey, open]);

  const toggle = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Box className="flex flex-col gap-2">
      {showTimeline && (
        <Box className="flex items-center gap-3 px-2">
          {LEGEND_ITEMS.map((item) => <LegendDot key={item.level} level={item.level} label={item.label} />)}
        </Box>
      )}
      {groups.map((group) => {
        const isOpen = open.has(group.key);
        const groupReveal = reveal && group.key === revealGroupKey && reveal.seq !== consumedSeq ? reveal : null;
        return (
          <Box
            key={group.key}
            data-testid="event-group"
            style={{ border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}
          >
            <GroupHeader
              group={group}
              open={isOpen}
              onToggle={() => toggle(group.key)}
              showTimeline={showTimeline}
              onSelectEvent={onSelectEvent}
            />
            {isOpen && (
              <EventLogTable
                events={group.events}
                timeline
                isMobile={isMobile}
                onSelectVideo={onSelectVideo}
                onSelectJob={onSelectJob}
                onOpenVideo={onOpenVideo}
                reveal={groupReveal}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
};

export default EventGroupedTable;
