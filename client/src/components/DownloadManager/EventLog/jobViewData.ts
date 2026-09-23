import type { JobEvent } from '../../../types/JobEvent';
import { stepLabel } from './eventLogFormat';

// Data for the two optional log views: swimlanes (only meaningful for a
// single job, where video is the natural lane) and the "By job" grouped view
// (meaningful for any list of events, including the whole log with many
// unrelated jobs interleaved, and optionally shows its own mini swimlane per
// job using the same video-lane grouping). Derived from the events already on
// screen; nothing is fetched or recomputed from live state.

// The plot keeps a margin so the first and last dots are not cut by the edge,
// and dots in one lane are never closer than a dot's width, so steps a few
// milliseconds apart stay separate and clickable.
export const PLOT_MARGIN_PERCENT = 1.5;
const MIN_DOT_GAP_PERCENT = 1.6;

// Evenly spaced points across the plot for a time ruler, as a fraction of the
// span (0 = start, 1 = end) paired with the instant at that fraction.
export const TICK_FRACTIONS: readonly number[] = [0, 0.25, 0.5, 0.75, 1];

export interface TimeTick {
  fraction: number;
  // Position inside the plot, 0-100 - the same coordinate space as a LanePoint's left.
  left: number;
  iso: string;
}

export interface EventGroup {
  key: string;
  // Null for a job's own events (created, started, finished ...) and for an
  // event tied to neither a job nor a video.
  youtubeId: string | null;
  title: string;
  channelName: string | null;
  // Oldest first.
  events: JobEvent[];
}

export interface LanePoint {
  event: JobEvent;
  // Horizontal position inside the plot, 0-100.
  left: number;
}

export interface Lane {
  key: string;
  label: string;
  points: LanePoint[];
}

export interface Swimlanes {
  lanes: Lane[];
  // The plot's left and right edges; null when there are no events.
  startIso: string | null;
  endIso: string | null;
}

