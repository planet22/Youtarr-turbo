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
}

export interface JobEventPage {
  events: JobEvent[];
  nextCursor: number | null;
}

export interface JobEventFilters {
  jobId?: string;
  youtubeId?: string;
  level?: string;
  q?: string;
}
