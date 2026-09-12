import React from 'react';
import { Type, Ban, CalendarX } from 'lucide-react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Chip,
  Typography,
  Box,
  Tooltip,
} from '../../ui';
import { NzbFilterReason, NzbSearchTrace, NzbSearchTraceItem } from '../../../hooks/useNzbStats';
import HighlightedTitle from './HighlightedTitle';

interface NzbSearchTraceDialogProps {
  trace: NzbSearchTrace | null;
  onClose: () => void;
}

type ReasonGroup = 'keyword' | 'excluded-term' | 'episode-code';

// The specific sub-reasons (wrong-season/wrong-episode/no-episode-marker/
// episode-code) all boil down to the same top-level problem - a season/
// episode code mismatch - so they share one icon rather than each getting
// its own; the exact sub-reason is still spelled out in the row's tooltip
// (reasonMessage below), just not as a whole extra icon in an already
// narrow column.
const REASON_GROUP: Record<Exclude<NzbFilterReason, null>, ReasonGroup> = {
  keyword: 'keyword',
  'excluded-term': 'excluded-term',
  'wrong-season': 'episode-code',
  'wrong-episode': 'episode-code',
  'no-episode-marker': 'episode-code',
  'episode-code': 'episode-code',
};

const REASON_GROUP_ICON: Record<ReasonGroup, React.ReactNode> = {
  keyword: <Type size={16} />,
  'excluded-term': <Ban size={16} />,
  'episode-code': <CalendarX size={16} />,
};

const REASON_GROUP_LABEL: Record<ReasonGroup, string> = {
  keyword: 'Missing search keyword',
  'excluded-term': 'Matched an excluded term',
  'episode-code': 'Season/episode code problem',
};

// Short enough to sit next to the icon in a narrow column without wrapping
// - the full sentence (with the actual matched text/season/episode) is
// still in the tooltip via reasonMessage below.
const REASON_SHORT_LABEL: Record<Exclude<NzbFilterReason, null>, string> = {
  keyword: 'missing term',
  'excluded-term': 'excluded',
  'wrong-season': 'wrong season',
  'wrong-episode': 'wrong episode',
  'no-episode-marker': 'no episode #',
  'episode-code': 'no code',
};

// Highlighting only makes sense for reasons where matchedTerm is text that
// genuinely appears in the title (an excluded word, a wrong season/episode
// code) - 'keyword' carries the MISSING term (not present in the title, so
// there's nothing to point at) and the generic 'episode-code' bucket has no
// matchedTerm at all.
const HIGHLIGHTABLE_REASONS = new Set<NzbFilterReason>(['excluded-term', 'wrong-season', 'wrong-episode', 'no-episode-marker']);

function reasonMessage(item: NzbSearchTraceItem, trace: NzbSearchTrace): string {
  switch (item.reason) {
    case 'keyword':
      return `Missing search keyword: "${item.matchedTerm}"`;
    case 'excluded-term':
      return `Matched excluded term: "${item.matchedTerm}"`;
    case 'wrong-season':
      return `Wrong season - title has "${item.matchedTerm}", wanted season ${trace.season}`;
    case 'wrong-episode':
      return `Wrong episode - title has "${item.matchedTerm}", wanted S${trace.season}E${trace.ep}`;
    case 'no-episode-marker':
      return `Season matches ("${item.matchedTerm}") but no episode number was found`;
    case 'episode-code':
      return 'No season/episode code found in the title at all';
    default:
      return '';
  }
}

// Which nzb.resolutionDetection check produced a result's definition/
// effectiveHeightTier - shown in the resolution chip's tooltip so a capped
// (or uncapped) label's origin is legible without cross-referencing the
// settings page. See nzb.js's applyResolutionDetection.
const RESOLUTION_SOURCE_LABEL: Record<'fixed' | 'api' | 'thumb' | 'extract', string> = {
  fixed: 'a previous download’s known resolution',
  api: 'the YouTube Data API',
  thumb: 'a thumbnail check',
  extract: 'a real yt-dlp extraction',
};

// Per-item resolution cell, shown only for kept items - a rejected item was
// never labeled with any quality at all. `effectiveHeightTier` is only
// populated server-side for items that landed in this page's actual
// response (see nzb.js) - a kept item that fell outside the page (paginated
// away) has none, which is worth distinguishing from "genuinely unknown"
// (item.definition would also be null in both cases, so effectiveHeightTier
// presence is what's checked here).
function resolutionCell(item: NzbSearchTraceItem, trace: NzbSearchTrace): React.ReactNode {
  if (!item.kept) {
    return <Typography variant="caption" color="textSecondary">—</Typography>;
  }
  if (item.effectiveHeightTier == null) {
    return (
      <Tooltip title="Not part of this page's response, so its real resolution was never checked">
        <Typography variant="caption" color="textSecondary" style={{ whiteSpace: 'nowrap' }}>not probed</Typography>
      </Tooltip>
    );
  }
  const label = `${item.effectiveHeightTier}p`;
  const sourceText = item.resolutionSource ? RESOLUTION_SOURCE_LABEL[item.resolutionSource] : 'an unknown check';
  const capped = trace.configuredHeightTier != null && item.effectiveHeightTier < trace.configuredHeightTier;
  if (!capped) {
    return (
      <Tooltip title={`From ${sourceText}`}>
        <Chip size="small" variant="outlined" label={label} />
      </Tooltip>
    );
  }
  return (
    <Tooltip title={`Source isn't actually HD (from ${sourceText}) - capped down from the configured ${trace.configuredHeightTier}p`}>
      <Chip size="small" color="warning" variant="filled" label={label} />
    </Tooltip>
  );
}

