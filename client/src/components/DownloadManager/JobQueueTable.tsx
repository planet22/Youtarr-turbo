import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
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
  IconButton,
  Box,
  Tooltip,
  Alert,
} from '../ui';
import {
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Trash2 as DeleteIcon,
  Pause as PauseIcon,
  Play as PlayIcon,
  List as QueueIcon,
  PlaySquare as PlaylistPlayIcon,
} from 'lucide-react';
import WebSocketContext from '../../contexts/WebSocketContext';
import { Job } from '../../types/Job';
import { jobTypeLabel } from '../../utils/jobTypeLabel';
import { formatAddedDateTime } from '../../utils/formatters';
import { parseYoutubeUrls } from './ManualDownload/urlParser';

// Scratch flag for ad-hoc verbose tracing (queue reorder/order investigation
// as of 2026-09-06) - flip live from the browser console with
// localStorage.setItem('detailedDebug', 'true') (or 'false'/remove to turn
// off), no rebuild needed. Every console line it gates is tagged
// '[detailedDebug]' so grepping the client source for "detailedDebug" finds
// every call site (including this flag itself) when it's time to remove it.
function isDetailedDebugEnabled(): boolean {
  try {
    return localStorage.getItem('detailedDebug') === 'true';
  } catch {
    return false;
  }
}

interface JobQueueTableProps {
  pendingJobs: Job[];
  // The currently running job, if any - pinned as a "Running now" row at the
  // top so the table isn't empty during the common case of a single active
  // job with nothing queued behind it. Not reorderable/deletable here; use
  // the Stop Job button above to cancel it.
  activeJob?: Job | null;
  token: string | null;
}

const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 54;

// Best-effort video id for a real YouTube thumbnail - only manual/retry jobs
// know a specific video before the job has actually run. Channel/grouped
// downloads don't resolve to specific videos until yt-dlp runs, so they fall
// back to a type icon tile below.
function firstKnownYoutubeId(job: Job): string | null {
  const urls = job.data?.urls;
  if (urls && urls.length > 0) {
    const parsed = parseYoutubeUrls(urls.join('\n'), new Set());
    if (parsed.valid.length > 0) return parsed.valid[0].youtubeId;
  }
  const failedVideos = job.data?.failedVideos;
  if (failedVideos && failedVideos.length > 0 && failedVideos[0].youtubeId) {
    return failedVideos[0].youtubeId;
  }
  return null;
}

function jobDetailsText(job: Job): string | null {
  const urls = job.data?.urls;
  if (urls && urls.length > 0) {
    return `${urls.length} video${urls.length !== 1 ? 's' : ''} from URL${urls.length !== 1 ? 's' : ''}`;
  }
  const groups = job.data?.groups;
  if (groups && groups.length > 0) {
    const channelCount = groups.reduce((sum, group) => sum + (group.channels?.length || 0), 0);
    if (channelCount > 0) {
      return `${channelCount} channel${channelCount !== 1 ? 's' : ''} in ${groups.length} group${groups.length !== 1 ? 's' : ''}`;
    }
  }
  if (job.data?.autoRetryAttempt) {
    return `Auto-retry attempt ${job.data.autoRetryAttempt}`;
  }
  return null;
}

interface VideoEntry {
  url: string;
  youtubeId: string | null;
}

// The individual videos inside a job, when known - only jobs submitted with
// an explicit URL list (manual downloads, auto-retries, "Download All") know
// this before running; grouped channel-tab downloads resolve to specific
// videos only once yt-dlp runs, so they have nothing to expand.
function jobVideoEntries(job: Job): VideoEntry[] {
  const urls = job.data?.urls;
  if (!urls || urls.length === 0) return [];
  const parsed = parseYoutubeUrls(urls.join('\n'), new Set());
  const byUrl = new Map(parsed.valid.map((entry) => [entry.url, entry.youtubeId]));
  return urls.map((url) => ({ url, youtubeId: byUrl.get(url) ?? null }));
}

function canExpandJob(job: Job): boolean {
  return jobVideoEntries(job).length > 0;
}

const MOVE_HIGHLIGHT_MS = 700;

