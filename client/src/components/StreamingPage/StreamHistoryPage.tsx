import React, { useEffect, useMemo, useState } from 'react';
import { Box, Grid, Typography, Button } from '../ui';
import { Trash2 as DeleteIcon } from '../../lib/icons';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useStreamHistory } from '../../hooks/useStreamHistory';
import {
  useListPageSize,
  usePersistedFilterState,
  useVideoListState,
  VideoListContainer,
  VideoListPaginationBar,
  type FilterConfig,
  type PageSize,
  type VideoListViewMode,
} from '../shared/VideoList';
import StreamHistoryTable, { RESULT_CHIPS, STREAM_STATUS_OPTIONS } from './components/StreamHistoryTable';
import StreamHistoryCard from './components/StreamHistoryCard';
import StreamHistoryListMobile from './components/StreamHistoryListMobile';
import DeleteStreamHistoryDialog from './components/DeleteStreamHistoryDialog';
import { MODE_LABELS, STREAM_MODE_OPTIONS } from './utils';

// The Mode/Result filter dropdowns need to show the same friendly text as
// the table's own Mode chip / Result chip (formatModeLabel / resultChipFor),
// not the raw `mode`/`end_reason` database values the API actually filters
// by - these translate between the two in both directions. Module-level
// (not per-render) since they're derived purely from the static option
// lists/label maps imported above.
const MODE_LABEL_OPTIONS = STREAM_MODE_OPTIONS.map((value) => MODE_LABELS[value] || value);
const MODE_LABEL_TO_VALUE: Record<string, string> = Object.fromEntries(
  STREAM_MODE_OPTIONS.map((value) => [MODE_LABELS[value] || value, value])
);
const STATUS_LABEL_OF: Record<string, string> = { 'in-progress': 'In progress' };
for (const [value, chip] of Object.entries(RESULT_CHIPS)) STATUS_LABEL_OF[value] = chip.label;
const STATUS_LABEL_OPTIONS = STREAM_STATUS_OPTIONS.map((value) => STATUS_LABEL_OF[value] || value);
const STATUS_LABEL_TO_VALUE: Record<string, string> = Object.fromEntries(
  STREAM_STATUS_OPTIONS.map((value) => [STATUS_LABEL_OF[value] || value, value])
);

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
  // Same search box / filters button+badge / active-filter chips chrome as
  // the Videos and (live) Streaming pages, for a consistent filtering
  // experience across list-style pages. "list" (dense mobile rows) replaces
  // "table" on mobile, same split as VideosPage/StreamingPage.
  const listState = useVideoListState({
    initialViewMode: isMobile ? 'list' : 'table',
    searchStorageKey: 'youtarr:streamHistorySearch',
  });
  const [page, setPage] = useState(1);
  // Same shared page-size control/values (and localStorage persistence) as
  // the Videos/Library page - GET /api/ytstream/history's `limit` is capped
  // server-side at 128 to match ALLOWED_PAGE_SIZES' top value.
  const [pageSize, setPageSize] = useListPageSize('youtarr.streamHistoryPage.pageSize');
  const handlePageSizeChange = (newSize: PageSize) => {
    setPageSize(newSize);
    setPage(1);
  };

  // Persisted the same way as the search box above, so switching away from
  // this page and back (or reloading) doesn't quietly drop these filters
  // back to their defaults - see usePersistedFilterState.
  const [modeFilter, setModeFilter] = usePersistedFilterState('youtarr:streamHistory:filter:mode', '');
  const [statusFilter, setStatusFilter] = usePersistedFilterState('youtarr:streamHistory:filter:status', '');
  const [dateFrom, setDateFrom] = usePersistedFilterState('youtarr:streamHistory:filter:dateFrom', '');
  const [dateTo, setDateTo] = usePersistedFilterState('youtarr:streamHistory:filter:dateTo', '');
  const normalizedSearch = listState.search.trim();

  // Filters are applied server-side (see useStreamHistory/GET
  // /api/ytstream/history) since this page is server-paginated - a
  // client-side filter would only ever see whatever happens to already be
  // on the current page.
  const filters = useMemo(
    () => ({
      mode: modeFilter || undefined,
      status: statusFilter || undefined,
      search: normalizedSearch || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    [modeFilter, statusFilter, normalizedSearch, dateFrom, dateTo]
  );
  const hasActiveFilters = Boolean(modeFilter || statusFilter || dateFrom || dateTo);

  const { rows, total, loading, refetch, deleteEntries } = useStreamHistory(token, page, pageSize, filters);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Selection is page-scoped (own checkbox state, not VideoListContainer's
  // selection prop - this page keeps its existing simple delete flow rather
  // than adopting the shared multi-select pill).
  useEffect(() => {
    setSelectedIds([]);
  }, [page, pageSize]);

  // A filter change makes the previous page number meaningless against the
  // new, smaller/different result set - same reasoning as Download History.
  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeFilter, statusFilter, normalizedSearch, dateFrom, dateTo]);

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      {
        id: 'select',
        label: 'Mode',
        value: MODE_LABELS[modeFilter] || modeFilter,
        options: MODE_LABEL_OPTIONS,
        onChange: (label: string) => setModeFilter(MODE_LABEL_TO_VALUE[label] || ''),
      },
      // Labeled "Result" (not "Status") to match the table's own Result column.
      {
        id: 'select',
        label: 'Result',
        value: STATUS_LABEL_OF[statusFilter] || statusFilter,
        options: STATUS_LABEL_OPTIONS,
        onChange: (label: string) => setStatusFilter(STATUS_LABEL_TO_VALUE[label] || ''),
      },
      { id: 'dateRangeString', label: 'Started', dateFrom, dateTo, onFromChange: setDateFrom, onToChange: setDateTo },
    ],
    [modeFilter, statusFilter, dateFrom, dateTo]
  );

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

  const headerSlot = (
    <Box style={{ padding: '12px 16px 0 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
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
        filters={filterConfigs}
        searchPlaceholder="Search by video, IP, or client..."
        searchTooltip="Searches video title, YouTube ID, client IP address, and user agent."
        headerSlot={headerSlot}
        itemCount={rows.length}
        isLoading={loading}
        isError={false}
        customEmptyMessage={hasActiveFilters || normalizedSearch ? 'No sessions found matching your filters' : 'No streaming activity yet.'}
        renderContent={(mode) => {
          if (mode === 'grid') {
            return (
              <Grid container spacing={2}>
                {rows.map((row) => (
                  <Grid item xs={12} sm={6} md={4} lg={3} key={row.streamId}>
                    <StreamHistoryCard
                      row={row}
                      isSelected={selectedIds.includes(row.streamId)}
                      onToggleSelect={handleToggleSelect}
                    />
                  </Grid>
                ))}
              </Grid>
            );
          }
          if (mode === 'list') {
            return (
              <StreamHistoryListMobile
                rows={rows}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
              />
            );
          }
          return (
            <StreamHistoryTable
              rows={rows}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onSelectAll={handleSelectAll}
            />
          );
        }}
        pagination={
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
        }
        isMobile={isMobile}
      />

      <DeleteStreamHistoryDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={handleDeleteConfirm}
        entryCount={selectedIds.length}
      />
    </>
  );
}

export default StreamHistoryPage;
