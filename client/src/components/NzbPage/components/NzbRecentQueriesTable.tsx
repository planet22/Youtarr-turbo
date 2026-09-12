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
} from '../../ui';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { NzbRecentQuery, NzbSearchTrace } from '../../../hooks/useNzbStats';
import { formatDurationMs, formatRelativeTime } from '../utils';
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
      <TableContainer style={{ maxHeight: 420, overflowY: 'auto' }}>
        <Table size="small">
          <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
            <TableRow>
              <TableCell style={{ width: 42 }} />
              <TableCell component="th">Query</TableCell>
              <TableCell component="th" style={{ width: 70 }}>Count</TableCell>
              <TableCell component="th" style={{ width: 140 }}>Source</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Results</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Cache</TableCell>
              <TableCell component="th" style={{ width: 100 }}>When</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Duration</TableCell>
              <TableCell component="th" style={{ width: 60 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {queries.length === 0 && (
              <TableRow>
                <TableCell colSpan={9}>
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
                <TableCell style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.query || <em>(blank / RSS mode)</em>}
                </TableCell>
                <TableCell>{q.count}</TableCell>
                <TableCell>
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
                <TableCell>{formatRelativeTime(q.timestamp)}</TableCell>
                <TableCell>{formatDurationMs(q.durationMs)}</TableCell>
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
