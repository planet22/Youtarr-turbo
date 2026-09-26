import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import type { JobEvent, JobEventFacets, JobEventFilters, JobEventPage } from '../../../../types/JobEvent';

const NO_FACETS: JobEventFacets = { eventTypes: [], actors: [], channels: [], sources: [] };

export interface UseJobEventsReturn {
  events: JobEvent[];
  // Events matching the filters across every page
  total: number;
  // Values the filter dropdowns can offer, taken from the log itself
  facets: JobEventFacets;
  loading: boolean;
  error: string | null;
  // Re-reads the current page without clearing it (used for live updates).
  refresh: () => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to load the events log';
}

/**
 * Reads one page of the video/events log. `ascending` is chosen by the caller
 * (oldest first when the list is filtered, newest first otherwise).
 */
export function useJobEvents(
  token: string | null,
  filters: JobEventFilters,
  page: number,
  pageSize: number,
  ascending: boolean
): UseJobEventsReturn {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<JobEventFacets>(NO_FACETS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);

  const { jobId, youtubeId, level, category, eventType, actor, channel, source, tracked, q, from, to } = filters;

  const fetchPage = useCallback(async (): Promise<JobEventPage> => {
    const params: Record<string, string | number> = {
      limit: pageSize,
      offset: (page - 1) * pageSize,
      order: ascending ? 'asc' : 'desc',
    };
    const optional: Record<string, string | undefined> = {
      jobId, youtubeId, level, category, eventType, actor, channel, source, tracked, q, from, to,
    };
    Object.entries(optional).forEach(([name, value]) => {
      if (value) params[name] = value;
    });
    const response = await axios.get<JobEventPage>('/api/job-events', {
      headers: { 'x-access-token': token },
      params,
    });
    return response.data;
  }, [token, page, pageSize, ascending, jobId, youtubeId, level, category, eventType, actor, channel, source, tracked, q, from, to]);

  const fetchFacets = useCallback(async () => {
    const response = await axios.get<JobEventFacets>('/api/job-events/facets', {
      headers: { 'x-access-token': token },
    });
    setFacets(response.data);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    // Dropdown options are a convenience; the log still works without them.
    fetchFacets().catch(() => {});
  }, [token, fetchFacets]);

  useEffect(() => {
    if (!token) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    fetchPage()
      .then((result) => {
        if (generation !== generationRef.current) return;
        setEvents(result.events);
        setTotal(result.total);
      })
      .catch((err: unknown) => {
        if (generation === generationRef.current) setError(errorMessage(err));
      })
      .finally(() => {
        if (generation === generationRef.current) setLoading(false);
      });
  }, [token, fetchPage]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const generation = generationRef.current;
    try {
      const result = await fetchPage();
      if (generation !== generationRef.current) return;
      setEvents(result.events);
      setTotal(result.total);
      fetchFacets().catch(() => {});
    } catch {
      // Keep what is on screen; the next broadcast retries.
    }
  }, [token, fetchPage, fetchFacets]);

  return { events, total, facets, loading, error, refresh };
}
