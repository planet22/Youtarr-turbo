import React, { useState } from 'react';
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  Chip,
  Button,
  Box,
  Tooltip,
} from '../../ui';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { NzbRecentQuery, NzbSearchTrace } from '../../../hooks/useNzbStats';
import { formatDurationMs, formatRelativeTime, formatResolutionBreakdown, formatResolutionStats } from '../utils';
import NzbSettingsIcons from './NzbSettingsIcons';
import NzbSearchTraceDialog from './NzbSearchTraceDialog';
import { COMPACT_CHIP_STYLE } from './nzbMobileStyles';

interface NzbRecentQueriesTableProps {
  queries: NzbRecentQuery[];
  // Used to look up the matching search trace (same searchId) for the
  // "View" link - see recordSearchTrace/recordNzbQuery on the server for
  // where the two get tagged with the same id.
  traces: NzbSearchTrace[];
}

interface NzbRecentQueriesListProps {
  queries: NzbRecentQuery[];
  onSelect: (trace: NzbSearchTrace) => void;
  findTrace: (searchId: string | undefined) => NzbSearchTrace | undefined;
}

function NzbRecentQueriesMobileList({ queries, onSelect, findTrace }: NzbRecentQueriesListProps) {
  if (queries.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary" style={{ padding: '8px 16px 16px' }}>
        No NZB queries yet - once Sonarr, Radarr, or Prowlarr search Youtarr-Turbo, they'll show up here.
      </Typography>
    );
  }
  return (
    <Box style={{ maxHeight: 420, overflowY: 'auto' }}>
      {queries.map((q, index) => {
        const trace = findTrace(q.searchId);
        return (
        <Box
          key={`${q.timestamp}-${index}`}
          style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}
        >
          <Box style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <Typography
              variant="body2"
              className="font-semibold"
              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {q.query || <em>(blank / RSS mode)</em>}
            </Typography>
            {trace && (
              <Button size="small" onClick={() => onSelect(trace)} style={{ flexShrink: 0 }}>View</Button>
            )}
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            <Chip size="small" label={`Count: ${q.count}`} variant="outlined" style={COMPACT_CHIP_STYLE} />
            <Chip size="small" label={`Results: ${q.resultCount}`} variant="outlined" style={COMPACT_CHIP_STYLE} />
            <Chip
              size="small"
              label={q.cacheHit ? 'Hit' : 'Miss'}
              color={q.cacheHit ? 'success' : 'default'}
              variant="filled"
              style={COMPACT_CHIP_STYLE}
            />
            {(() => {
              const chip = (
                <Chip
                  size="small"
                  label={`Resolution: ${formatResolutionStats(trace?.resolutionMs, trace?.resolutionQueryCount)}`}
                  variant="outlined"
                  style={COMPACT_CHIP_STYLE}
                />
              );
              const breakdown = formatResolutionBreakdown(trace?.items);
              return breakdown ? <Tooltip title={breakdown}><span>{chip}</span></Tooltip> : chip;
            })()}
          </Box>
          <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
            <NzbSettingsIcons settings={q.settingsSnapshot} />
            <Typography variant="caption" color="textSecondary" style={{ whiteSpace: 'nowrap' }}>
              {formatRelativeTime(q.timestamp)} · {formatDurationMs(q.durationMs)}
            </Typography>
          </Box>
        </Box>
        );
      })}
    </Box>
  );
}

