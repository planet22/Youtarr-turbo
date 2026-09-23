import React, { useMemo } from 'react';
import { Box, Typography } from '../../../ui';
import type { JobEvent } from '../../../../types/JobEvent';
import { formatEventDelta, stepLabel } from '../eventLogFormat';
import { buildSwimlanes, buildTimeTicks } from '../jobViewData';

export interface EventSwimlaneLanesProps {
  events: JobEvent[];
  // A dot was clicked: show that event in the table below.
  onSelectEvent: (eventId: number) => void;
  // Smaller lane label and a shorter scroll area, for nesting inside a group.
  compact?: boolean;
}

const LANE_LABEL_WIDTH = 160;
const COMPACT_LANE_LABEL_WIDTH = 120;
const MAX_LANES_HEIGHT = 240;
const COMPACT_MAX_LANES_HEIGHT = 140;
const DOT_SIZE = 12;
const RULER_HEIGHT = 22;

const DOT_COLOR_CLASS: Record<string, string> = {
  error: 'bg-destructive',
  warn: 'bg-warning',
};
const DEFAULT_DOT_COLOR_CLASS = 'bg-muted-foreground';
export const dotColorClass = (level: string): string => DOT_COLOR_CLASS[level] ?? DEFAULT_DOT_COLOR_CLASS;

export const LEGEND_ITEMS: ReadonlyArray<{ level: string; label: string }> = [
  { level: 'info', label: 'Info' },
  { level: 'warn', label: 'Warning' },
  { level: 'error', label: 'Error' },
];

export const LegendDot: React.FC<{ level: string; label: string }> = ({ level, label }) => (
  <Box className="flex items-center gap-1">
    <Box className={`rounded-full shrink-0 ${dotColorClass(level)}`} style={{ width: 9, height: 9 }} aria-hidden="true" />
    <Typography variant="caption" color="secondary">{label}</Typography>
  </Box>
);

// A tick's time as elapsed-since-start ("0", "2.278 s"), which stays
// meaningful even when a job runs well under a minute - unlike a clock time,
// which would repeat across most or all of the ticks.
function elapsedLabel(startIso: string, tickIso: string): string {
  if (startIso === tickIso) return '0';
  return (formatEventDelta(startIso, tickIso) ?? '').replace(/^\+/, '');
}

// A label at the plot's left edge would run off to the left if centered on
// its tick, and one at the right edge would run off to the right; only the
// interior ticks stay centered. The tick mark itself is drawn separately and
// always stays exactly on its position - only the text underneath shifts.
function labelTransform(fraction: number): string {
  if (fraction === 0) return 'translateX(0)';
  if (fraction === 1) return 'translateX(-100%)';
  return 'translateX(-50%)';
}

// A ruler of the same width as the lanes below it: a tick and an elapsed-time
// label every quarter of the job's span, so the dots read against a visible
// scale instead of floating with only two endpoint labels to judge distance by.
const TimeRuler: React.FC<{ startIso: string; endIso: string; laneLabelWidth: number }> = ({ startIso, endIso, laneLabelWidth }) => {
  const ticks = useMemo(() => buildTimeTicks(startIso, endIso), [startIso, endIso]);
  return (
    <Box className="flex items-center gap-2 mb-1">
      <Box className="shrink-0" style={{ width: laneLabelWidth }} />
      <Box className="relative flex-1" style={{ height: RULER_HEIGHT }}>
        <Box className="absolute left-0 right-0 bg-border" style={{ bottom: 0, height: 1 }} aria-hidden="true" />
        {ticks.map((tick) => (
          <React.Fragment key={tick.fraction}>
            <Box
              className="absolute bg-border"
              style={{ left: `${tick.left}%`, bottom: 0, width: 1, height: 5, transform: 'translateX(-50%)' }}
              aria-hidden="true"
            />
            <Typography
              variant="caption"
              color="secondary"
              className="absolute"
              style={{
                left: `${tick.left}%`,
                top: 0,
                fontSize: '0.65rem',
                lineHeight: 1.4,
                whiteSpace: 'nowrap',
                transform: labelTransform(tick.fraction),
              }}
            >
              {elapsedLabel(startIso, tick.iso)}
            </Typography>
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
};

// The ruler and lanes shared by the full-page Swimlanes view and a job group's
// own mini timeline: one row per video (or job/solo group) on a shared time
// axis, a dot per recorded step positioned by when it happened and colored by
// level, and a ruler above marking time elapsed since the first event.
const EventSwimlaneLanes: React.FC<EventSwimlaneLanesProps> = ({ events, onSelectEvent, compact = false }) => {
  const { lanes, startIso, endIso } = useMemo(() => buildSwimlanes(events), [events]);
  if (!startIso || !endIso) return null;
  const laneLabelWidth = compact ? COMPACT_LANE_LABEL_WIDTH : LANE_LABEL_WIDTH;

  return (
    <>
      <TimeRuler startIso={startIso} endIso={endIso} laneLabelWidth={laneLabelWidth} />
      <Box className="overflow-y-auto" style={{ maxHeight: compact ? COMPACT_MAX_LANES_HEIGHT : MAX_LANES_HEIGHT }}>
        {lanes.map((lane, index) => (
          <Box
            key={lane.key}
            data-testid="event-swimlane"
            className="flex items-center gap-2 py-1"
            style={{ backgroundColor: index % 2 === 1 ? 'var(--muted)' : undefined, borderRadius: 'var(--radius-ui)' }}
          >
            <Box className="shrink-0 truncate text-xs pl-1" style={{ width: laneLabelWidth }} title={lane.label}>
              {lane.label}
            </Box>
            <Box className="relative flex-1" style={{ height: DOT_SIZE + 6 }}>
              <Box
                className="absolute left-0 right-0 bg-border"
                style={{ top: '50%', height: 1 }}
                aria-hidden="true"
              />
              {lane.points.map(({ event, left }) => (
                <button
                  key={event.id}
                  type="button"
                  aria-label={`${stepLabel(event.eventType)} - ${event.message}`}
                  title={`+${elapsedLabel(startIso, event.occurredAt)}  ${stepLabel(event.eventType)}\n${event.message}`}
                  onClick={() => onSelectEvent(event.id)}
                  className={`absolute rounded-full ${dotColorClass(event.level)}`}
                  style={{
                    left: `${left}%`,
                    top: '50%',
                    width: DOT_SIZE,
                    height: DOT_SIZE,
                    transform: 'translate(-50%, -50%)',
                    padding: 0,
                    border: '2px solid var(--card)',
                  }}
                />
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    </>
  );
};

export default EventSwimlaneLanes;
