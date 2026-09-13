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
  Checkbox,
  Chip,
  Box,
  Button,
  IconButton,
  Tooltip,
} from '../../ui';
import { useMediaQuery } from '../../../hooks/useMediaQuery';
import { NzbCachedEntry } from '../../../hooks/useNzbStats';
import { formatCountdown, formatRelativeTime } from '../utils';
import NzbSettingsIcons from './NzbSettingsIcons';
import { COMPACT_CHIP_STYLE } from './nzbMobileStyles';

interface NzbCachedQueriesTableProps {
  entries: NzbCachedEntry[];
  onDelete: (keys: string[]) => Promise<void>;
}

function NzbCachedQueriesMobileList({
  entries,
  selected,
  deleting,
  onToggleOne,
  onDeleteOne,
}: {
  entries: NzbCachedEntry[];
  selected: string[];
  deleting: boolean;
  onToggleOne: (key: string, checked: boolean) => void;
  onDeleteOne: (key: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="textSecondary" style={{ padding: '8px 16px 16px' }}>
        Nothing cached right now - either caching is disabled (Settings, "Search result cache"), or nothing has been searched recently.
      </Typography>
    );
  }
  return (
    <Box style={{ maxHeight: 420, overflowY: 'auto' }}>
      {entries.map((entry) => {
        const isSelected = selected.includes(entry.key);
        return (
          <Box
            key={entry.key}
            style={{
              display: 'flex',
              gap: 8,
              padding: '10px 16px',
              borderBottom: '1px solid var(--border)',
              backgroundColor: isSelected ? 'var(--muted)' : undefined,
            }}
          >
            <Checkbox
              checked={isSelected}
              onChange={(e) => onToggleOne(entry.key, e.target.checked)}
              style={{ padding: 4, marginTop: -4, flexShrink: 0 }}
            />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                <Typography
                  variant="body2"
                  className="font-semibold"
                  style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                >
                  {entry.query || <em>(blank / RSS mode)</em>}
                </Typography>
                <Tooltip title="Delete cached entry">
                  <span>
                    <IconButton
                      size="small"
                      aria-label="Delete cached entry"
                      onClick={() => onDeleteOne(entry.key)}
                      disabled={deleting}
                      style={{ flexShrink: 0 }}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
              <Box style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                <Chip size="small" label={`Count: ${entry.count}`} variant="outlined" style={COMPACT_CHIP_STYLE} />
                <Chip size="small" label={`Results: ${entry.resultCount}`} variant="outlined" style={COMPACT_CHIP_STYLE} />
                <Chip size="small" label={`Expires: ${formatCountdown(entry.expiresInMs)}`} variant="outlined" style={COMPACT_CHIP_STYLE} />
              </Box>
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 }}>
                <NzbSettingsIcons settings={entry.settingsSnapshot} />
                <Typography variant="caption" color="textSecondary" style={{ whiteSpace: 'nowrap' }}>
                  Cached {formatRelativeTime(entry.cachedAt)}
                </Typography>
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// Column widths/order are shared with NzbRecentQueriesTable - a cached entry
// is just the current state of the search-result cache, not a past request,
// so it has no per-search duration or resolution timing/count; the two
// blank columns after Expires in (width 68, width 112) exist purely to keep
// the delete action lined up with that table's Search/Resolution columns.
// tableLayout: 'fixed' is load-bearing here too - see NzbRecentQueriesTable's
// own comment for why "auto" layout would let these two tables drift apart.
// Same reasoning for this TableContainer's overflowY: 'scroll' (always
// reserves scrollbar space) instead of 'auto' - this table is often empty
// or short while NzbRecentQueriesTable usually has enough rows to need a
// scrollbar; without both reserving the gutter unconditionally, whichever
// table lacks a scrollbar gets ~15-17px more room that its unsized Query
// column silently absorbs, throwing every later column out of alignment.
function NzbCachedQueriesTable({ entries, onDelete }: NzbCachedQueriesTableProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');
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
    <Paper variant="outlined" style={{ overflow: 'hidden' }}>
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
      {isMobile ? (
        <NzbCachedQueriesMobileList
          entries={entries}
          selected={selected}
          deleting={deleting}
          onToggleOne={toggleOne}
          onDeleteOne={handleDeleteOne}
        />
      ) : (
      <TableContainer style={{ maxHeight: 420, overflowY: 'scroll' }}>
        <Table size="small" style={{ tableLayout: 'fixed' }}>
          <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
            <TableRow>
              <TableCell style={{ width: 40 }}>
                <Checkbox
                  indeterminate={someSelected}
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  disabled={allKeys.length === 0}
                />
              </TableCell>
              <TableCell component="th">Query</TableCell>
              <TableCell component="th" style={{ width: 56 }}>Count</TableCell>
              <TableCell component="th" style={{ width: 128 }}>Source</TableCell>
              <TableCell component="th" style={{ width: 56 }}>Results</TableCell>
              <TableCell component="th" style={{ width: 72 }}>Cached</TableCell>
              <TableCell component="th" style={{ width: 92, whiteSpace: 'nowrap' }}>Expires in</TableCell>
              <TableCell style={{ width: 68 }} />
              <TableCell style={{ width: 112 }} />
              <TableCell component="th" style={{ width: 64 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={10}>
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
                  <TableCell style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.query || <em>(blank / RSS mode)</em>}
                  </TableCell>
                  <TableCell>{entry.count}</TableCell>
                  <TableCell style={{ overflow: 'hidden' }}>
                    <NzbSettingsIcons settings={entry.settingsSnapshot} />
                  </TableCell>
                  <TableCell>{entry.resultCount}</TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>{formatRelativeTime(entry.cachedAt)}</TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>{formatCountdown(entry.expiresInMs)}</TableCell>
                  <TableCell />
                  <TableCell />
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
      )}
    </Paper>
  );
}

export default NzbCachedQueriesTable;
