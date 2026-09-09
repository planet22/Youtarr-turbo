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
import { NzbSearchTrace } from '../../../hooks/useNzbStats';
import { formatRelativeTime } from '../utils';
import NzbSearchTraceDialog from './NzbSearchTraceDialog';
import { COMPACT_CHIP_STYLE } from './nzbMobileStyles';

interface NzbSearchTracesTableProps {
  traces: NzbSearchTrace[];
}

function NzbSearchTracesMobileList({
  traces,
  onSelect,
}: {
  traces: NzbSearchTrace[];
  onSelect: (trace: NzbSearchTrace) => void;
}) {
  if (traces.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary" style={{ padding: '8px 16px 16px' }}>
        No searches recorded yet.
      </Typography>
    );
  }
  return (
    <Box style={{ maxHeight: 420, overflowY: 'auto' }}>
      {traces.map((trace, index) => {
        const keptCount = trace.items.filter((i) => i.kept).length;
        return (
          <Box key={`${trace.timestamp}-${index}`} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <Box style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <Typography
                variant="body2"
                className="font-semibold"
                style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
              >
                {/* newquery is what was actually sent to search (e.g. season/episode
                    appended for a tvsearch) - query alone is what Sonarr/Radarr
                    originally asked for, which can differ from what was used. */}
                {trace.newquery || trace.query}
              </Typography>
              <Button size="small" onClick={() => onSelect(trace)} style={{ flexShrink: 0 }}>View</Button>
            </Box>
            <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
              <Chip size="small" label={trace.categoryName} variant="outlined" style={COMPACT_CHIP_STYLE} />
              <Chip
                size="small"
                label={trace.additionalLocalFilterEnabled ? 'Filter: On' : 'Filter: Off'}
                variant="outlined"
                color={trace.additionalLocalFilterEnabled ? 'primary' : 'default'}
                style={COMPACT_CHIP_STYLE}
              />
              <Chip size="small" label={`Kept ${keptCount}/${trace.items.length}`} variant="outlined" style={COMPACT_CHIP_STYLE} />
            </Box>
            <Typography variant="caption" color="textSecondary" style={{ display: 'block', marginTop: 6 }}>
              {formatRelativeTime(trace.timestamp)}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

function NzbSearchTracesTable({ traces }: NzbSearchTracesTableProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
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
      {isMobile ? (
        <NzbSearchTracesMobileList traces={traces} onSelect={setSelected} />
      ) : (
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
      )}
      <NzbSearchTraceDialog trace={selected} onClose={() => setSelected(null)} />
    </Paper>
  );
}

export default NzbSearchTracesTable;