// Briefly marks a row as "just moved" so a reorder is visible even when the
// row otherwise looks identical to its neighbors (a thumbnail + id, no other
// distinguishing text) - callers apply a background/transition class keyed
// off whether a given row's id matches the returned highlightedId.
function useMoveHighlight<T>() {
  const [highlightedId, setHighlightedId] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const flash = useCallback((id: T) => {
    setHighlightedId(id);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setHighlightedId(null), MOVE_HIGHLIGHT_MS);
  }, []);

  return [highlightedId, flash] as const;
}

function VideoRowThumbnail({ youtubeId }: { youtubeId: string | null }) {
  const [imgFailed, setImgFailed] = useState(false);
  const boxStyle: React.CSSProperties = {
    width: 64,
    height: 36,
    overflow: 'hidden',
    backgroundColor: 'var(--media-placeholder-background)',
    borderRadius: 'var(--radius-thumb)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  if (youtubeId && !imgFailed) {
    return (
      <Box style={boxStyle}>
        <img
          src={`https://i.ytimg.com/vi/${youtubeId}/default.jpg`}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgFailed(true)}
        />
      </Box>
    );
  }

  return (
    <Box style={boxStyle} className="text-muted-foreground">
      <QueueIcon size={16} />
    </Box>
  );
}

// Read-only status for one video inside the currently-running job: yt-dlp
// owns the whole URL list once a (non-STRM) job starts, so this can only
// ever report what already happened, never control what happens next.
function activeVideoStatus(job: Job, youtubeId: string | null): { label: string; color: 'success' | 'error' | 'default' } {
  if (youtubeId) {
    if (job.data?.videos?.some((v) => v.youtubeId === youtubeId)) {
      return { label: 'Done', color: 'success' };
    }
    if (job.data?.failedVideos?.some((v) => v.youtubeId === youtubeId)) {
      return { label: 'Failed', color: 'error' };
    }
  }
  return { label: 'Pending', color: 'default' };
}

// A title is only known once a video has actually been processed (success
// or failure resolves real metadata) - a still-Pending row has nothing to
// show but its id/URL, since it hasn't run yet.
function videoTitleFor(job: Job, youtubeId: string | null): string | null {
  if (!youtubeId) return null;
  const done = job.data?.videos?.find((v) => v.youtubeId === youtubeId);
  if (done?.youTubeVideoName) return done.youTubeVideoName;
  const failed = job.data?.failedVideos?.find((v) => v.youtubeId === youtubeId);
  if (failed?.title && failed.title !== 'Unknown') return failed.title;
  return null;
}

interface StrmPauseControl {
  paused: boolean;
  pending: boolean;
  onToggle: () => void;
}

interface JobVideoRowsProps {
  job: Job;
  // Shows Done/Failed/Pending chips per video - true for any active job.
  showStatus: boolean;
  // Whether videos can be reordered/removed. For a Pending job this covers
  // every row; for an active job it's only true for a STRM batch (see
  // job.data.isStrmBatch), and even then only its Pending-status rows -
  // ones already Done/Failed already happened and can't be undone.
  editable?: boolean;
  onUpdateUrls?: (jobId: string, urls: string[]) => void;
  busy?: boolean;
  // Present only for an editable STRM active job - the loop-level
  // pause/resume, distinct from the queue-level "Pause Queue" button (which
  // only stops the *next* job from auto-starting).
  strmPauseControl?: StrmPauseControl;
}

