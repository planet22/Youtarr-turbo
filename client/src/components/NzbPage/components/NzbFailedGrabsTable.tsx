import React from 'react';
import { Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, Chip, Box } from '../../ui';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { NzbFailedGrab } from '../../../hooks/useNzbStats';
import { formatRelativeTime } from '../utils';
import { COMPACT_CHIP_STYLE } from './nzbMobileStyles';

interface NzbFailedGrabsTableProps {
  grabs: NzbFailedGrab[];
}

function NzbFailedGrabsMobileList({ grabs }: NzbFailedGrabsTableProps) {
  if (grabs.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary" style={{ padding: '8px 16px 16px' }}>
        No failed grabs recorded.
      </Typography>
    );
  }
  return (
    <Box style={{ maxHeight: 420, overflowY: 'auto' }}>
      {grabs.map((grab) => (
        <Box key={grab.jobId} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
          <Box style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <Typography
              variant="body2"
              className="font-semibold"
              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {grab.nzbName || grab.youtubeId || grab.jobId}
            </Typography>
            <Typography variant="caption" color="textSecondary" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
              {formatRelativeTime(grab.timestamp)}
            </Typography>
          </Box>
          {grab.categoryName && (
            <Chip size="small" label={grab.categoryName} variant="outlined" style={{ ...COMPACT_CHIP_STYLE, marginTop: 4 }} />
          )}
          <Typography variant="caption" color="textSecondary" style={{ display: 'block', marginTop: 4 }}>
            {grab.message}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

// Surfaces grabs that "completed" with nothing to show for it (see
// resolveNzbJobOutcome in server/routes/nzb.js) - previously only visible as
// a server log line, and Sonarr/Radarr were never told it failed either
// (fixed alongside this: they now see status Failed, not Completed).
function NzbFailedGrabsTable({ grabs }: NzbFailedGrabsTableProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');

  return (
    <Paper variant="outlined" style={{ overflow: 'hidden' }}>
      <Box className="px-4 py-3">
        <Typography variant="subtitle1">Failed Grabs</Typography>
        <Typography variant="body2" color="textSecondary">
          Grabs that produced no video file (age-restricted content, yt-dlp bot-check, network failure, etc.) -
          Sonarr/Radarr are now told these failed so they can retry with a different release.
        </Typography>
      </Box>
      {isMobile ? (
        <NzbFailedGrabsMobileList grabs={grabs} />
      ) : (
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
      )}
    </Paper>
  );
}

export default NzbFailedGrabsTable;
