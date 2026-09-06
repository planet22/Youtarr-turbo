import React, { useState } from 'react';
import { Square } from 'lucide-react';
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
  Grid,
} from '../../ui';
import { NzbJobsSnapshot } from '../../../hooks/useNzbStats';
import { formatByteSize } from '../../../utils/formatters';

interface NzbJobsSectionProps {
  jobs: NzbJobsSnapshot | null;
  onCancelCurrentJob: () => Promise<void>;
}

function formatEta(etaSeconds: number): string {
  if (!etaSeconds) return '—';
  const minutes = Math.floor(etaSeconds / 60);
  const seconds = Math.round(etaSeconds % 60);
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

// Read-only, NZB-filtered view of the same jobs the Download Activity/
// History pages already show - a lens for "what did Sonarr/Radarr trigger,"
// not a replacement for full job management. The only control offered is
// canceling whichever job is currently actively downloading (the same
// action available from Download Activity), since that's the one job-level
// action that's safe and unambiguous to expose here.
function NzbJobsSection({ jobs, onCancelCurrentJob }: NzbJobsSectionProps) {
  const [canceling, setCanceling] = useState(false);
  const active = jobs?.active ?? [];
  const history = jobs?.history ?? [];

  const handleCancel = async () => {
    setCanceling(true);
    try {
      await onCancelCurrentJob();
    } finally {
      setCanceling(false);
    }
  };

  return (
    <Grid container spacing={2}>
      <Grid item xs={12} md={6}>
        <Paper variant="outlined" style={{ overflow: 'hidden', height: '100%' }}>
          <Box className="px-4 py-3">
            <Typography variant="subtitle1">NZB Queue</Typography>
            <Typography variant="body2" color="textSecondary">
              Jobs Sonarr/Radarr have grabbed that are queued or actively downloading right now.
            </Typography>
          </Box>
          <TableContainer style={{ maxHeight: 420, overflowY: 'auto' }}>
            <Table size="small">
              <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
                <TableRow>
                  <TableCell component="th">File</TableCell>
                  <TableCell component="th" style={{ width: 90 }}>Category</TableCell>
                  <TableCell component="th" style={{ width: 110 }}>Status</TableCell>
                  <TableCell component="th" style={{ width: 90 }}>ETA</TableCell>
                  <TableCell component="th" style={{ width: 60 }} />
                </TableRow>
              </TableHead>
              <TableBody>
                {active.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5}>
                      <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                        Nothing queued right now.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {active.map((job) => (
                  <TableRow hover key={job.jobId}>
                    <TableCell style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.nzbName || job.jobId}
                    </TableCell>
                    <TableCell>{job.categoryName || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={job.isCurrent ? `${job.status} ${job.percent}%` : job.status}
                        color={job.status === 'Downloading' ? 'primary' : 'default'}
                        variant="filled"
                      />
                    </TableCell>
                    <TableCell>{job.isCurrent ? formatEta(job.etaSeconds) : '—'}</TableCell>
                    <TableCell>
                      {job.isCurrent && (
                        <Button size="small" color="error" onClick={handleCancel} disabled={canceling}>
                          <Square size={14} style={{ marginRight: 4 }} />
                          Cancel
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      </Grid>
      <Grid item xs={12} md={6}>
        <Paper variant="outlined" style={{ overflow: 'hidden', height: '100%' }}>
          <Box className="px-4 py-3">
            <Typography variant="subtitle1">NZB History</Typography>
            <Typography variant="body2" color="textSecondary">
              Recently finished grabs, until Sonarr/Radarr remove them from their own history.
            </Typography>
          </Box>
          <TableContainer style={{ maxHeight: 420, overflowY: 'auto' }}>
            <Table size="small">
              <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
                <TableRow>
                  <TableCell component="th">File</TableCell>
                  <TableCell component="th" style={{ width: 90 }}>Category</TableCell>
                  <TableCell component="th" style={{ width: 100 }}>Status</TableCell>
                  <TableCell component="th" style={{ width: 90 }}>Size</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {history.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4}>
                      <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                        Nothing in history yet.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {history.map((job) => (
                  <TableRow hover key={job.jobId}>
                    <TableCell style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.nzbName || job.jobId}
                    </TableCell>
                    <TableCell>{job.categoryName || '—'}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={job.status}
                        color={job.status === 'Failed' ? 'error' : 'success'}
                        variant="filled"
                      />
                    </TableCell>
                    <TableCell>{job.bytes ? formatByteSize(job.bytes) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      </Grid>
    </Grid>
  );
}

export default NzbJobsSection;
