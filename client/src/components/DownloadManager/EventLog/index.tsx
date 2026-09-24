import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { X as ClearIcon } from 'lucide-react';
import { Grid, Typography } from '../../ui';
import useMediaQuery from '../../../hooks/useMediaQuery';
import { useDownloadListingsRefresh } from '../../../hooks/useDownloadListingsRefresh';
import type { JobEvent, JobEventFilters } from '../../../types/JobEvent';
import VideoModal from '../../shared/VideoModal';
import { eventToVideoModalData } from './videoModalData';
import {
  useListPageSize,
  usePersistedFilterState,
  useVideoListState,
  VideoListContainer,
  VideoListPaginationBar,
  type FilterConfig,
} from '../../shared/VideoList';
import { useJobEvents } from './hooks/useJobEvents';
import EventLogTable, { type EventReveal } from './components/EventLogTable';
import EventGroupedTable from './components/EventGroupedTable';
import EventSwimlanes from './components/EventSwimlanes';
import JobViewToggles from './components/JobViewToggles';
import {
  dayEndIso,
  dayStartIso,
  EVENT_LEVEL_FILTER_OPTIONS,
  TRACKED_OPTIONS,
  componentLabel,
} from './eventLogFormat';

// Deep-link parameters (e.g. from a link to one job's or video's timeline).
const PARAM_JOB = 'job';
const PARAM_VIDEO = 'video';

interface EventLogProps {
  token: string | null;
}

/**
 * The video/events log: every recorded step of every job and video, with
 * millisecond timestamps. Nothing here is recomputed from live state - each
 * line was written once when it happened. Filters and paging use the same
 * shared list chrome as Download History.
 */
