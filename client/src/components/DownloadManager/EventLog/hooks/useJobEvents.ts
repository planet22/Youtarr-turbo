import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import type { JobEvent, JobEventFilters, JobEventPage } from '../../../../types/JobEvent';

const PAGE_SIZE = 100;

export interface UseJobEventsReturn {
  events: JobEvent[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  // True when the list is one job's or video's story (oldest first).
  timeline: boolean;
  loadMore: () => Promise<void>;
  // Pulls in entries recorded since the list was loaded, without resetting it.
  refresh: () => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to load the events log';
}

interface MergeResult {
  events: JobEvent[];
  // True when the list was rebuilt from the page, so its cursor replaces ours.
  restarted: boolean;
  nextCursor: number | null;
}

// A page newer than what we hold. Prepends only the unseen entries; if the
// whole page is unseen and more exist behind it, there is a gap, so start over.
// Null means nothing new.
function mergeNewest(current: JobEvent[], page: JobEventPage): MergeResult | null {
  if (current.length === 0) return { events: page.events, restarted: true, nextCursor: page.nextCursor };
  const newestKnown = current[0].id;
  const fresh = page.events.filter((event) => event.id > newestKnown);
  if (fresh.length === 0) return null;
  if (fresh.length === page.events.length && page.nextCursor !== null) {
    return { events: page.events, restarted: true, nextCursor: page.nextCursor };
  }
  return { events: [...fresh, ...current], restarted: false, nextCursor: null };
}

/**
 * Reads the video/events log. A list filtered to one job or video is a
 * timeline (oldest first, paged forward); anything else is the global log
 * (newest first, paged backward).
 */
export function useJobEvents(token: string | null, filters: JobEventFilters): UseJobEventsReturn {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const timeline = Boolean(filters.jobId || filters.youtubeId);
  const { jobId, youtubeId, level, q } = filters;

  const fetchPage = useCallback(
    async (cursor: { before?: number; after?: number }) => {
      const params: Record<string, string | number> = { limit: PAGE_SIZE, order: timeline ? 'asc' : 'desc' };
      if (jobId) params.jobId = jobId;
      if (youtubeId) params.youtubeId = youtubeId;
      if (level) params.level = level;
      if (q) params.q = q;
      if (cursor.before !== undefined) params.before = cursor.before;
      if (cursor.after !== undefined) params.after = cursor.after;
      const response = await axios.get<JobEventPage>('/api/job-events', {
        headers: { 'x-access-token': token },
        params,
      });
      return response.data;
    },
    [token, timeline, jobId, youtubeId, level, q]
  );

  useEffect(() => {
    if (!token) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    fetchPage({})
      .then((page) => {
        if (generation !== generationRef.current) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (generation === generationRef.current) setError(errorMessage(err));
      })
      .finally(() => {
        if (generation === generationRef.current) setLoading(false);
      });
  }, [token, fetchPage]);

  const loadMore = useCallback(async () => {
    if (nextCursor === null || loadingMore) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const page = await fetchPage(timeline ? { after: nextCursor } : { before: nextCursor });
      if (generation !== generationRef.current) return;
      setEvents((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (err: unknown) {
      if (generation === generationRef.current) setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, nextCursor, loadingMore, timeline]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const generation = generationRef.current;
    try {
      if (timeline) {
        // Newer entries belong at the end; if pages are still unloaded they
        // will arrive through loadMore in order, so only append at the tail.
        if (nextCursor !== null) return;
        const lastId = events.length > 0 ? events[events.length - 1].id : 0;
        const page = await fetchPage({ after: lastId });
        if (generation !== generationRef.current || page.events.length === 0) return;
        setEvents((current) => [...current, ...page.events]);
        setNextCursor(page.nextCursor);
        return;
      }
      const page = await fetchPage({});
      if (generation !== generationRef.current) return;
      const merged = mergeNewest(events, page);
      if (!merged) return;
      setEvents(merged.events);
      if (merged.restarted) setNextCursor(merged.nextCursor);
    } catch {
      // Keep what is on screen; the next broadcast retries.
    }
  }, [token, timeline, nextCursor, events, fetchPage]);

  return { events, loading, loadingMore, error, hasMore: nextCursor !== null, timeline, loadMore, refresh };
}
