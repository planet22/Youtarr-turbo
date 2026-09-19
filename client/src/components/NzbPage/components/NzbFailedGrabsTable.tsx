import React, { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import {
  Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, Chip, Box, Button,
  Dialog, DialogTitle, DialogContent, DialogActions,
} from '../../ui';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { NzbFailedGrab } from '../../../hooks/useNzbStats';
import { formatRelativeTime } from '../utils';
import { COMPACT_CHIP_STYLE } from './nzbMobileStyles';

// Opens Download History narrowed to this grab's job (see DownloadHistory's
// jobIdFilter). The job may have aged out of history, in which case that page
// shows its normal empty state.
function GrabLink({ grab }: { grab: NzbFailedGrab }) {
  return (
    <RouterLink
      to={`/downloads/history?job=${encodeURIComponent(grab.jobId)}`}
      className="underline-offset-2 hover:underline"
    >
      {grab.nzbName || grab.youtubeId || grab.jobId}
    </RouterLink>
  );
}

interface NzbFailedGrabsTableProps {
  grabs: NzbFailedGrab[];
  onDeleteAll: () => Promise<void>;
}

function NzbFailedGrabsMobileList({ grabs }: { grabs: NzbFailedGrab[] }) {
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
              <GrabLink grab={grab} />
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
function NzbFailedGrabsTable({ grabs: unsortedGrabs, onDeleteAll }: NzbFailedGrabsTableProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Newest first by when the grab failed. The server returns rows in
  // insertion order, which can differ (a poll may record an older job later).
  const grabs = useMemo(
    () => [...unsortedGrabs].sort((a, b) => b.timestamp - a.timestamp),
    [unsortedGrabs]
  );

  const handleDeleteAll = async () => {
    setDeleting(true);
    try {
      await onDeleteAll();
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Paper variant="outlined" style={{ overflow: 'hidden' }}>
      <Box className="flex items-center justify-between px-4 py-3 gap-2 flex-wrap">
        <Box>
          <Typography variant="subtitle1">Failed Grabs</Typography>
          <Typography variant="body2" color="textSecondary">
            Grabs that produced no video file (age-restricted content, yt-dlp bot-check, network failure, etc.) -
            Sonarr/Radarr are now told these failed so they can retry with a different release.
          </Typography>
        </Box>
        {grabs.length > 0 && (
          <Button
            variant="outlined"
            color="error"
            onClick={() => setConfirmOpen(true)}
            disabled={deleting}
            style={{ whiteSpace: 'nowrap' }}
          >
            <Trash2 size={16} style={{ marginRight: 6 }} />
            Delete all
          </Button>
        )}
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
                  <GrabLink grab={grab} />
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
      <Dialog open={confirmOpen} onClose={() => !deleting && setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Delete all failed grabs?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This permanently removes {grabs.length} failed grab {grabs.length === 1 ? 'entry' : 'entries'} from this
            log. It doesn&apos;t affect Sonarr/Radarr or Download History.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={deleting} variant="contained" color="primary" autoFocus>
            Cancel
          </Button>
          <Button onClick={handleDeleteAll} disabled={deleting} variant="outlined" color="error">
            <Trash2 size={16} style={{ marginRight: 6 }} />
            Delete all
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

export default NzbFailedGrabsTable;
