// One entry of the append-only video/events log (GET /api/job-events).
export type JobEventLevel = 'info' | 'warn' | 'error';

export interface JobEvent {
  id: number;
  // ISO timestamp with milliseconds
  occurredAt: string;
  jobId: string | null;
  youtubeId: string | null;
  eventType: string;
  level: JobEventLevel | string;
  actor: string | null;
  // Rendered once when the event happened; never recomputed
  message: string;
  detail: Record<string, unknown> | null;
  // Snapshot taken at write time, so present even after the video/job is gone
  videoTitle: string | null;
  channelName: string | null;
  jobType: string | null;
  // The job's source label, stored with the event (e.g. NZB (TV), Channels); null = no job
  source: string | null;
  // Whether the video had a library row when the event happened (recorded at
  // that moment); null when it was not known then, or there is no video.
  isTracked: boolean | null;
}

export interface JobEventPage {
  events: JobEvent[];
  // Number of events matching the filters, across all pages
  total: number;
}

export interface JobEventFilters {
  jobId?: string;
  youtubeId?: string;
  level?: string;
  // Event type family: job, video, nzb, strm or cache
  category?: string;
  // Exact event type, e.g. video.failed
  eventType?: string;
  actor?: string;
  channel?: string;
  // Job source label as stored, e.g. NZB (TV) or Channels
  source?: string;
  // 'tracked' or 'untracked': whether the video was in the library at that moment
  tracked?: string;
  q?: string;
  // ISO instants bounding when the event happened
  from?: string;
  to?: string;
}

// Values each filter dropdown can offer (GET /api/job-events/facets)
export interface JobEventFacets {
  eventTypes: string[];
  actors: string[];
  channels: string[];
  sources: string[];
}
