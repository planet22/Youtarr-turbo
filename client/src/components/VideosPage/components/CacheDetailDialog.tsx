import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  CircularProgress,
  Alert,
} from '../../ui';
import {
  Database as MetadataCacheIcon,
  Storage as CachedVideoIcon,
  ExpandMore as ExpandMoreIcon,
  Refresh as RefreshIcon,
} from '../../../lib/icons';
import { VideoData } from '../../../types/VideoData';
import { useCacheActions, MetadataCacheDetail, UntrackedCacheDetail } from '../hooks/useCacheActions';
import { formatAddedDateTime, formatFileSize, formatExpiresIn } from '../../../utils/formatters';

export interface CacheDetailDialogProps {
  open: boolean;
  onClose: () => void;
  video: VideoData;
  kind: 'metadata' | 'video';
  token: string | null;
  onClear: () => void;
  clearing: boolean;
  // Refresh only applies to kind === 'metadata' - re-fetches this video's
  // metadata via yt-dlp and overwrites both the .info.json and
  // youtube_metadata_cache DB caches. Called after the dialog's own detail
  // re-fetch so the parent's row (timestamps/icons) picks up the change too.
  onRefreshed?: () => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" style={{ textAlign: 'right', wordBreak: 'break-word' }}>{value}</Typography>
    </div>
  );
}