// Expanded sub-list of the individual videos inside one job.
function JobVideoRows({ job, showStatus, editable = false, onUpdateUrls, busy, strmPauseControl }: JobVideoRowsProps) {
  const [highlightedUrl, flashHighlight] = useMoveHighlight<string>();
  const entries = jobVideoEntries(job);
  if (entries.length === 0) return null;

  // Reorder/remove operate over just the editable (not-yet-processed)
  // subset, leaving Done/Failed entries untouched and in place.
  const editableIndexes = entries
    .map((entry, index) => ({ entry, index, status: showStatus ? activeVideoStatus(job, entry.youtubeId) : null }))
    .filter(({ status }) => !showStatus || status?.label === 'Pending')
    .map(({ index }) => index);

  const setEditableUrls = (nextUrls: string[]) => {
    if (!onUpdateUrls) return;
    // A Pending job has no status filtering - the whole entries list IS the
    // editable set, and can't be emptied (delete the job instead).
    if (!showStatus && nextUrls.length === 0) return;
    onUpdateUrls(job.id, nextUrls);
  };

  const removeAt = (index: number) => {
    if (!showStatus && editableIndexes.length <= 1) return; // last video of a Pending job - delete the whole job instead
    setEditableUrls(editableIndexes.filter((i) => i !== index).map((i) => entries[i].url));
  };

  const moveAt = (index: number, toIndex: number) => {
    const pos = editableIndexes.indexOf(index);
    if (pos === -1 || toIndex < 0 || toIndex >= editableIndexes.length) return;
    const nextIndexes = editableIndexes.slice();
    const [moved] = nextIndexes.splice(pos, 1);
    nextIndexes.splice(toIndex, 0, moved);
    flashHighlight(entries[index].url);
    setEditableUrls(nextIndexes.map((i) => entries[i].url));
  };

  // An active STRM batch keeps consuming its queue in real time, so editing
  // it while running is a race against whichever video starts next - safe
  // only once paused. A still-Pending job has no such control (nothing is
  // running yet), so this never applies there.
  const requiresPauseToEdit = Boolean(strmPauseControl) && !strmPauseControl?.paused;

  return (
    <TableRow>
      <TableCell colSpan={8} style={{ padding: 0 }}>
        <Box className="bg-muted/30 px-4 py-2" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <Box className="flex items-center justify-between mb-1">
            <Typography variant="caption" color="textSecondary">
              {entries.length} video{entries.length !== 1 ? 's' : ''} in this job
              {showStatus && !editable ? ' (read-only while running)' : ''}
            </Typography>
            {strmPauseControl && (
              <Button
                size="small"
                variant="outlined"
                disabled={strmPauseControl.pending}
                onClick={strmPauseControl.onToggle}
                startIcon={strmPauseControl.paused ? <PlayIcon size={14} /> : <PauseIcon size={14} />}
              >
                {strmPauseControl.paused ? 'Resume' : 'Pause'}
              </Button>
            )}
          </Box>
          {strmPauseControl?.paused && (
            <Typography variant="caption" color="textSecondary" className="block mb-1">
              Paused — will not fetch the next video until resumed.
            </Typography>
          )}
          {entries.map((entry, index) => {
            const status = showStatus ? activeVideoStatus(job, entry.youtubeId) : null;
            const title = showStatus ? videoTitleFor(job, entry.youtubeId) : null;
            const rowEditable = editable && editableIndexes.includes(index);
            const editablePos = rowEditable ? editableIndexes.indexOf(index) : -1;
            return (
              <Box
                key={`${entry.url}-${index}`}
                className={`flex items-center gap-2 py-1 rounded-[var(--radius-ui)] transition-colors duration-500 ${
                  highlightedUrl === entry.url ? 'bg-primary/15' : ''
                }`}
                style={{ borderTop: index > 0 ? '1px solid var(--border)' : undefined }}
              >
                <VideoRowThumbnail youtubeId={entry.youtubeId} />
                {title ? (
                  <Tooltip title={title} enterDelay={400}>
                    <Typography variant="body2" style={{ flex: 1, minWidth: 0 }} noWrap>
                      {title}
                    </Typography>
                  </Tooltip>
                ) : (
                  <Typography variant="body2" color="textSecondary" style={{ flex: 1, minWidth: 0 }} noWrap>
                    {entry.youtubeId || entry.url}
                  </Typography>
                )}
                {status && (
                  <Chip size="small" label={status.label} color={status.color} variant="outlined" />
                )}
                {rowEditable && (
                  <>
                    <Tooltip title={requiresPauseToEdit ? 'Pause the batch to reorder its videos' : 'Move video up'}>
                      <span>
                        <IconButton
                          size="small"
                          aria-label="Move video up"
                          disabled={editablePos === 0 || busy || requiresPauseToEdit}
                          onClick={() => moveAt(index, editablePos - 1)}
                        >
                          <ChevronUp size={14} />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title={requiresPauseToEdit ? 'Pause the batch to reorder its videos' : 'Move video down'}>
                      <span>
                        <IconButton
                          size="small"
                          aria-label="Move video down"
                          disabled={editablePos === editableIndexes.length - 1 || busy || requiresPauseToEdit}
                          onClick={() => moveAt(index, editablePos + 1)}
                        >
                          <ChevronDown size={14} />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip
                      title={
                        requiresPauseToEdit
                          ? 'Pause the batch to remove a video'
                          : !showStatus && editableIndexes.length <= 1
                          ? 'Remove the whole job instead'
                          : 'Remove this video from the job'
                      }
                    >
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          aria-label="Remove video from job"
                          disabled={(!showStatus && editableIndexes.length <= 1) || busy || requiresPauseToEdit}
                          onClick={() => removeAt(index)}
                        >
                          <DeleteIcon size={14} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </>
                )}
              </Box>
            );
          })}
        </Box>
      </TableCell>
    </TableRow>
  );
}

