import React, { useCallback, useMemo, useState } from 'react';
import { Typography } from '../ui';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useActiveStreams, StreamSnapshot } from '../../hooks/useActiveStreams';
import { VideoListContainer, useVideoListState, type SortConfig } from '../shared/VideoList';
import StreamsTable from './components/StreamsTable';

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
  const listState = useVideoListState({ initialViewMode: 'table' });
  const { streams, loading, refetch } = useActiveStreams(token);
  const [sortKey, setSortKey] = useState<SortKey>('startedAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

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
    <VideoListContainer<string>
      state={listState}
      viewModes={['table']}
      sort={sort}
      searchPlaceholder="Search by video, IP, or client..."
      headerSlot={headerSlot}
      itemCount={filteredAndSorted.length}
      isLoading={loading}
      isError={false}
      renderContent={() => (
        <StreamsTable streams={filteredAndSorted} token={token} onStopped={handleStopped} />
      )}
      isMobile={isMobile}
    />
  );
}

export default StreamingPage;