// Column widths/order are shared with NzbCachedQueriesTable (see its own
// comment) - the first (checkbox) column doesn't apply here, so it's
// rendered blank rather than omitted, keeping every column position lined
// up between the two stacked tables. The last column reuses that same
// width for a "View" link into the matching search trace, when one exists.
// Resolution is this table's one extra column (applyResolutionDetection's
// own timing/count, only known via the matching trace - see
// formatResolutionStats) - NzbCachedQueriesTable adds a same-width blank
// column of its own to keep every column after it lined up too.
//
// tableLayout: 'fixed' on both tables is load-bearing, not cosmetic: with
// the browser's default "auto" table layout, a column's rendered width is
// driven by its own content, not the `width` set here - so this table's
// blank leading column (genuinely empty in every row) would collapse below
// NzbCachedQueriesTable's real Checkbox in the same slot, throwing every
// later column out of alignment between the two stacked tables. Fixed
// layout makes the header row's widths authoritative instead.
//
// The TableContainer below also always reserves scrollbar space
// (overflowY: 'scroll', not 'auto') for the same reason: this table
// typically has enough rows to need its own scrollbar while
// NzbCachedQueriesTable often doesn't (it's usually empty or has a
// handful of entries) - a scrollbar eats ~15-17px of width from whichever
// table has one, and with only Query left unsized, that table's Query
// column silently absorbs the difference, shifting every column after it
// out of alignment with the other table. Reserving the gutter always
// keeps both tables' available width identical regardless of row count.
function NzbRecentQueriesTable({ queries, traces }: NzbRecentQueriesTableProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [selected, setSelected] = useState<NzbSearchTrace | null>(null);
  const findTrace = (searchId: string | undefined) =>
    searchId ? traces.find((t) => t.searchId === searchId) : undefined;

  return (
    <Paper variant="outlined" style={{ overflow: 'hidden' }}>
      <Box className="px-4 py-3">
        <Typography variant="subtitle1">Recent NZB Queries</Typography>
        <Typography variant="body2" color="textSecondary">
          The last {queries.length} searches Sonarr/Radarr/Prowlarr sent through the Newznab endpoint.
        </Typography>
      </Box>
      {isMobile ? (
        <NzbRecentQueriesMobileList queries={queries} onSelect={setSelected} findTrace={findTrace} />
      ) : (
      <TableContainer style={{ maxHeight: 420, overflowY: 'scroll' }}>
        <Table size="small" style={{ tableLayout: 'fixed' }}>
          <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
            <TableRow>
              <TableCell style={{ width: 40 }} />
              <TableCell component="th">Query</TableCell>
              <TableCell component="th" style={{ width: 56 }}>Count</TableCell>
              <TableCell component="th" style={{ width: 128 }}>Source</TableCell>
              <TableCell component="th" style={{ width: 56 }}>Results</TableCell>
              <TableCell component="th" style={{ width: 72 }}>Cache</TableCell>
              <TableCell component="th" style={{ width: 92, whiteSpace: 'nowrap' }}>When</TableCell>
              <TableCell component="th" style={{ width: 68, whiteSpace: 'nowrap' }}>
                <Tooltip title="How long the underlying yt-dlp/API search fetch took (cache hit or a real fetch) - not including resolution detection below">
                  <span>Search</span>
                </Tooltip>
              </TableCell>
              <TableCell component="th" style={{ width: 112, whiteSpace: 'nowrap' }}>
                <Tooltip title="How long applyResolutionDetection took for this search, and how many items needed a resolution lookup - a separate step that runs after the search above completes">
                  <span>Resolution</span>
                </Tooltip>
              </TableCell>
              <TableCell component="th" style={{ width: 64 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {queries.length === 0 && (
              <TableRow>
                <TableCell colSpan={10}>
                  <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                    No NZB queries yet - once Sonarr, Radarr, or Prowlarr search Youtarr-Turbo, they'll show up here.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {queries.map((q, index) => {
              const trace = findTrace(q.searchId);
              return (
              <TableRow hover key={`${q.timestamp}-${index}`}>
                <TableCell />
                <TableCell style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.query || <em>(blank / RSS mode)</em>}
                </TableCell>
                <TableCell>{q.count}</TableCell>
                <TableCell style={{ overflow: 'hidden' }}>
                  <NzbSettingsIcons settings={q.settingsSnapshot} />
                </TableCell>
                <TableCell>{q.resultCount}</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={q.cacheHit ? 'Hit' : 'Miss'}
                    color={q.cacheHit ? 'success' : 'default'}
                    variant="filled"
                  />
                </TableCell>
                <TableCell style={{ whiteSpace: 'nowrap' }}>{formatRelativeTime(q.timestamp)}</TableCell>
                <TableCell style={{ whiteSpace: 'nowrap' }}>{formatDurationMs(q.durationMs)}</TableCell>
                <TableCell style={{ whiteSpace: 'nowrap' }}>
                  {(() => {
                    const text = formatResolutionStats(trace?.resolutionMs, trace?.resolutionQueryCount);
                    const breakdown = formatResolutionBreakdown(trace?.items);
                    return breakdown ? <Tooltip title={breakdown}><span>{text}</span></Tooltip> : text;
                  })()}
                </TableCell>
                <TableCell>
                  {trace && <Button size="small" onClick={() => setSelected(trace)}>View</Button>}
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      )}
      <NzbSearchTraceDialog trace={selected} onClose={() => setSelected(null)} />
    </Paper>
  );
}

export default NzbRecentQueriesTable;