function JobThumbnail({ job }: { job: Job }) {
  const [imgFailed, setImgFailed] = useState(false);
  const youtubeId = firstKnownYoutubeId(job);
  const isChannelDownload = job.jobType.includes('Channel Downloads');

  const boxStyle: React.CSSProperties = {
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    overflow: 'hidden',
    backgroundColor: 'var(--media-placeholder-background)',
    borderRadius: 'var(--radius-thumb)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };

  if (youtubeId && !imgFailed) {
    return (
      <Box style={boxStyle}>
        <img
          src={`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          onError={() => setImgFailed(true)}
        />
      </Box>
    );
  }

  return (
    <Box style={boxStyle} className="text-muted-foreground">
      {isChannelDownload ? <PlaylistPlayIcon size={22} /> : <QueueIcon size={22} />}
    </Box>
  );
}

function JobQueueTable({ pendingJobs, activeJob, token }: JobQueueTableProps) {
  const [paused, setPaused] = useState(false);
  const [pauseActionPending, setPauseActionPending] = useState(false);
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [updatingVideosId, setUpdatingVideosId] = useState<string | null>(null);
  const [strmPauseActionPending, setStrmPauseActionPending] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [highlightedJobId, flashJobHighlight] = useMoveHighlight<string>();
  const wsContext = useContext(WebSocketContext);
  // Id of a job whose reorder PATCH succeeded but whose new position hasn't
  // shown up in pendingJobs yet (that only lands once the server's
  // jobsUpdated broadcast triggers a refetch) - flashing immediately on
  // click would fade out during that round-trip, before the row actually
  // jumps, so the flash is deferred until the reordered data arrives.
  const awaitingMoveIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isDetailedDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.log('[detailedDebug][JobQueueTable] pendingJobs prop updated', pendingJobs.map((j) => j.id));
    }
    const id = awaitingMoveIdRef.current;
    if (id && pendingJobs.some((job) => job.id === id)) {
      awaitingMoveIdRef.current = null;
      flashJobHighlight(id);
    }
  }, [pendingJobs, flashJobHighlight]);

  const toggleExpanded = (jobId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const authHeaders = useCallback(
    () => ({ 'x-access-token': token || '' }),
    [token]
  );

  const fetchQueueState = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/jobs/queue-state', { headers: authHeaders() });
      if (response.ok) {
        const data = await response.json();
        setPaused(Boolean(data.paused));
      }
    } catch {
      // Leave current value; next broadcast or manual toggle corrects it.
    }
  }, [token, authHeaders]);

  useEffect(() => {
    fetchQueueState();
  }, [fetchQueueState]);

  useEffect(() => {
    if (!wsContext) return;
    const filter = (message: any) =>
      message.destination === 'broadcast' && message.type === 'queuePauseChanged';
    const callback = (payload: { paused?: boolean }) => {
      if (typeof payload.paused === 'boolean') setPaused(payload.paused);
    };
    wsContext.subscribe(filter, callback);
    return () => wsContext.unsubscribe(callback);
  }, [wsContext]);

  const togglePause = async () => {
    setPauseActionPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/queue/${paused ? 'resume' : 'pause'}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (response.ok) {
        setPaused(!paused);
      } else {
        setError('Failed to update queue pause state');
      }
    } catch {
      setError('Failed to update queue pause state');
    } finally {
      setPauseActionPending(false);
    }
  };

  const reorder = async (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= pendingJobs.length) return;
    const next = pendingJobs.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    const orderedIds = next.map((job) => job.id);
    const debug = isDetailedDebugEnabled();

    if (debug) {
      // eslint-disable-next-line no-console
      console.log('[detailedDebug][JobQueueTable] reorder requested', { fromIndex, toIndex, movedId: moved.id, orderedIds });
    }

    setReorderingId(moved.id);
    awaitingMoveIdRef.current = moved.id;
    setError(null);
    try {
      const response = await fetch('/api/jobs/queue/reorder', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[detailedDebug][JobQueueTable] reorder response', { status: response.status, ok: response.ok });
      }
      if (!response.ok) {
        setError('Failed to reorder queue');
        awaitingMoveIdRef.current = null;
      }
      // The jobsUpdated broadcast this triggers server-side will refetch
      // /runningjobs via useDownloadListingsRefresh in the parent.
    } catch (err) {
      if (debug) {
        // eslint-disable-next-line no-console
        console.log('[detailedDebug][JobQueueTable] reorder request threw', err);
      }
      setError('Failed to reorder queue');
      awaitingMoveIdRef.current = null;
    } finally {
      setReorderingId(null);
    }
  };

  const updateJobUrls = async (jobId: string, urls: string[]) => {
    setUpdatingVideosId(jobId);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/videos`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      if (!response.ok) {
        setError('Failed to update the video list for this job');
      }
    } catch {
      setError('Failed to update the video list for this job');
    } finally {
      setUpdatingVideosId(null);
    }
  };

  const updateActiveStrmUrls = async (jobId: string, urls: string[]) => {
    setUpdatingVideosId(jobId);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/strm/videos`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
      if (!response.ok) {
        setError('Failed to update the video list for this job');
      }
    } catch {
      setError('Failed to update the video list for this job');
    } finally {
      setUpdatingVideosId(null);
    }
  };

  const toggleStrmPause = async (jobId: string, currentlyPaused: boolean) => {
    setStrmPauseActionPending(jobId);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/strm/${currentlyPaused ? 'resume' : 'pause'}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!response.ok) {
        setError('Failed to update the STRM batch pause state');
      }
    } catch {
      setError('Failed to update the STRM batch pause state');
    } finally {
      setStrmPauseActionPending(null);
    }
  };

  const removeJob = async (jobId: string) => {
    setDeletingId(jobId);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!response.ok) {
        setError('Failed to remove job from queue');
      }
    } catch {
      setError('Failed to remove job from queue');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Paper style={{ overflow: 'hidden' }}>
      <Box className="px-4 py-3 flex items-center justify-between flex-wrap gap-2">
        <Box>
          <Typography variant="subtitle1">Job Queue</Typography>
          <Typography variant="body2" color="textSecondary">
            {activeJob ? '1 running, ' : ''}
            {pendingJobs.length} {pendingJobs.length === 1 ? 'job' : 'jobs'} queued
          </Typography>
        </Box>
        <Tooltip title={paused ? 'Resume automatic queue processing' : 'Pause automatic queue processing so you can reorder it'}>
          <span>
            <Button
              variant="outlined"
              color={paused ? 'primary' : 'inherit'}
              size="small"
              disabled={pauseActionPending}
              onClick={togglePause}
              startIcon={paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />}
            >
              {paused ? 'Resume Queue' : 'Pause Queue'}
            </Button>
          </span>
        </Tooltip>
      </Box>

      {paused && (
        <Box className="px-4 pb-2">
          <Alert severity="warning">
            Queue paused — the next job will not start automatically until you resume.
          </Alert>
        </Box>
      )}

      {error && (
        <Box className="px-4 pb-2">
          <Alert severity="error">{error}</Alert>
        </Box>
      )}

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell component="th" style={{ width: 32 }} />
              <TableCell component="th" style={{ width: 56 }} />
              <TableCell component="th" style={{ width: THUMB_WIDTH + 16 }}>Thumbnail</TableCell>
              <TableCell component="th">Job</TableCell>
              <TableCell component="th">Details</TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 140 }}>Queued</TableCell>
              <TableCell component="th" style={{ width: 110 }}>Status</TableCell>
              <TableCell component="th" style={{ width: 60 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {!activeJob && pendingJobs.length === 0 && (
              <TableRow>
                <TableCell colSpan={8}>
                  <Typography variant="body2" color="textSecondary" style={{ padding: '8px 0' }}>
                    Nothing queued right now.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {activeJob && (
              <React.Fragment>
                <TableRow className="bg-primary/5">
                  <TableCell>
                    {canExpandJob(activeJob) && (
                      <IconButton
                        size="small"
                        aria-label={expandedIds.has(activeJob.id) ? 'Collapse video list' : 'Expand video list'}
                        onClick={() => toggleExpanded(activeJob.id)}
                      >
                        {expandedIds.has(activeJob.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </IconButton>
                    )}
                  </TableCell>
                  <TableCell />
                  <TableCell>
                    <JobThumbnail job={activeJob} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" className="font-semibold">
                      {jobTypeLabel(activeJob.jobType)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="textSecondary">
                      {jobDetailsText(activeJob) || '—'}
                    </Typography>
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    {formatAddedDateTime(new Date(activeJob.timeCreated).toISOString())}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label="Running now" color="success" variant="filled" />
                  </TableCell>
                  <TableCell />
                </TableRow>
                {expandedIds.has(activeJob.id) && (
                  <JobVideoRows
                    job={activeJob}
                    showStatus
                    editable={activeJob.data?.isStrmBatch === true}
                    onUpdateUrls={activeJob.data?.isStrmBatch ? updateActiveStrmUrls : undefined}
                    busy={updatingVideosId === activeJob.id}
                    strmPauseControl={
                      activeJob.data?.isStrmBatch
                        ? {
                            paused: activeJob.data?.strmPaused === true,
                            pending: strmPauseActionPending === activeJob.id,
                            onToggle: () => toggleStrmPause(activeJob.id, activeJob.data?.strmPaused === true),
                          }
                        : undefined
                    }
                  />
                )}
              </React.Fragment>
            )}
            {pendingJobs.map((job, index) => {
              const details = jobDetailsText(job);
              const isBusy = reorderingId === job.id || deletingId === job.id;
              const expandable = canExpandJob(job);
              return (
                <React.Fragment key={job.id}>
                <TableRow
                  hover
                  className={`transition-colors duration-500 ${highlightedJobId === job.id ? 'bg-primary/15' : ''}`}
                >
                  <TableCell>
                    {expandable && (
                      <IconButton
                        size="small"
                        aria-label={expandedIds.has(job.id) ? 'Collapse video list' : 'Expand video list'}
                        onClick={() => toggleExpanded(job.id)}
                      >
                        {expandedIds.has(job.id) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </IconButton>
                    )}
                  </TableCell>
                  <TableCell>
                    <Box className="flex flex-col">
                      <IconButton
                        size="small"
                        aria-label="Move up in queue"
                        disabled={index === 0 || isBusy}
                        onClick={() => reorder(index, index - 1)}
                      >
                        <ChevronUp size={16} />
                      </IconButton>
                      <IconButton
                        size="small"
                        aria-label="Move down in queue"
                        disabled={index === pendingJobs.length - 1 || isBusy}
                        onClick={() => reorder(index, index + 1)}
                      >
                        <ChevronDown size={16} />
                      </IconButton>
                    </Box>
                  </TableCell>
                  <TableCell>
                    <JobThumbnail job={job} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" className="font-semibold">
                      {jobTypeLabel(job.jobType)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="textSecondary">
                      {details || '—'}
                    </Typography>
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    {formatAddedDateTime(new Date(job.timeCreated).toISOString())}
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={index === 0 ? 'Next up' : `Queued #${index + 1}`}
                      color={index === 0 ? 'primary' : 'default'}
                      variant={index === 0 ? 'filled' : 'outlined'}
                    />
                  </TableCell>
                  <TableCell>
                    <Tooltip title="Remove this job from the queue">
                      <span>
                        <IconButton
                          color="error"
                          size="small"
                          aria-label="Remove job from queue"
                          disabled={isBusy}
                          onClick={() => removeJob(job.id)}
                        >
                          <DeleteIcon size={16} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
                {expandable && expandedIds.has(job.id) && (
                  <JobVideoRows
                    job={job}
                    showStatus={false}
                    editable
                    onUpdateUrls={updateJobUrls}
                    busy={updatingVideosId === job.id}
                  />
                )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default JobQueueTable;