function CacheDetailDialog({ open, onClose, video, kind, token, onClear, clearing, onRefreshed }: CacheDetailDialogProps) {
  const { fetchMetadataDetail, fetchVideoCacheDetail, refreshMetadataCache } = useCacheActions(token);
  const [metadataDetail, setMetadataDetail] = useState<MetadataCacheDetail | null>(null);
  const [videoDetail, setVideoDetail] = useState<UntrackedCacheDetail | null>(null);
  const [rawJson, setRawJson] = useState<string | null>(null);
  const [loadingRaw, setLoadingRaw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Deleting a cached video is a real, irreversible disk action (reverts a
  // tracked video to STRM, or removes an untracked buffer copy outright) -
  // require a second click, same as ClearCachedVideoDialog's bulk-selection
  // confirmation, before onClear actually fires.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isTracked = video.isTracked !== false;

  useEffect(() => {
    setConfirmingDelete(false);
    if (!open) {
      setMetadataDetail(null);
      setVideoDetail(null);
      setRawJson(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    if (kind === 'metadata') {
      fetchMetadataDetail(video.youtubeId).then((detail) => {
        if (!cancelled) {
          setMetadataDetail(detail);
          setLoading(false);
        }
      });
    } else if (!isTracked) {
      fetchVideoCacheDetail(video.youtubeId).then((detail) => {
        if (!cancelled) {
          setVideoDetail(detail);
          setLoading(false);
        }
      });
    } else {
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, kind, video.youtubeId]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshMetadataCache(video.youtubeId);
      const wantsRaw = rawJson !== null;
      const detail = await fetchMetadataDetail(video.youtubeId, wantsRaw);
      setMetadataDetail(detail);
      if (wantsRaw) {
        setRawJson(detail?.rawInfoJson ? JSON.stringify(detail.rawInfoJson, null, 2) : 'No data');
      }
      onRefreshed?.();
    } finally {
      setRefreshing(false);
    }
  };

  const handleExpandRaw = async (expanded: boolean) => {
    if (!expanded || rawJson !== null) return;
    if (metadataDetail?.hasRawInfoJson === false) return;
    setLoadingRaw(true);
    const detail = await fetchMetadataDetail(video.youtubeId, true);
    setRawJson(detail?.rawInfoJson ? JSON.stringify(detail.rawInfoJson, null, 2) : 'No data');
    setLoadingRaw(false);
  };

  const title = kind === 'metadata' ? 'Cached Metadata' : 'Cached Video';
  const Icon = kind === 'metadata' ? MetadataCacheIcon : CachedVideoIcon;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Icon size={20} className="shrink-0" />
        {title}
      </DialogTitle>

      <DialogContent>
        {loading ? (
          <Typography variant="body2" color="text.secondary">Loading…</Typography>
        ) : kind === 'metadata' ? (
          <div>
            <Row label="Title" value={metadataDetail?.title ?? video.youTubeVideoName} />
            <Row label="Channel" value={metadataDetail?.uploader ?? video.youTubeChannelName} />
            <Row label="Resolution" value={metadataDetail?.resolution} />
            <Row label="FPS" value={metadataDetail?.fps} />
            <Row label="Fetched" value={metadataDetail?.fetchedAgo ?? formatAddedDateTime(metadataDetail?.fetchedAt ?? video.cachedMetadataAt)} />
            <Row label="Last Accessed" value={metadataDetail?.lastAccessedAgo ?? formatAddedDateTime(metadataDetail?.lastAccessedAt)} />
            <Row label="Expires" value={formatExpiresIn(metadataDetail?.expiresAt ?? video.cachedMetadataExpiresAt) ?? 'Never'} />
            <Accordion
              style={{ marginTop: 12, border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}
              onChange={(_e: React.SyntheticEvent, expanded: boolean) => handleExpandRaw(expanded)}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon size={18} />}>
                <Typography variant="subtitle2">Show Raw JSON</Typography>
              </AccordionSummary>
              <AccordionDetails>
                {loadingRaw ? (
                  <Typography variant="body2" color="text.secondary">Loading…</Typography>
                ) : metadataDetail?.hasRawInfoJson === false ? (
                  <Typography variant="body2" color="text.secondary">
                    Duration only — this video hasn&apos;t been streamed, downloaded, or materialized yet, so no full
                    metadata has been fetched. It will be filled in automatically the next time it plays.
                  </Typography>
                ) : (
                  <pre style={{ maxHeight: 300, overflow: 'auto', fontSize: 12, margin: 0 }}>{rawJson}</pre>
                )}
              </AccordionDetails>
            </Accordion>
          </div>
        ) : (
          <div>
            {isTracked ? (
              <>
                <Row label="File Path" value={video.filePath} />
                <Row label="File Size" value={formatFileSize(video.fileSize ? Number(video.fileSize) : null)} />
                <Row label="Resolution" value={video.video_resolution} />
                <Row label="Cached" value={formatAddedDateTime(video.cachedVideoAt)} />
                <Row label="Expires" value={formatExpiresIn(video.cachedVideoExpiresAt) ?? 'Never'} />
              </>
            ) : (
              <>
                <Row label="File Size" value={formatFileSize(videoDetail?.size ?? null)} />
                <Row label="Cached" value={formatAddedDateTime(videoDetail?.mtime ?? video.cachedVideoAt)} />
                <Row label="Expires" value={formatExpiresIn(video.cachedVideoExpiresAt) ?? 'Never'} />
              </>
            )}
          </div>
        )}
        {kind === 'video' && confirmingDelete && (
          <Alert severity="warning" style={{ marginTop: 12 }}>
            <Typography variant="body2">
              {isTracked
                ? 'This will delete the cached video file and revert this video back to its STRM placeholder.'
                : "This will delete this video's buffered copy outright."}
            </Typography>
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary" autoFocus>
          Close
        </Button>
        {kind === 'metadata' && (
          <Button
            onClick={handleRefresh}
            disabled={refreshing || loading}
            variant="outlined"
            color="primary"
            startIcon={refreshing ? <CircularProgress size={16} /> : <RefreshIcon size={16} />}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        )}
        {kind === 'metadata' ? (
          <Button onClick={onClear} disabled={clearing} variant="outlined" color="error">
            Clear
          </Button>
        ) : confirmingDelete ? (
          <Button onClick={onClear} disabled={clearing} variant="contained" color="error" autoFocus>
            {clearing ? 'Deleting…' : 'Confirm Delete'}
          </Button>
        ) : (
          <Button onClick={() => setConfirmingDelete(true)} disabled={clearing} variant="outlined" color="error">
            Delete
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default CacheDetailDialog;
