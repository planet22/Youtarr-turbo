import React, { useState } from 'react';
import { Box, Typography } from '../ui';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useStreamHistory } from '../../hooks/useStreamHistory';
import PageControls from '../shared/PageControls';
import StreamHistoryTable from './components/StreamHistoryTable';

interface StreamHistoryPageProps {
  token: string | null;
}

const PAGE_SIZE = 25;

/**
 * Settings → Streaming → History (nav sub-item, see AppShell.tsx's
 * `streamingSubItems`) - a persisted audit trail of past playback sessions
 * (server/models/streamhistory.js), separate from the live "Streaming" page
 * (StreamingPage/index.tsx), which only shows what's currently active and
 * loses everything once a stream ends or the server restarts.
 */
function StreamHistoryPage({ token }: StreamHistoryPageProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [page, setPage] = useState(1);
  const { rows, total, loading } = useStreamHistory(token, page, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Box style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Typography variant={isMobile ? 'h6' : 'h5'} align="center">
        Stream History ({total} session{total === 1 ? '' : 's'})
      </Typography>

      {loading && rows.length === 0 ? (
        <Typography variant="body2" align="center" color="textSecondary">
          Loading...
        </Typography>
      ) : rows.length === 0 ? (
        <Typography variant="body2" align="center" color="textSecondary">
          No streaming activity yet.
        </Typography>
      ) : (
        <>
          <StreamHistoryTable rows={rows} />
          <PageControls page={page} totalPages={totalPages} onPageChange={setPage} compact={isMobile} />
        </>
      )}
    </Box>
  );
}

export default StreamHistoryPage;
