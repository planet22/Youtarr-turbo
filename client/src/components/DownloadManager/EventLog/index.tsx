import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, Card, Grid, Typography } from '../../ui';
import useMediaQuery from '../../../hooks/useMediaQuery';
import { useDownloadListingsRefresh } from '../../../hooks/useDownloadListingsRefresh';
import type { JobEventFilters } from '../../../types/JobEvent';
import { useJobEvents } from './hooks/useJobEvents';
import EventLogFilters from './components/EventLogFilters';
import EventLogTable from './components/EventLogTable';

const SEARCH_DEBOUNCE_MS = 300;

// URL parameter names; kept in the URL so a job's or video's timeline can be
// linked to (e.g. from Download History) and survives a reload.
const PARAM_JOB = 'job';
const PARAM_VIDEO = 'video';
const PARAM_LEVEL = 'level';
const PARAM_SEARCH = 'q';

interface EventLogProps {
  token: string | null;
}

/**
 * The video/events log: every recorded step of every job and video, with
 * millisecond timestamps. Unlike Download History, nothing here is
 * recomputed from live state - each line was written once when it happened.
 */
const EventLog: React.FC<EventLogProps> = ({ token }) => {
  const isMobile = useMediaQuery('(max-width: 599px)');
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<JobEventFilters>(
    () => ({
      jobId: searchParams.get(PARAM_JOB) || undefined,
      youtubeId: searchParams.get(PARAM_VIDEO) || undefined,
      level: searchParams.get(PARAM_LEVEL) || undefined,
      q: searchParams.get(PARAM_SEARCH) || undefined,
    }),
    [searchParams]
  );

  const setParam = useCallback(
    (name: string, value: string | undefined) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (value) next.set(name, value);
          else next.delete(name);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const [searchText, setSearchText] = useState(filters.q ?? '');
  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === (filters.q ?? '')) return;
    const handle = setTimeout(() => setParam(PARAM_SEARCH, trimmed || undefined), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchText, filters.q, setParam]);

  const { events, loading, loadingMore, error, hasMore, timeline, loadMore, refresh } = useJobEvents(token, filters);
  useDownloadListingsRefresh(refresh);

  const jobLabel = events.find((event) => event.jobType)?.jobType ?? undefined;
  const videoLabel = events.find((event) => event.videoTitle)?.videoTitle ?? undefined;

  return (
    <Grid item xs={12}>
      <Card>
        <Box className="px-4 pt-3">
          <Typography variant={isMobile ? 'h6' : 'h5'} align="center">
            Video / Events Log ({events.length}
            {hasMore ? '+' : ''} {events.length === 1 && !hasMore ? 'entry' : 'entries'})
          </Typography>
        </Box>
        <EventLogFilters
          filters={filters}
          searchText={searchText}
          onSearchTextChange={setSearchText}
          onLevelChange={(level) => setParam(PARAM_LEVEL, level || undefined)}
          onClearJob={() => setParam(PARAM_JOB, undefined)}
          onClearVideo={() => setParam(PARAM_VIDEO, undefined)}
          jobLabel={jobLabel}
          videoLabel={videoLabel}
        />
        {error && (
          <Box className="px-3 pb-2">
            <Alert severity="error">{error}</Alert>
          </Box>
        )}
        {loading && events.length === 0 && (
          <Typography variant="body2" color="secondary" align="center" className="p-4">Loading events…</Typography>
        )}
        {!loading && !error && events.length === 0 && (
          <Typography variant="body2" color="secondary" align="center" className="p-4">
            No events recorded{filters.jobId || filters.youtubeId || filters.level || filters.q ? ' for these filters' : ' yet'}.
          </Typography>
        )}
        {events.length > 0 && (
          <EventLogTable
            events={events}
            timeline={timeline}
            isMobile={isMobile}
            onSelectVideo={(youtubeId) => setParam(PARAM_VIDEO, youtubeId)}
            onSelectJob={(jobId) => setParam(PARAM_JOB, jobId)}
          />
        )}
        {hasMore && (
          <Box className="flex justify-center p-3">
            <Button variant="outlined" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </Box>
        )}
      </Card>
    </Grid>
  );
};

export default EventLog;
