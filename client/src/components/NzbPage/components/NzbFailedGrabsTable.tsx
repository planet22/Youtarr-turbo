import React from 'react';
import { Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, Box } from '../../ui';
import { NzbFailedGrab } from '../../../hooks/useNzbStats';
import { formatRelativeTime } from '../utils';

interface NzbFailedGrabsTableProps {
  grabs: NzbFailedGrab[];
}

// Surfaces grabs that "completed" with nothing to show for it (see
// resolveNzbJobOutcome in server/routes/nzb.js) - previously only visible as
// a server log line, and Sonarr/Radarr were never told it failed either
// (fixed alongside this: they now see status Failed, not Completed).
function NzbFailedGrabsTable({ grabs }: NzbFailedGrabsTableProps) {
  return (
    <Paper variant="outlined" style={{ overflow: 'hidden' }}>
      <Box className="px-4 py-3">
        <Typography variant="subtitle1">Failed Grabs</Typography>
        <Typography variant="body2" color="textSecondary">
          Grabs that produced no video file (age-restricted content, yt-dlp bot-check, network failure, etc.) -
          Sonarr/Radarr are now told these failed so they can retry with a different release.
        </Typography>
      </Box>
      <TableContainer style={{ maxHeight: 420, overflowY: 'auto' }}>
        <Table size="small">
          <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
            <TableRow>
              <TableCell component="th">File</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Category</TableCell>
              <TableCell component="th">Reason</TableCell>
              <TableCell component="th" style={{ width: 100 }}>When</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {grabs.length === 0 && (
              <TableRow>
                <TableCell colSpan={4}>
                  <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                    No failed grabs recorded.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {grabs.map((grab) => (
              <TableRow hover key={grab.jobId}>
                <TableCell style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {grab.nzbName || grab.youtubeId || grab.jobId}
                </TableCell>
                <TableCell>{grab.categoryName || '—'}</TableCell>
                <TableCell>
                  <Typography variant="caption" color="textSecondary">{grab.message}</Typography>
                </TableCell>
                <TableCell>{formatRelativeTime(grab.timestamp)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default NzbFailedGrabsTable;