function isoTime(iso: string): number {
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function timeOf(event: JobEvent): number {
  return isoTime(event.occurredAt);
}

const byTime = (a: JobEvent, b: JobEvent): number => timeOf(a) - timeOf(b) || a.id - b.id;

// A capitalized one-off label for an event tied to neither a job nor a video
// (e.g. a maintenance action) - each such event is its own group, since there
// is nothing that says two of them belong together.
function soloTitle(event: JobEvent): string {
  const label = stepLabel(event.eventType);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The group an event belongs to when grouping by video: its video, its job
// (keyed by job id, not job type, so two different jobs of the same type stay
// apart) for a job-only event, or - lacking both - itself alone.
function identifyByVideo(event: JobEvent): { key: string; youtubeId: string | null; title: string } {
  if (event.youtubeId) return { key: event.youtubeId, youtubeId: event.youtubeId, title: event.videoTitle || event.youtubeId };
  if (event.jobId) return { key: `job:${event.jobId}`, youtubeId: null, title: event.jobType ? `Job: ${event.jobType}` : 'Job' };
  return { key: `solo:${event.id}`, youtubeId: null, title: soloTitle(event) };
}

// The group an event belongs to when grouping by job: its job (keyed by job
// id), regardless of which of its job's videos the event is about, or -
// lacking a job - its video, or - lacking both - itself alone.
function identifyByJob(event: JobEvent): { key: string; youtubeId: string | null; title: string } {
  if (event.jobId) return { key: `job:${event.jobId}`, youtubeId: null, title: event.jobType ? `Job: ${event.jobType}` : 'Job' };
  if (event.youtubeId) return { key: event.youtubeId, youtubeId: event.youtubeId, title: event.videoTitle || event.youtubeId };
  return { key: `solo:${event.id}`, youtubeId: null, title: soloTitle(event) };
}

function group(events: JobEvent[], identify: (event: JobEvent) => { key: string; youtubeId: string | null; title: string }): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  const order: string[] = [];
  [...events].sort(byTime).forEach((event) => {
    const { key, youtubeId, title } = identify(event);
    let entry = groups.get(key);
    if (!entry) {
      entry = { key, youtubeId, title, channelName: event.channelName, events: [] };
      groups.set(key, entry);
      order.push(key);
    }
    if (event.youtubeId && !entry.channelName) entry.channelName = event.channelName;
    if (event.youtubeId && entry.title === event.youtubeId && event.videoTitle) entry.title = event.videoTitle;
    entry.events.push(event);
  });

  return order.map((key) => groups.get(key) as EventGroup);
}

// One group per video, per job (its own events - created, started, finished
// ...) and per job-less/video-less event, in the order each first appeared.
// Used for the swimlane view, where video is the meaningful lane even inside
// one job (that's exactly what makes a multi-video job's timeline readable).
export function groupEventsByVideo(events: JobEvent[]): EventGroup[] {
  return group(events, identifyByVideo);
}

// One group per job (all its events, whichever videos they touch), per
// job-less video, and per job-less/video-less event, in the order each first
// appeared. Used for the "By job" view, so a job that downloaded several
// videos collapses to one row instead of one per video.
export function groupEventsByJob(events: JobEvent[]): EventGroup[] {
  return group(events, identifyByJob);
}

// Pushes dots apart so none sits closer than MIN_DOT_GAP_PERCENT to the one
// before it, then pulls the last ones back in if that ran past the right edge.
function spreadApart(positions: number[]): number[] {
  const spread = [...positions];
  for (let i = 1; i < spread.length; i++) {
    spread[i] = Math.max(spread[i], spread[i - 1] + MIN_DOT_GAP_PERCENT);
  }
  const rightEdge = 100 - PLOT_MARGIN_PERCENT;
  for (let i = spread.length - 1; i >= 0; i--) {
    const limit = i === spread.length - 1 ? rightEdge : spread[i + 1] - MIN_DOT_GAP_PERCENT;
    spread[i] = Math.min(spread[i], limit);
  }
  return spread.map((position) => Math.max(position, 0));
}

// One lane per group (video, job, or solo event) on a shared time axis, so a
// slow video or a long wait between steps shows as space.
export function buildSwimlanes(events: JobEvent[]): Swimlanes {
  if (events.length === 0) return { lanes: [], startIso: null, endIso: null };

  const ordered = [...events].sort(byTime);
  const start = timeOf(ordered[0]);
  const end = timeOf(ordered[ordered.length - 1]);
  const span = end - start;
  const plotWidth = 100 - PLOT_MARGIN_PERCENT * 2;

  const lanes = groupEventsByVideo(events).map((group): Lane => {
    const raw = group.events.map((event) =>
      PLOT_MARGIN_PERCENT + (span > 0 ? ((timeOf(event) - start) / span) * plotWidth : 0)
    );
    const positions = spreadApart(raw);
    return {
      key: group.key,
      label: group.title,
      points: group.events.map((event, index) => ({ event, left: positions[index] })),
    };
  });

  return { lanes, startIso: ordered[0].occurredAt, endIso: ordered[ordered.length - 1].occurredAt };
}

// A time ruler's tick marks, at TICK_FRACTIONS across the same plot the dots sit in.
// startIso/endIso are an event's own recorded occurredAt, so - same as timeOf -
// an unparseable one is treated as the epoch rather than left to throw out of
// Date#toISOString when building interpolated tick instants.
export function buildTimeTicks(startIso: string, endIso: string): TimeTick[] {
  const start = isoTime(startIso);
  const end = isoTime(endIso);
  const plotWidth = 100 - PLOT_MARGIN_PERCENT * 2;
  return TICK_FRACTIONS.map((fraction) => ({
    fraction,
    left: PLOT_MARGIN_PERCENT + fraction * plotWidth,
    iso: new Date(start + fraction * (end - start)).toISOString(),
  }));
}
