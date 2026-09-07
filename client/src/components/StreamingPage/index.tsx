import React, { useCallback, useMemo, useState } from 'react';
import { Grid, Typography } from '../ui';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useActiveStreams, StreamSnapshot } from '../../hooks/useActiveStreams';
import { VideoListContainer, useVideoListState, type SortConfig, type VideoListViewMode } from '../shared/VideoList';
import StreamsTable from './components/StreamsTable';
import StreamCard from './components/StreamCard';
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

const VIEW_MODES: VideoListViewMode[] = ['grid', 'table'];

function StreamingPage({ token }: StreamingPageProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  // Grid is the default on mobile (same as the Videos/Library page); table
  // stays the desktop default. Both are always available on either size.
  const listState = useVideoListState({ initialViewMode: isMobile ? 'grid' : 'table' });
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

  return (
    <>
      <VideoListContainer<string>
        state={listState}
        viewModes={VIEW_MODES}
        sort={sort}
        searchPlaceholder="Search by video, IP, or client..."
        headerSlot={headerSlot}
        itemCount={filteredAndSorted.length}
        isLoading={loading}
        isError={false}
        renderContent={(mode) =>
          mode === 'grid' ? (
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
          ) : (
            <StreamsTable
              streams={filteredAndSorted}
              token={token}
              onStopped={handleStopped}
              onOpenSegments={setSelectedStreamId}
            />
          )
        }
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
