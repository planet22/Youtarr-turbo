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
import { formatBackendSource, formatDurationMs, formatRelativeTime } from '../utils';

interface NzbRecentQueriesTableProps {
  queries: NzbRecentQuery[];
}

function NzbRecentQueriesTable({ queries }: NzbRecentQueriesTableProps) {
  return (
    <Paper style={{ overflow: 'hidden' }}>
      <Box className="px-4 py-3">
        <Typography variant="subtitle1">Recent NZB Queries</Typography>
        <Typography variant="body2" color="textSecondary">
          The last {queries.length} searches Sonarr/Radarr/Prowlarr sent through the Newznab endpoint.
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell component="th">Query</TableCell>
              <TableCell component="th" style={{ width: 70 }}>Count</TableCell>
              <TableCell component="th" style={{ width: 130 }}>Source</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Cache</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Results</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Duration</TableCell>
              <TableCell component="th" style={{ width: 100 }}>When</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {queries.length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                    No NZB queries yet - once Sonarr, Radarr, or Prowlarr search Youtarr, they'll show up here.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {queries.map((q, index) => (
              <TableRow hover key={`${q.timestamp}-${index}`}>
                <TableCell style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.query || <em>(blank / RSS mode)</em>}
                </TableCell>
                <TableCell>{q.count}</TableCell>
                <TableCell>
                  <Chip size="small" label={formatBackendSource(q.source)} variant="outlined" />
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={q.cacheHit ? 'Hit' : 'Miss'}
                    color={q.cacheHit ? 'success' : 'default'}
                    variant="filled"
                  />
                </TableCell>
                <TableCell>{q.resultCount}</TableCell>
                <TableCell>{formatDurationMs(q.durationMs)}</TableCell>
                <TableCell>{formatRelativeTime(q.timestamp)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default NzbRecentQueriesTable;
