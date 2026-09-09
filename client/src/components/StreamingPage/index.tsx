import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Grid, Typography } from '../ui';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useActiveStreams, StreamSnapshot } from '../../hooks/useActiveStreams';
import { VideoListContainer, useVideoListState, type SortConfig, type VideoListViewMode } from '../shared/VideoList';
import StreamsTable from './components/StreamsTable';
import StreamCard from './components/StreamCard';
import StreamsListMobile from './components/StreamsListMobile';
import { SegmentActivityDialog } from './components/SegmentActivityGrid';

interface StreamingPageProps {
  token: string | null;
}

type SortKey = 'startedAt' | 'bytesPerSecond' | 'bytesTransferred';

const SORT_OPTIONS = [
  { key: 'startedAt', label: 'Started' },
  { key: 'bytesPerSecond', label: 'Throughput' },
  { key: 'bytesTransferred', label: 'Total transferred' },
];

function StreamingPage({ token }: StreamingPageProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  // Same pattern as VideosPage: a dense mobile "list" view replaces the
  // desktop "table" view (each is only available on its own screen size),
  // with "grid" available on both.
  const listState = useVideoListState({ initialViewMode: isMobile ? 'list' : 'table' });
  const { streams, loading, refetch } = useActiveStreams(token);
  const [sortKey, setSortKey] = useState<SortKey>('startedAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Lifted above StreamsTable/StreamCard (rather than each view owning its
  // own dialog state) so opening a segment detail works identically no
  // matter which view is active - same convention as VideosPage's shared
  // VideoModal state.
  const [selectedStreamId, setSelectedStreamId] = useState<string | null>(null);
  const selectedStream = selectedStreamId ? streams.find((s) => s.streamId === selectedStreamId) || null : null;

  const handleStopped = useCallback(() => {
    // The streamStopped broadcast already removes the row from state; this
    // is just a safety-net refetch in case the broadcast is ever missed
    // (e.g. a reconnecting socket).
    refetch();
  }, [refetch]);

  const filteredAndSorted = useMemo(() => {
    const query = listState.search.trim().toLowerCase();
    const filtered = !query
      ? streams
      : streams.filter((s: StreamSnapshot) =>
          [s.youtubeId, s.title, s.clientIp, s.userAgent].some((value) =>
            value ? value.toLowerCase().includes(query) : false
          )
        );
    const direction = sortDirection === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => direction * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)));
  }, [streams, listState.search, sortKey, sortDirection]);

  const sort: SortConfig = {
    options: SORT_OPTIONS,
    activeKey: sortKey,
    direction: sortDirection,
    onChange: (key, direction) => {
      setSortKey(key as SortKey);
      setSortDirection(direction);
    },
  };

  const headerSlot = (
    <div style={{ padding: '12px 16px 0 16px' }}>
      <Typography variant={isMobile ? 'h6' : 'h5'} align="center">
        Live Streams ({streams.length} active)
      </Typography>
    </div>
  );

  // "list" (dense mobile rows) only makes sense on mobile; "table" only on
  // desktop - "grid" is available on both. Mirrors VideosPage's own split.
  const availableViewModes: VideoListViewMode[] = isMobile ? ['grid', 'list'] : ['grid', 'table'];

  useEffect(() => {
    if (!availableViewModes.includes(listState.viewMode)) {
      listState.setViewMode(isMobile ? 'list' : 'table');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, listState.viewMode]);

  return (
    <>
      <VideoListContainer<string>
        state={listState}
        viewModes={availableViewModes}
        sort={sort}
        searchPlaceholder="Search by video, IP, or client..."
        headerSlot={headerSlot}
        itemCount={filteredAndSorted.length}
        isLoading={loading}
        isError={false}
        renderContent={(mode) => {
          if (mode === 'grid') {
            return (
              <Grid container spacing={2}>
                {filteredAndSorted.map((stream) => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={stream.streamId}>
                    <StreamCard
                      stream={stream}
                      token={token}
                      onStopped={handleStopped}
                      onOpenSegments={setSelectedStreamId}
                    />
                  </Grid>
                ))}
              </Grid>
            );
          }
          if (mode === 'list') {
            return (
              <StreamsListMobile
                streams={filteredAndSorted}
                token={token}
                onStopped={handleStopped}
                onOpenSegments={setSelectedStreamId}
              />
            );
          }
          return (
            <StreamsTable
              streams={filteredAndSorted}
              token={token}
              onStopped={handleStopped}
              onOpenSegments={setSelectedStreamId}
            />
          );
        }}
        isMobile={isMobile}
      />

      <SegmentActivityDialog
        open={selectedStream !== null}
        onClose={() => setSelectedStreamId(null)}
        title={selectedStream?.title || selectedStream?.youtubeId || ''}
        segments={selectedStream?.segments ?? null}
      />
    </>
  );
}

export default StreamingPage;