type StatusSort = 'original' | 'kept' | 'rejected';

const STATUS_SORT_CYCLE: Record<StatusSort, StatusSort> = {
  original: 'kept',
  kept: 'rejected',
  rejected: 'original',
};

function NzbSearchTraceDialog({ trace, onClose }: NzbSearchTraceDialogProps) {
  const [statusSort, setStatusSort] = React.useState<StatusSort>('original');

  if (!trace) return null;

  const keptCount = trace.items.filter((i) => i.kept).length;
  const groupsInUse = new Set(
    trace.items.map((i) => i.reason).filter((r): r is Exclude<NzbFilterReason, null> => r !== null).map((r) => REASON_GROUP[r])
  );

  // newquery is what was actually sent to search (e.g. season/episode
  // appended for a tvsearch) - query alone is what Sonarr/Radarr originally
  // asked for, which can differ from what was actually used to search.
  const effectiveQuery = trace.newquery || trace.query;

  const sortedItems = trace.items.map((item, index) => ({ item, index }));
  if (statusSort !== 'original') {
    const first = statusSort === 'kept';
    sortedItems.sort((a, b) => {
      if (a.item.kept === b.item.kept) return a.index - b.index;
      return a.item.kept === first ? -1 : 1;
    });
  }

  return (
    <Dialog open={Boolean(trace)} onClose={onClose} maxWidth="xl" fullWidth>
      <DialogTitle onClose={onClose}>Search detail - {trace.categoryName}</DialogTitle>
      <DialogContent>
        <Box className="flex items-start justify-between gap-4 flex-wrap mb-3">
          <Box>
            <Typography variant="body2">
              <strong>Query used:</strong> {effectiveQuery}
              {trace.newquery && (
                <Typography variant="caption" color="textSecondary" style={{ display: 'block' }}>
                  Originally requested as: {trace.query}
                </Typography>
              )}
            </Typography>
            {(trace.season !== null || trace.ep !== null) && (
              <Typography variant="body2">
                <strong>Season/Episode requested:</strong> {trace.season ?? '?'} / {trace.ep ?? '?'}
              </Typography>
            )}
            <Typography variant="body2">
              <strong>Additional local filter:</strong> {trace.additionalLocalFilterEnabled ? 'On' : 'Off'}
              {' - '}{keptCount} of {trace.items.length} candidates kept
            </Typography>
          </Box>
          {groupsInUse.size > 0 && (
            <Box className="flex flex-col items-end gap-1" style={{ flexShrink: 0 }}>
              <Typography variant="caption" color="textSecondary">Reason key</Typography>
              <Box className="flex flex-wrap justify-end gap-1" style={{ maxWidth: 280 }}>
                {(['keyword', 'excluded-term', 'episode-code'] as ReasonGroup[])
                  .filter((g) => groupsInUse.has(g))
                  .map((g) => (
                    <Chip key={g} size="small" variant="outlined" icon={REASON_GROUP_ICON[g]} label={REASON_GROUP_LABEL[g]} />
                  ))}
              </Box>
            </Box>
          )}
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead style={{ position: 'sticky', top: 0, zIndex: 1, backgroundColor: 'var(--card)' }}>
              <TableRow>
                <TableCell component="th">Title</TableCell>
                <TableCell component="th" style={{ width: 90 }}>
                  <TableSortLabel
                    active={statusSort !== 'original'}
                    direction={statusSort === 'rejected' ? 'desc' : 'asc'}
                    onClick={() => setStatusSort((s) => STATUS_SORT_CYCLE[s])}
                  >
                    Status
                  </TableSortLabel>
                </TableCell>
                <TableCell component="th" style={{ width: 130 }}>Reason</TableCell>
                <TableCell component="th" style={{ width: 110 }}>Resolution</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedItems.map(({ item, index }) => (
                <TableRow hover key={`${item.youtubeId}-${index}`}>
                  <TableCell style={{ maxWidth: 360 }}>
                    <HighlightedTitle
                      title={item.title}
                      matchedTerm={HIGHLIGHTABLE_REASONS.has(item.reason) ? item.matchedTerm : null}
                    />
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={item.kept ? 'Kept' : 'Rejected'}
                      color={item.kept ? 'success' : 'error'}
                      variant="filled"
                    />
                  </TableCell>
                  <TableCell>
                    {item.reason && (
                      <Tooltip title={reasonMessage(item, trace)}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--muted-foreground)' }}>
                          {REASON_GROUP_ICON[REASON_GROUP[item.reason]]}
                          <Typography variant="caption" color="textSecondary" style={{ whiteSpace: 'nowrap' }}>
                            {REASON_SHORT_LABEL[item.reason]}
                          </Typography>
                        </span>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell>{resolutionCell(item, trace)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export default NzbSearchTraceDialog;
