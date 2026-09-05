import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
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
  Checkbox,
  Box,
  Button,
  IconButton,
  Tooltip,
} from '../../ui';
import { NzbCachedEntry } from '../../../hooks/useNzbStats';
import { formatCountdown, formatRelativeTime } from '../utils';

interface NzbCachedQueriesTableProps {
  entries: NzbCachedEntry[];
  onDelete: (keys: string[]) => Promise<void>;
}

function NzbCachedQueriesTable({ entries, onDelete }: NzbCachedQueriesTableProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);

  const allKeys = entries.map((e) => e.key);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.includes(k));
  const someSelected = !allSelected && allKeys.some((k) => selected.includes(k));

  const toggleOne = (key: string, checked: boolean) => {
    setSelected((prev) => (checked ? [...prev, key] : prev.filter((k) => k !== key)));
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? allKeys : []);
  };

  const handleDeleteSelected = async () => {
    if (selected.length === 0) return;
    setDeleting(true);
    try {
      await onDelete(selected);
      setSelected([]);
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteOne = async (key: string) => {
    setDeleting(true);
    try {
      await onDelete([key]);
      setSelected((prev) => prev.filter((k) => k !== key));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Paper style={{ overflow: 'hidden' }}>
      <Box className="flex items-center justify-between px-4 py-3 gap-2 flex-wrap">
        <Box>
          <Typography variant="subtitle1">Cached NZB Queries</Typography>
          <Typography variant="body2" color="textSecondary">
            Results reused for a repeat query instead of re-running yt-dlp. Select entries to force them to re-run.
          </Typography>
        </Box>
        {selected.length > 0 && (
          <Button
            variant="outlined"
            color="error"
            onClick={handleDeleteSelected}
            disabled={deleting}
            style={{ whiteSpace: 'nowrap' }}
          >
            <Trash2 size={16} style={{ marginRight: 6 }} />
            Delete {selected.length} selected
          </Button>
        )}
      </Box>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell style={{ width: 42 }}>
                <Checkbox
                  indeterminate={someSelected}
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  disabled={allKeys.length === 0}
                />
              </TableCell>
              <TableCell component="th">Query</TableCell>
              <TableCell component="th" style={{ width: 70 }}>Count</TableCell>
              <TableCell component="th" style={{ width: 110 }}>Source</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Results</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Cached</TableCell>
              <TableCell component="th" style={{ width: 100 }}>Expires in</TableCell>
              <TableCell component="th" style={{ width: 60 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>
                  <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                    Nothing cached right now - either caching is disabled (Settings, "Search result cache"), or nothing has been searched recently.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {entries.map((entry) => {
              const isSelected = selected.includes(entry.key);
              return (
                <TableRow hover key={entry.key} className={isSelected ? 'bg-primary/5' : undefined}>
                  <TableCell>
                    <Checkbox checked={isSelected} onChange={(e) => toggleOne(entry.key, e.target.checked)} />
                  </TableCell>
                  <TableCell style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.query || <em>(blank / RSS mode)</em>}
                  </TableCell>
                  <TableCell>{entry.count}</TableCell>
                  <TableCell>
                    <Chip size="small" label={entry.source} variant="outlined" />
                  </TableCell>
                  <TableCell>{entry.resultCount}</TableCell>
                  <TableCell>{formatRelativeTime(entry.cachedAt)}</TableCell>
                  <TableCell>{formatCountdown(entry.expiresInMs)}</TableCell>
                  <TableCell>
                    <Tooltip title="Delete cached entry">
                      <span>
                        <IconButton
                          size="small"
                          aria-label="Delete cached entry"
                          onClick={() => handleDeleteOne(entry.key)}
                          disabled={deleting}
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default NzbCachedQueriesTable;
