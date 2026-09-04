import React, { useEffect, useState } from 'react';
import { Box, Typography, Button } from '../ui';
import { Trash2 as DeleteIcon } from '../../lib/icons';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useStreamHistory } from '../../hooks/useStreamHistory';
import { useListPageSize, VideoListPaginationBar, type PageSize } from '../shared/VideoList';
import StreamHistoryTable from './components/StreamHistoryTable';
import DeleteStreamHistoryDialog from './components/DeleteStreamHistoryDialog';

interface StreamHistoryPageProps {
  token: string | null;
}

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
  // Same shared page-size control/values (and localStorage persistence) as
  // the Videos/Library page - GET /api/ytstream/history's `limit` is capped
  // server-side at 128 to match ALLOWED_PAGE_SIZES' top value.
  const [pageSize, setPageSize] = useListPageSize('youtarr.streamHistoryPage.pageSize');
  const handlePageSizeChange = (newSize: PageSize) => {
    setPageSize(newSize);
    setPage(1);
  };
  const { rows, total, loading, refetch, deleteEntries } = useStreamHistory(token, page, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Selection is page-scoped, like the rest of this simple, non-VideoList page.
  useEffect(() => {
    setSelectedIds([]);
  }, [page, pageSize]);

  const handleToggleSelect = (streamId: string) => {
    setSelectedIds((prev) =>
      prev.includes(streamId) ? prev.filter((id) => id !== streamId) : [...prev, streamId]
    );
  };

  const handleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? rows.map((row) => row.streamId) : []);
  };

  const handleDeleteConfirm = async () => {
    setDeleteDialogOpen(false);
    const result = await deleteEntries(selectedIds);
    if (result.success) {
      setSelectedIds([]);
      refetch();
    }
  };

  return (
    <Box style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Typography variant={isMobile ? 'h6' : 'h5'} align="center">
          Stream History ({total} session{total === 1 ? '' : 's'})
        </Typography>
        {selectedIds.length > 0 && (
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<DeleteIcon size={14} />}
            onClick={() => setDeleteDialogOpen(true)}
          >
            Delete {selectedIds.length} selected
          </Button>
        )}
      </Box>

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
          <StreamHistoryTable
            rows={rows}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onSelectAll={handleSelectAll}
          />
          <VideoListPaginationBar
            placement="bottom"
            hasContent={rows.length > 0}
            useInfiniteScroll={false}
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={handlePageSizeChange}
            isMobile={isMobile}
          />
        </>
      )}

      <DeleteStreamHistoryDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
        entryCount={selectedIds.length}
      />
    </Box>
  );
}

export default StreamHistoryPage;
