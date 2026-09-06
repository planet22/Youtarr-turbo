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
import { NzbSearchTrace } from '../../../hooks/useNzbStats';
import { formatRelativeTime } from '../utils';
import NzbSearchTraceDialog from './NzbSearchTraceDialog';

interface NzbSearchTracesTableProps {
  traces: NzbSearchTrace[];
}

function NzbSearchTracesTable({ traces }: NzbSearchTracesTableProps) {
  const [selected, setSelected] = useState<NzbSearchTrace | null>(null);

  return (
    <Paper variant="outlined" style={{ overflow: 'hidden' }}>
      <Box className="px-4 py-3">
        <Typography variant="subtitle1">Search Detail / Debug</Typography>
        <Typography variant="body2" color="textSecondary">
          Every candidate result for a recent search, and why the local filter kept or rejected each one. Click
          "View" to see the full breakdown.
        </Typography>
      </Box>
      <TableContainer style={{ maxHeight: 420, overflowY: 'auto' }}>
        <Table size="small">
          <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
            <TableRow>
              <TableCell component="th">Category</TableCell>
              <TableCell component="th">Query</TableCell>
              <TableCell component="th" style={{ width: 110 }}>Filter</TableCell>
              <TableCell component="th" style={{ width: 110 }}>Kept</TableCell>
              <TableCell component="th" style={{ width: 100 }}>When</TableCell>
              <TableCell component="th" style={{ width: 80 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {traces.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                    No searches recorded yet.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {traces.map((trace, index) => {
              const keptCount = trace.items.filter((i) => i.kept).length;
              return (
                <TableRow hover key={`${trace.timestamp}-${index}`}>
                  <TableCell>{trace.categoryName}</TableCell>
                  <TableCell style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {/* newquery is what was actually sent to search (e.g. season/episode
                        appended for a tvsearch) - query alone is what Sonarr/Radarr
                        originally asked for, which can differ from what was used. */}
                    {trace.newquery || trace.query}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={trace.additionalLocalFilterEnabled ? 'On' : 'Off'}
                      variant="outlined"
                      color={trace.additionalLocalFilterEnabled ? 'primary' : 'default'}
                    />
                  </TableCell>
                  <TableCell>{keptCount} / {trace.items.length}</TableCell>
                  <TableCell>{formatRelativeTime(trace.timestamp)}</TableCell>
                  <TableCell>
                    <Button size="small" onClick={() => setSelected(trace)}>View</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <NzbSearchTraceDialog trace={selected} onClose={() => setSelected(null)} />
    </Paper>
  );
}

export default NzbSearchTracesTable;
