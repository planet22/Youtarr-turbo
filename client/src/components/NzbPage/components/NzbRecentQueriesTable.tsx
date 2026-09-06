import React from 'react';
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
  Box,
} from '../../ui';
import { NzbRecentQuery } from '../../../hooks/useNzbStats';
import { formatDurationMs, formatRelativeTime } from '../utils';
import NzbSettingsIcons from './NzbSettingsIcons';

interface NzbRecentQueriesTableProps {
  queries: NzbRecentQuery[];
}

// Column widths/order are shared with NzbCachedQueriesTable (see its own
// comment) - the first (checkbox) and last (delete) columns don't apply
// here, so they're rendered blank rather than omitted, keeping every column
// position lined up between the two stacked tables.
function NzbRecentQueriesTable({ queries }: NzbRecentQueriesTableProps) {
  return (
    <Paper variant="outlined" style={{ overflow: 'hidden' }}>
      <Box className="px-4 py-3">
        <Typography variant="subtitle1">Recent NZB Queries</Typography>
        <Typography variant="body2" color="textSecondary">
          The last {queries.length} searches Sonarr/Radarr/Prowlarr sent through the Newznab endpoint.
        </Typography>
      </Box>
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
                    No NZB queries yet - once Sonarr, Radarr, or Prowlarr search Youtarr, they'll show up here.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {queries.map((q, index) => (
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
                <TableCell />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default NzbRecentQueriesTable;