const EventLog: React.FC<EventLogProps> = ({ token }) => {
  const isMobile = useMediaQuery('(max-width: 599px)');
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get(PARAM_JOB) || undefined;
  const youtubeId = searchParams.get(PARAM_VIDEO) || undefined;

  const [level, setLevel] = usePersistedFilterState('youtarr:eventLog:filter:level', '');
  const [eventType, setEventType] = usePersistedFilterState('youtarr:eventLog:filter:eventType', '');
  const [source, setSource] = usePersistedFilterState('youtarr:eventLog:filter:source', '');
  const [actor, setActor] = usePersistedFilterState('youtarr:eventLog:filter:actor', '');
  const [channel, setChannel] = usePersistedFilterState('youtarr:eventLog:filter:channel', '');
  const [tracked, setTracked] = usePersistedFilterState('youtarr:eventLog:filter:tracked', '');
  const [dateFrom, setDateFrom] = usePersistedFilterState('youtarr:eventLog:filter:dateFrom', '');
  const [dateTo, setDateTo] = usePersistedFilterState('youtarr:eventLog:filter:dateTo', '');
  const listState = useVideoListState({ initialViewMode: 'table', searchStorageKey: 'youtarr:eventLogSearch' });
  const search = listState.search.trim();

  const [pageSize, setPageSize] = useListPageSize('youtarr.eventLog.pageSize');
  const [page, setPage] = useState(1);
  // Optional views of whatever's on screen; off until switched on, then remembered.
  const [showSwimlanes, setShowSwimlanes] = usePersistedFilterState('youtarr:eventLog:view:swimlanes', false);
  const [groupByJob, setGroupByJob] = usePersistedFilterState('youtarr:eventLog:view:groupByVideo', false);
  const [groupTimeline, setGroupTimeline] = usePersistedFilterState('youtarr:eventLog:view:groupTimeline', false);
  const [reveal, setReveal] = useState<EventReveal | null>(null);
  const [modalEvent, setModalEvent] = useState<JobEvent | null>(null);

  const filters = useMemo<JobEventFilters>(
    () => ({
      jobId,
      youtubeId,
      level: level || undefined,
      eventType: eventType || undefined,
      source: source || undefined,
      actor: actor || undefined,
      channel: channel || undefined,
      tracked: tracked || undefined,
      q: search || undefined,
      from: dateFrom ? dayStartIso(dateFrom) : undefined,
      to: dateTo ? dayEndIso(dateTo) : undefined,
    }),
    [jobId, youtubeId, level, eventType, source, actor, channel, tracked, search, dateFrom, dateTo]
  );

  // Latest first normally; as soon as anything narrows the list it reads as a
  // story, so it runs oldest to newest. The "since previous" column only
  // makes sense for a single job's or video's story.
  const hasFilters = Object.values(filters).some(Boolean);
  const singleSubject = Boolean(jobId || youtubeId);

  useEffect(() => {
    setPage(1);
  }, [filters, pageSize]);

  const { events, total, facets, loading, error, refresh } = useJobEvents(token, filters, page, pageSize, hasFilters);
  useDownloadListingsRefresh(refresh);

  const clearParam = useCallback(
    (name: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.delete(name);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );
  const setParam = useCallback(
    (name: string, value: string) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(name, value);
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      ...(jobId
        ? [{ id: 'toggle' as const, label: 'Single job only', icon: <ClearIcon size={16} />, value: true, onChange: () => clearParam(PARAM_JOB) }]
        : []),
      ...(youtubeId
        ? [{ id: 'toggle' as const, label: 'Single video only', icon: <ClearIcon size={16} />, value: true, onChange: () => clearParam(PARAM_VIDEO) }]
        : []),
      // In the order of the table's columns (Video and Event are covered by the search box).
      { id: 'dateRangeString', label: 'Occurred', dateFrom, dateTo, onFromChange: setDateFrom, onToChange: setDateTo, breakAfter: true },
      { id: 'select', label: 'Channel', value: channel, options: facets.channels, onChange: setChannel },
      { id: 'select', label: 'Library', value: tracked, options: [...TRACKED_OPTIONS], onChange: setTracked },
      { id: 'select', label: 'Source', value: source, options: facets.sources, onChange: setSource },
      { id: 'select', label: 'Event type', value: eventType, options: facets.eventTypes, onChange: setEventType },
      {
        id: 'select',
        label: 'Component',
        value: componentLabel(actor),
        options: facets.actors.map(componentLabel),
        onChange: (label: string) => setActor(facets.actors.find((name) => componentLabel(name) === label) ?? label),
      },
      { id: 'select', label: 'Level', value: level, options: [...EVENT_LEVEL_FILTER_OPTIONS], onChange: setLevel },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobId, youtubeId, level, eventType, source, actor, channel, tracked, facets, dateFrom, dateTo, clearParam]
  );

  const revealEvent = useCallback(
    (eventId: number) => setReveal((previous) => ({ eventId, seq: (previous?.seq ?? 0) + 1 })),
    []
  );

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const paginationBar = (placement: 'top' | 'bottom') => (
    <VideoListPaginationBar
      placement={placement}
      hasContent={total > 0}
      useInfiniteScroll={false}
      page={page}
      totalPages={totalPages}
      onPageChange={setPage}
      pageSize={pageSize}
      onPageSizeChange={setPageSize}
      isMobile={isMobile}
    />
  );

  const headerSlot = (
    <div style={{ padding: '12px 16px 0 16px' }}>
      <Typography variant={isMobile ? 'h6' : 'h5'} align="center">
        Video / Events Log ({total} event{total === 1 ? '' : 's'})
      </Typography>
    </div>
  );

  return (
    <>
    <Grid item xs={12}>
      <VideoListContainer<string>
        state={listState}
        viewModes={['table']}
        filters={filterConfigs}
        searchPlaceholder="Search events by video, channel or message..."
        searchTooltip="Searches the event text, video title and channel name."
        headerSlot={headerSlot}
        toolbarExtras={
          <JobViewToggles
            swimlanes={showSwimlanes}
            onSwimlanesChange={setShowSwimlanes}
            swimlanesAvailable={Boolean(jobId)}
            groupByJob={groupByJob}
            onGroupByJobChange={setGroupByJob}
            groupTimeline={groupTimeline}
            onGroupTimelineChange={setGroupTimeline}
          />
        }
        itemCount={events.length}
        isLoading={loading && events.length === 0}
        isError={Boolean(error)}
        errorMessage={error}
        customEmptyMessage={hasFilters ? 'No events found matching your filters' : 'No events recorded yet'}
        renderContent={() => (
          <>
            {jobId && showSwimlanes && <EventSwimlanes events={events} onSelectEvent={revealEvent} />}
            {groupByJob ? (
              <EventGroupedTable
                events={events}
                isMobile={isMobile}
                onSelectVideo={(id) => setParam(PARAM_VIDEO, id)}
                onSelectJob={(id) => setParam(PARAM_JOB, id)}
                onOpenVideo={setModalEvent}
                reveal={reveal}
                onSelectEvent={revealEvent}
                showTimeline={groupTimeline}
              />
            ) : (
              <EventLogTable
                events={events}
                timeline={singleSubject}
                isMobile={isMobile}
                onSelectVideo={(id) => setParam(PARAM_VIDEO, id)}
                onSelectJob={(id) => setParam(PARAM_JOB, id)}
                onOpenVideo={setModalEvent}
                reveal={reveal}
              />
            )}
          </>
        )}
        pagination={paginationBar('bottom')}
        paginationTop={paginationBar('top')}
        paginationMode="pages"
        isMobile={isMobile}
      />
    </Grid>
    {modalEvent && (
      <VideoModal
        open
        onClose={() => setModalEvent(null)}
        video={eventToVideoModalData(modalEvent)}
        token={token}
        onVideoDeleted={() => {
          setModalEvent(null);
          refresh();
        }}
      />
    )}
    </>
  );
};

export default EventLog;
