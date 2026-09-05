import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { Alert, Box, Grid, Snackbar, Typography } from '../ui';
import { Trash2 as DeleteIcon, Star as RatingIcon, Download as DownloadIcon, Purge as PurgeIcon, Wifi as StrmIcon, Database as MetadataCacheIcon, Storage as CachedVideoIcon } from '../../lib/icons';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useConfig } from '../../hooks/useConfig';
import { useDownloadListingsRefresh } from '../../hooks/useDownloadListingsRefresh';
import { useTriggerDownloads } from '../../hooks/useTriggerDownloads';
import { VideoData } from '../../types/VideoData';
import AddChannelDialog from '../shared/AddChannelDialog';
import DeleteVideosDialog from '../shared/DeleteVideosDialog';
import { useVideoDeletion } from '../shared/useVideoDeletion';
import PurgeVideosDialog from '../shared/PurgeVideosDialog';
import { useVideoPurge } from '../shared/useVideoPurge';
import StrmDownloadDialog from '../shared/StrmDownloadDialog';
import StrmRevertDialog from '../shared/StrmRevertDialog';
import { useStrmSwitch } from '../shared/useStrmSwitch';
import ChangeRatingDialog from '../shared/ChangeRatingDialog';
import ClearCachedMetadataDialog from '../shared/ClearCachedMetadataDialog';
import ClearCachedVideoDialog from '../shared/ClearCachedVideoDialog';
import ClearCachedRowDialog from '../shared/ClearCachedRowDialog';
import { useVideoProtection } from '../shared/useVideoProtection';
import VideoModal from '../shared/VideoModal';
import { VideoModalData } from '../shared/VideoModal/types';
import DownloadSettingsDialog from '../DownloadManager/ManualDownload/DownloadSettingsDialog';
import { DownloadSettings } from '../DownloadManager/ManualDownload/types';
import VideoCard from './components/VideoCard';
import VideosTable from './components/VideosTable';
import VideosListMobile from './components/VideosListMobile';
import CacheDetailDialog from './components/CacheDetailDialog';
import { useVideosData } from './hooks/useVideosData';
import { useCacheActions } from './hooks/useCacheActions';
import {
  INFINITE_SCROLL_FETCH_SIZE,
  VideoListContainer,
  VideoListPaginationBar,
  useListPageSize,
  useVideoListState,
  useVideoSelection,
  type ChipFilterMode,
  type FilterConfig,
  type PageSize,
  type SelectionAction,
  type VideoListViewMode,
  type SortConfig,
} from '../shared/VideoList';

interface VideosPageProps {
  token: string | null;
}

const VIEW_MODE_STORAGE_KEY = 'youtarr:videosPageViewMode';

const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[a-zA-Z0-9_-]{22}$/;

interface VideoSelectionMeta {
  id: number | null;
  youtubeId: string;
  channelId: string | null;
  removed: boolean;
  youtubeRemoved: boolean;
  isStrm: boolean;
  isTracked: boolean;
  hasCachedMetadata: boolean;
  hasCachedVideo: boolean;
}

function deriveIsStrm(video: VideoData): boolean {
  return Boolean(video.is_strm) ||
    (typeof video.filePath === 'string' && video.filePath.toLowerCase().endsWith('.strm'));
}

function videoDataToModalData(video: VideoData): VideoModalData {
  const isTracked = video.isTracked !== false;
  // An untracked row with a cached video file (a previous play's hls-buffer
  // cache - see server/routes/ytstream.js's HLS_UNTRACKED_BUFFER_CACHE_DIR)
  // is playable via /api/videos/:id/stream's untracked-cache fallback even
  // though it was never actually downloaded - surface that instead of the
  // generic "never downloaded" state so the modal offers Play, not Download.
  const isCachedOnly = !isTracked && Boolean(video.hasCachedVideo);
  return {
    youtubeId: video.youtubeId,
    title: video.youTubeVideoName,
    channelName: video.youTubeChannelName,
    thumbnailUrl: `/images/videothumb-${video.youtubeId}.jpg`,
    duration: video.duration,
    publishedAt: video.originalDate || null,
    addedAt: video.timeCreated || null,
    mediaType: video.media_type || 'video',
    status: isTracked ? (video.removed ? 'missing' : 'downloaded') : (isCachedOnly ? 'cached' : 'never_downloaded'),
    isDownloaded: isTracked && !video.removed,
    isStrm: deriveIsStrm(video),
    filePath: video.filePath || null,
    fileSize: video.fileSize ? Number(video.fileSize) : null,
    audioFilePath: video.audioFilePath || null,
    audioFileSize: video.audioFileSize ? Number(video.audioFileSize) : null,
    isProtected: video.protected || false,
    isIgnored: false,
    normalizedRating: video.normalized_rating || null,
    ratingSource: video.rating_source || null,
    databaseId: video.id ?? null,
    channelId: video.channel_id || null,
  };
}

function VideosPage({ token }: VideosPageProps) {
  const isMobile = useMediaQuery('(max-width: 767px)');

  const listState = useVideoListState({
    initialViewMode: (isMobile ? 'list' : 'table') as VideoListViewMode,
    viewModeStorageKey: VIEW_MODE_STORAGE_KEY,
  });

  const [page, setPage] = useState(1);
  const [channelFilter, setChannelFilter] = useState('');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [orderBy, setOrderBy] = useState<'published' | 'added'>('added');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [maxRatingFilter, setMaxRatingFilter] = useState('');
  const [protectedFilter, setProtectedFilter] = useState<ChipFilterMode>('off');
  const [missingFilter, setMissingFilter] = useState<ChipFilterMode>('off');
  const [watchedFilter, setWatchedFilter] = useState<ChipFilterMode>('off');
  const [strmFilter, setStrmFilter] = useState<ChipFilterMode>('off');
  const [metadataCacheFilter, setMetadataCacheFilter] = useState<ChipFilterMode>('off');
  const [cachedVideoFilter, setCachedVideoFilter] = useState<ChipFilterMode>('off');
  // Defaults on - untracked cache-only videos (played/cached but never
  // downloaded) are part of what this page is for surfacing, not an
  // edge case someone has to opt into seeing.
  const [showUntracked, setShowUntracked] = useState(true);
  const [showFilePaths, setShowFilePaths] = useState(false);

  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [purgeDialogOpen, setPurgeDialogOpen] = useState(false);
  const [strmDownloadDialogOpen, setStrmDownloadDialogOpen] = useState(false);
  const [strmRevertDialogOpen, setStrmRevertDialogOpen] = useState(false);
  // Set for a single-row chip click (bypasses the checkbox selection so the
  // row doesn't visibly become "selected" just from clicking the chip); null
  // means the open STRM dialog is acting on the current bulk selection.
  // Holds a youtubeId (not a database id) - see VideoSelectionMeta.
  const [pendingStrmVideoId, setPendingStrmVideoId] = useState<string | null>(null);
  const [ratingDialogOpen, setRatingDialogOpen] = useState(false);
  const [clearMetadataCacheDialogOpen, setClearMetadataCacheDialogOpen] = useState(false);
  const [clearCachedVideoDialogOpen, setClearCachedVideoDialogOpen] = useState(false);
  const [cacheDetailTarget, setCacheDetailTarget] = useState<{ youtubeId: string; kind: 'metadata' | 'video' } | null>(null);
  // Single-row combined clear (the untracked row's "delete" action) -
  // distinct from cacheDetailTarget's per-cache-type dialog.
  const [clearCachedRowTarget, setClearCachedRowTarget] = useState<VideoData | null>(null);
  const [clearingCachedRow, setClearingCachedRow] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modalVideo, setModalVideo] = useState<VideoData | null>(null);
  const [addChannelTarget, setAddChannelTarget] = useState<{ name: string; url: string } | null>(null);
  const handleAddChannel = useCallback(
    (name: string, url: string) => setAddChannelTarget({ name, url }),
    []
  );

  const navigate = useNavigate();
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const { triggerDownloads } = useTriggerDownloads(token);

  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const { deleteVideos, loading: deleteLoading } = useVideoDeletion();
  const { purgeVideos, loading: purgeLoading } = useVideoPurge();
  const { forceDownload, revertToStrm, loading: strmSwitchLoading } = useStrmSwitch();
  const cacheActions = useCacheActions(token);
  const [clearingCacheDetail, setClearingCacheDetail] = useState(false);
  const configState = useConfig(token);
  const useInfiniteScroll = configState?.config?.channelVideosHotLoad ?? false;
  const {
    toggleProtection,
    successMessage: protectionSuccess,
    error: protectionError,
    clearMessages: clearProtectionMessages,
  } = useVideoProtection(token);

  const [videosPerPage, setVideosPerPage] = useListPageSize('youtarr.videosPage.pageSize');
  const effectivePageSize = useInfiniteScroll ? INFINITE_SCROLL_FETCH_SIZE : videosPerPage;

  const handlePageSizeChange = (newSize: PageSize) => {
    setVideosPerPage(newSize);
    setPage(1);
  };

  const {
    videos,
    setVideos,
    totalVideos,
    totalPages,
    uniqueChannels,
    enabledChannels,
    loading,
    loadError,
    refetch,
  } = useVideosData({
    token,
    page,
    videosPerPage: effectivePageSize,
    orderBy,
    sortOrder,
    search: listState.search,
    channelFilter,
    dateFrom,
    dateTo,
    maxRatingFilter,
    protectedFilter,
    missingFilter,
    watchedFilter,
    strmFilter,
    metadataCacheFilter,
    cachedVideoFilter,
    showUntracked,
    useInfiniteScroll,
  });

  const videoMetaRef = useRef<Map<string, VideoSelectionMeta>>(new Map());

  useEffect(() => {
    for (const video of videos) {
      videoMetaRef.current.set(video.youtubeId, {
        id: video.id ?? null,
        youtubeId: video.youtubeId,
        channelId: video.channel_id || null,
        removed: Boolean(video.removed),
        youtubeRemoved: Boolean(video.youtube_removed),
        isStrm: deriveIsStrm(video),
        isTracked: video.isTracked !== false,
        hasCachedMetadata: Boolean(video.hasCachedMetadata),
        hasCachedVideo: Boolean(video.hasCachedVideo),
      });
    }
  }, [videos]);

  useDownloadListingsRefresh(refetch);

  useEffect(() => {
    setVideos([]);
    setPage(1);
  }, [useInfiniteScroll, setVideos]);

  useEffect(() => {
    setPage(1);
  }, [listState.search, orderBy, sortOrder]);

  useEffect(() => {
    if (!useInfiniteScroll) return;
    if (!loadMoreRef.current) return;
    if (loading || page >= totalPages) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting) {
          setPage((prev) => (prev < totalPages ? prev + 1 : prev));
        }
      },
      { root: null, rootMargin: '0px 0px 160px 0px', threshold: 0 }
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [useInfiniteScroll, loading, page, totalPages]);

  const handleImageError = (youtubeId: string) => {
    setImageErrors((prev) => ({ ...prev, [youtubeId]: true }));
  };

  const handleSortChange = (newOrderBy: 'published' | 'added') => {
    if (orderBy === newOrderBy) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setOrderBy(newOrderBy);
      setSortOrder('desc');
    }
  };

  const handleDeleteConfirm = async (selectedYoutubeIds: string[]) => {
    setDeleteDialogOpen(false);
    const deletableIds = selectedYoutubeIds
      .map((youtubeId) => videoMetaRef.current.get(youtubeId))
      .filter((meta): meta is VideoSelectionMeta => Boolean(meta && meta.id !== null && !meta.removed))
      .map((meta) => meta.id as number);
    if (deletableIds.length === 0) return;
    const result = await deleteVideos(deletableIds, token);
    if (result.success) {
      setSuccessMessage(
        `Successfully deleted ${result.deleted.length} video${result.deleted.length !== 1 ? 's' : ''}`
      );
      selection.clear();
      refetch();
    } else {
      const deletedCount = result.deleted.length;
      const failedCount = result.failed.length;
      if (deletedCount > 0) {
        setSuccessMessage(
          `Deleted ${deletedCount} video${deletedCount !== 1 ? 's' : ''}, but ${failedCount} failed`
        );
        selection.clear();
        refetch();
      } else {
        setErrorMessage(
          `Failed to delete videos: ${result.failed[0]?.error || 'Unknown error'}`
        );
      }
    }
  };

  const handlePurgeConfirm = async (selectedYoutubeIds: string[]) => {
    setPurgeDialogOpen(false);
    const purgeableIds = selectedYoutubeIds
      .map((youtubeId) => videoMetaRef.current.get(youtubeId))
      .filter((meta): meta is VideoSelectionMeta => Boolean(meta && meta.id !== null && meta.removed))
      .map((meta) => meta.id as number);
    if (purgeableIds.length === 0) return;
    const result = await purgeVideos(purgeableIds, token);
    if (result.success) {
      setSuccessMessage(
        `Successfully purged ${result.purged.length} video${result.purged.length !== 1 ? 's' : ''}`
      );
      selection.clear();
      refetch();
    } else {
      const purgedCount = result.purged.length;
      const failedCount = result.failed.length;
      if (purgedCount > 0) {
        setSuccessMessage(
          `Purged ${purgedCount} video${purgedCount !== 1 ? 's' : ''}, but ${failedCount} failed`
        );
        selection.clear();
        refetch();
      } else {
        setErrorMessage(
          `Failed to purge videos: ${result.failed[0]?.error || 'Unknown error'}`
        );
      }
    }
  };

  const handleApplyRating = async (rating: string | null, selectedYoutubeIds: string[]) => {
    if (!token) return;
    const selectedIds = selectedYoutubeIds
      .map((youtubeId) => videoMetaRef.current.get(youtubeId)?.id)
      .filter((id): id is number => id !== null && id !== undefined);
    if (selectedIds.length === 0) return;
    try {
      await axios.post(
        '/api/videos/rating',
        { videoIds: selectedIds, rating },
        { headers: { 'x-access-token': token } }
      );
      setSuccessMessage(
        `Successfully updated content rating for ${selectedIds.length} video(s)`
      );
      selection.clear();
      refetch();
    } catch (error: unknown) {
      console.error('Failed to update ratings:', error);
      const message = axios.isAxiosError(error)
        ? error.response?.data?.error || 'Failed to update content ratings'
        : 'Failed to update content ratings';
      setErrorMessage(message);
    }
  };

  const selectionActions = useMemo<SelectionAction<string>[]>(
    () => [
      {
        id: 'download',
        label: 'Download',
        icon: <DownloadIcon size={14} />,
        intent: 'success',
        disabled: (ids) =>
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && !meta.youtubeRemoved);
          }),
        onClick: () => setDownloadDialogOpen(true),
      },
      {
        id: 'rating',
        label: 'Rating',
        icon: <RatingIcon size={14} />,
        intent: 'warning',
        disabled: (ids) =>
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && meta.isTracked);
          }),
        onClick: () => setRatingDialogOpen(true),
      },
      {
        id: 'delete',
        label: 'Delete',
        icon: <DeleteIcon size={14} />,
        intent: 'danger',
        disabled: (ids) =>
          deleteLoading ||
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && meta.isTracked && !meta.removed);
          }),
        onClick: () => setDeleteDialogOpen(true),
      },
      {
        id: 'purge',
        label: 'Purge',
        icon: <PurgeIcon size={14} />,
        intent: 'danger',
        // Only meaningful for videos already missing from disk — Delete
        // handles everything else (and refuses already-missing ones itself).
        disabled: (ids) =>
          purgeLoading ||
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && meta.isTracked && meta.removed);
          }),
        onClick: () => setPurgeDialogOpen(true),
      },
      {
        id: 'strm-download',
        label: 'Force Download',
        icon: <DownloadIcon size={14} />,
        intent: 'success',
        disabled: (ids) =>
          strmSwitchLoading ||
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && meta.isStrm);
          }),
        onClick: () => {
          setPendingStrmVideoId(null);
          setStrmDownloadDialogOpen(true);
        },
      },
      {
        id: 'strm-revert',
        label: 'Switch to STRM',
        icon: <StrmIcon size={14} />,
        intent: 'warning',
        disabled: (ids) =>
          strmSwitchLoading ||
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && meta.isTracked && !meta.isStrm && !meta.removed);
          }),
        onClick: () => {
          setPendingStrmVideoId(null);
          setStrmRevertDialogOpen(true);
        },
      },
      {
        id: 'clear-metadata-cache',
        label: 'Clear Cached Metadata',
        icon: <MetadataCacheIcon size={14} />,
        intent: 'warning',
        disabled: (ids) =>
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && meta.hasCachedMetadata);
          }),
        onClick: () => setClearMetadataCacheDialogOpen(true),
      },
      {
        id: 'clear-cached-video',
        label: 'Clear Cached Video',
        icon: <CachedVideoIcon size={14} />,
        intent: 'warning',
        disabled: (ids) =>
          !ids.some((id) => {
            const meta = videoMetaRef.current.get(id);
            return Boolean(meta && meta.hasCachedVideo);
          }),
        onClick: () => setClearCachedVideoDialogOpen(true),
      },
    ],
    [deleteLoading, purgeLoading, strmSwitchLoading]
  );

  const selection = useVideoSelection<string>({ actions: selectionActions });

  // Clear selection when a filter changes so bulk actions can't fire on IDs that
  // are no longer in the filtered dataset. Sort and pagination are deliberately
  // excluded: they do not remove videos from the selection's eligible set.
  useEffect(() => {
    selection.clear();
  }, [
    listState.search,
    channelFilter,
    dateFrom,
    dateTo,
    maxRatingFilter,
    protectedFilter,
    missingFilter,
    watchedFilter,
    strmFilter,
    metadataCacheFilter,
    cachedVideoFilter,
    showUntracked,
    selection.clear,
  ]);

  const handleToggleSelect = (youtubeId: string) => {
    selection.toggle(youtubeId);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      selection.set(videos.map((v) => v.youtubeId));
    } else {
      selection.clear();
    }
  };

  const getDownloadCounts = () => {
    let missing = 0;
    let replace = 0;
    let unavailable = 0;
    for (const id of selection.selectedIds) {
      const meta = videoMetaRef.current.get(id);
      if (!meta) continue;
      if (meta.youtubeRemoved) {
        unavailable += 1;
      } else if (meta.removed) {
        missing += 1;
      } else {
        replace += 1;
      }
    }
    return { missing, replace, unavailable, eligible: missing + replace };
  };

  const downloadCounts = downloadDialogOpen
    ? getDownloadCounts()
    : { missing: 0, replace: 0, unavailable: 0, eligible: 0 };

  const getDeleteCounts = () => {
    let deletable = 0;
    let skipped = 0;
    for (const id of selection.selectedIds) {
      const meta = videoMetaRef.current.get(id);
      if (meta && meta.isTracked && !meta.removed) {
        deletable += 1;
      } else {
        skipped += 1;
      }
    }
    return { deletable, skipped };
  };
  const deleteCounts = getDeleteCounts();

  const getPurgeCounts = () => {
    let purgeable = 0;
    let skipped = 0;
    for (const id of selection.selectedIds) {
      const meta = videoMetaRef.current.get(id);
      if (meta && meta.isTracked && meta.removed) {
        purgeable += 1;
      } else {
        skipped += 1;
      }
    }
    return { purgeable, skipped };
  };
  const purgeCounts = getPurgeCounts();

  // The active STRM dialog acts on a single clicked video (pendingStrmVideoId,
  // a youtubeId) when set, otherwise the current bulk selection - see
  // pendingStrmVideoId's declaration above.
  const strmTargetIds = pendingStrmVideoId !== null ? [pendingStrmVideoId] : selection.selectedIds;

  const getStrmDownloadCounts = () => {
    let eligible = 0;
    let skipped = 0;
    for (const id of strmTargetIds) {
      const meta = videoMetaRef.current.get(id);
      if (meta && meta.isStrm) {
        eligible += 1;
      } else {
        skipped += 1;
      }
    }
    return { eligible, skipped };
  };
  const strmDownloadCounts = getStrmDownloadCounts();

  const getStrmRevertCounts = () => {
    let eligible = 0;
    let skipped = 0;
    for (const id of strmTargetIds) {
      const meta = videoMetaRef.current.get(id);
      if (meta && !meta.isStrm && !meta.removed) {
        eligible += 1;
      } else {
        skipped += 1;
      }
    }
    return { eligible, skipped };
  };
  const strmRevertCounts = getStrmRevertCounts();

  const handleStrmChipClick = (video: VideoData) => {
    setPendingStrmVideoId(video.youtubeId);
    if (deriveIsStrm(video)) {
      setStrmDownloadDialogOpen(true);
    } else {
      setStrmRevertDialogOpen(true);
    }
  };

  const handleStrmDownloadConfirm = async () => {
    setStrmDownloadDialogOpen(false);
    const isSingle = pendingStrmVideoId !== null;
    const eligibleIds = strmTargetIds
      .map((id) => videoMetaRef.current.get(id))
      .filter((meta): meta is VideoSelectionMeta => Boolean(meta && meta.id !== null && meta.isStrm))
      .map((meta) => meta.id as number);
    setPendingStrmVideoId(null);
    if (eligibleIds.length === 0) return;

    const result = await forceDownload(eligibleIds, token);
    if (result.success) {
      setSuccessMessage(
        `Queued ${result.processed.length} video${result.processed.length !== 1 ? 's' : ''} for download`
      );
      if (!isSingle) selection.clear();
      refetch();
    } else {
      const processedCount = result.processed.length;
      const failedCount = result.failed.length;
      if (processedCount > 0) {
        setSuccessMessage(
          `Queued ${processedCount} video${processedCount !== 1 ? 's' : ''}, but ${failedCount} failed`
        );
        if (!isSingle) selection.clear();
        refetch();
      } else {
        setErrorMessage(
          `Failed to queue download: ${result.failed[0]?.error || 'Unknown error'}`
        );
      }
    }
  };

  const handleStrmRevertConfirm = async () => {
    setStrmRevertDialogOpen(false);
    const isSingle = pendingStrmVideoId !== null;
    const eligibleIds = strmTargetIds
      .map((id) => videoMetaRef.current.get(id))
      .filter((meta): meta is VideoSelectionMeta => Boolean(meta && meta.id !== null && !meta.isStrm && !meta.removed))
      .map((meta) => meta.id as number);
    setPendingStrmVideoId(null);
    if (eligibleIds.length === 0) return;

    const result = await revertToStrm(eligibleIds, token);
    if (result.success) {
      setSuccessMessage(
        `Switched ${result.processed.length} video${result.processed.length !== 1 ? 's' : ''} back to STRM`
      );
      if (!isSingle) selection.clear();
      refetch();
    } else {
      const processedCount = result.processed.length;
      const failedCount = result.failed.length;
      if (processedCount > 0) {
        setSuccessMessage(
          `Switched ${processedCount} video${processedCount !== 1 ? 's' : ''} back to STRM, but ${failedCount} failed`
        );
        if (!isSingle) selection.clear();
        refetch();
      } else {
        setErrorMessage(
          `Failed to switch to STRM: ${result.failed[0]?.error || 'Unknown error'}`
        );
      }
    }
  };

  const getClearMetadataCacheCounts = () => {
    let eligible = 0;
    let skipped = 0;
    for (const id of selection.selectedIds) {
      const meta = videoMetaRef.current.get(id);
      if (meta && meta.hasCachedMetadata) {
        eligible += 1;
      } else {
        skipped += 1;
      }
    }
    return { eligible, skipped };
  };
  const clearMetadataCacheCounts = getClearMetadataCacheCounts();

  const getClearCachedVideoCounts = () => {
    let eligible = 0;
    let skipped = 0;
    for (const id of selection.selectedIds) {
      const meta = videoMetaRef.current.get(id);
      if (meta && meta.hasCachedVideo) {
        eligible += 1;
      } else {
        skipped += 1;
      }
    }
    return { eligible, skipped };
  };
  const clearCachedVideoCounts = getClearCachedVideoCounts();

  const handleClearMetadataCacheConfirm = async () => {
    setClearMetadataCacheDialogOpen(false);
    const eligibleIds = selection.selectedIds.filter((id) => {
      const meta = videoMetaRef.current.get(id);
      return Boolean(meta && meta.hasCachedMetadata);
    });
    if (eligibleIds.length === 0) return;

    const result = await cacheActions.bulkClearMetadataCache(eligibleIds);
    if (result.success) {
      setSuccessMessage(
        `Cleared cached metadata for ${eligibleIds.length - result.failed.length} video${eligibleIds.length !== 1 ? 's' : ''}`
      );
      selection.clear();
      refetch();
    } else {
      setErrorMessage('Failed to clear cached metadata');
    }
  };

  // Tracked rows' cached video is the STRM cache-on-play file - clearing it
  // means reverting to STRM (the existing useStrmSwitch endpoint), same
  // action as "Switch to STRM" but reached from the cache icon instead.
  // Untracked rows' cached video is a plain buffer-cache file - clearing it
  // is a direct delete via useCacheActions, no revert semantics apply.
  const handleClearCachedVideoConfirm = async () => {
    setClearCachedVideoDialogOpen(false);
    const eligibleMeta = selection.selectedIds
      .map((id) => videoMetaRef.current.get(id))
      .filter((meta): meta is VideoSelectionMeta => Boolean(meta && meta.hasCachedVideo));
    if (eligibleMeta.length === 0) return;

    const trackedIds = eligibleMeta.filter((m) => m.isTracked && m.id !== null).map((m) => m.id as number);
    const untrackedYoutubeIds = eligibleMeta.filter((m) => !m.isTracked).map((m) => m.youtubeId);

    const [strmResult, untrackedResult] = await Promise.all([
      trackedIds.length ? revertToStrm(trackedIds, token) : Promise.resolve(null),
      untrackedYoutubeIds.length ? cacheActions.bulkClearVideoCache(untrackedYoutubeIds) : Promise.resolve(null),
    ]);

    const clearedCount =
      (strmResult ? strmResult.processed.length : 0) +
      (untrackedResult ? untrackedYoutubeIds.length - untrackedResult.failed.length : 0);
    const failedCount = eligibleMeta.length - clearedCount;

    if (failedCount === 0) {
      setSuccessMessage(`Cleared cached video for ${clearedCount} video${clearedCount !== 1 ? 's' : ''}`);
    } else if (clearedCount > 0) {
      setSuccessMessage(`Cleared cached video for ${clearedCount} video${clearedCount !== 1 ? 's' : ''}, but ${failedCount} failed`);
    } else {
      setErrorMessage('Failed to clear cached video');
    }
    selection.clear();
    refetch();
  };

  const handleClearSingleCacheDetail = async () => {
    if (!cacheDetailTarget) return;
    setClearingCacheDetail(true);
    try {
      if (cacheDetailTarget.kind === 'metadata') {
        await cacheActions.clearMetadataCache(cacheDetailTarget.youtubeId);
      } else {
        const meta = videoMetaRef.current.get(cacheDetailTarget.youtubeId);
        if (meta && meta.isTracked && meta.id !== null) {
          await revertToStrm([meta.id], token);
        } else {
          await cacheActions.clearVideoCache(cacheDetailTarget.youtubeId);
        }
      }
      setCacheDetailTarget(null);
      refetch();
    } finally {
      setClearingCacheDetail(false);
    }
  };

  const handleOpenClearCachedRow = (video: VideoData) => setClearCachedRowTarget(video);

  // Untracked row's "delete" action - clears whichever cache types it has
  // (metadata and/or video) in one confirm, since there's no real library
  // row/file for the usual single-video delete to act on.
  const handleClearCachedRowConfirm = async () => {
    const video = clearCachedRowTarget;
    if (!video) return;
    setClearingCachedRow(true);
    try {
      await Promise.all([
        video.hasCachedMetadata ? cacheActions.clearMetadataCache(video.youtubeId) : Promise.resolve(),
        video.hasCachedVideo ? cacheActions.clearVideoCache(video.youtubeId) : Promise.resolve(),
      ]);
      setClearCachedRowTarget(null);
      refetch();
    } finally {
      setClearingCachedRow(false);
    }
  };

  const handleDownloadConfirm = async (settings: DownloadSettings | null) => {
    setDownloadDialogOpen(false);
    const eligible = selection.selectedIds
      .map((id) => videoMetaRef.current.get(id))
      .filter((meta): meta is VideoSelectionMeta => Boolean(meta && !meta.youtubeRemoved));
    if (eligible.length === 0) return;

    const urls = eligible.map((meta) => `https://www.youtube.com/watch?v=${meta.youtubeId}`);
    const videoChannelMap: Record<string, string> = {};
    for (const meta of eligible) {
      if (meta.channelId && YOUTUBE_CHANNEL_ID_PATTERN.test(meta.channelId)) {
        videoChannelMap[meta.youtubeId] = meta.channelId;
      }
    }
    const overrideSettings = settings
      ? {
          resolution: settings.resolution,
          allowRedownload: settings.allowRedownload,
          subfolder: settings.subfolder,
          audioFormat: settings.audioFormat,
          rating: settings.rating,
          skipVideoFolder: settings.skipVideoFolder,
        }
      : undefined;

    const success = await triggerDownloads({ urls, overrideSettings, videoChannelMap });
    if (!success) {
      setErrorMessage('Failed to queue selected videos for download. Please try again.');
      return;
    }
    selection.clear();
    navigate('/downloads/activity');
  };

  const handleDeleteSingleVideo = (videoId: number) => {
    const video = videos.find((v) => v.id === videoId);
    if (!video) return;
    selection.set([video.youtubeId]);
    setDeleteDialogOpen(true);
  };

  const handleToggleProtection = async (videoId: number) => {
    const video = videos.find((v) => v.id === videoId);
    if (!video) return;
    const currentState = video.protected || false;
    const newState = await toggleProtection(videoId, currentState);
    if (newState !== undefined) {
      setVideos((prev) =>
        prev.map((v) => (v.id === videoId ? { ...v, protected: newState } : v))
      );
    }
  };

  const handleOpenModal = (video: VideoData) => setModalVideo(video);

  const handleOpenCacheDetail = (youtubeId: string, kind: 'metadata' | 'video') =>
    setCacheDetailTarget({ youtubeId, kind });

  const swipeHandlers = useSwipeable({
    onSwipedLeft: () => {
      if (useInfiniteScroll) return;
      if (page < totalPages) setPage(page + 1);
    },
    onSwipedRight: () => {
      if (useInfiniteScroll) return;
      if (page > 1) setPage(page - 1);
    },
    trackMouse: true,
  });

  const withPageReset = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  const filterConfigs = useMemo<FilterConfig[]>(() => {
    return [
      {
        id: 'dateRangeString',
        dateFrom,
        dateTo,
        onFromChange: withPageReset(setDateFrom),
        onToChange: withPageReset(setDateTo),
      },
      { id: 'maxRating', value: maxRatingFilter, onChange: withPageReset(setMaxRatingFilter) },
      { id: 'protected', value: protectedFilter, onChange: withPageReset(setProtectedFilter) },
      { id: 'missing', value: missingFilter, onChange: withPageReset(setMissingFilter) },
      { id: 'watched', value: watchedFilter, onChange: withPageReset(setWatchedFilter) },
      { id: 'strm', value: strmFilter, onChange: withPageReset(setStrmFilter) },
      { id: 'metadataCache', value: metadataCacheFilter, onChange: withPageReset(setMetadataCacheFilter) },
      { id: 'cachedVideo', value: cachedVideoFilter, onChange: withPageReset(setCachedVideoFilter) },
      {
        id: 'channel',
        value: channelFilter,
        options: uniqueChannels,
        onChange: withPageReset(setChannelFilter),
      },
      { id: 'showUntracked', value: showUntracked, onChange: withPageReset(setShowUntracked) },
      // Pure display toggle - doesn't filter the dataset, so it doesn't reset
      // the page like the other filters above.
      { id: 'showFilePaths', value: showFilePaths, onChange: setShowFilePaths },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, maxRatingFilter, protectedFilter, missingFilter, watchedFilter, strmFilter, metadataCacheFilter, cachedVideoFilter, channelFilter, uniqueChannels, showUntracked, showFilePaths]);

  const sortConfig: SortConfig = useMemo(
    () => ({
      options: [
        { key: 'published', label: 'Published' },
        { key: 'added', label: 'Downloaded' },
      ],
      activeKey: orderBy,
      direction: sortOrder,
      onChange: (key, direction) => {
        setOrderBy(key as 'published' | 'added');
        setSortOrder(direction);
      },
    }),
    [orderBy, sortOrder]
  );

  const headerSlot = (
    <div style={{ padding: '12px 16px 0 16px' }}>
      <Typography variant={isMobile ? 'h6' : 'h5'} component="h2" gutterBottom align="center">
        Library ({totalVideos} total)
      </Typography>
      {showUntracked && (
        <Typography variant="caption" color="text.secondary" align="center" style={{ display: 'block' }}>
          Showing untracked cache-only videos — search and date filters don&apos;t apply to them.
        </Typography>
      )}
    </div>
  );

  const renderPageControls = (placement: 'top' | 'bottom') => (
    <VideoListPaginationBar
      placement={placement}
      hasContent={totalVideos > 0}
      useInfiniteScroll={useInfiniteScroll}
      page={page}
      totalPages={totalPages}
      onPageChange={(newPage) => setPage(newPage)}
      pageSize={videosPerPage}
      onPageSizeChange={handlePageSizeChange}
      isMobile={isMobile}
    />
  );

  const paginationNode = renderPageControls('bottom');
  const paginationTopNode = renderPageControls('top');

  const infiniteSentinel = useInfiniteScroll ? (
    <>
      <div
        ref={loadMoreRef}
        style={{ height: 24, width: '100%', marginTop: 12, marginBottom: 16 }}
      />
      {loading && videos.length > 0 && page < totalPages && (
        <Box style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 16px 0' }}>
          <Typography variant="caption" color="text.secondary">
            Loading more videos...
          </Typography>
        </Box>
      )}
      {!loading && page >= totalPages && videos.length > 0 && (
        <Typography
          variant="caption"
          color="text.secondary"
          align="center"
          style={{ display: 'block', paddingBottom: 12 }}
        >
          You&apos;re all caught up.
        </Typography>
      )}
    </>
  ) : null;

  const renderContent = (mode: VideoListViewMode) => {
    if (mode === 'grid') {
      return (
        <Grid container spacing={2}>
          {videos.map((video) => (
            <Grid item xs={12} sm={6} md={4} lg={3} key={video.youtubeId}>
              <VideoCard
                video={video}
                selected={selection.isSelected(video.youtubeId)}
                enabledChannels={enabledChannels}
                imageErrored={Boolean(imageErrors[video.youtubeId])}
                deleteDisabled={deleteLoading}
                onToggleSelect={handleToggleSelect}
                onOpenModal={handleOpenModal}
                onToggleProtection={handleToggleProtection}
                onDeleteSingle={handleDeleteSingleVideo}
                onImageError={handleImageError}
                onAddChannel={handleAddChannel}
                onOpenCacheDetail={handleOpenCacheDetail}
                onClearCachedRow={handleOpenClearCachedRow}
                showFilePath={showFilePaths}
              />
            </Grid>
          ))}
        </Grid>
      );
    }
    if (mode === 'list') {
      return (
        <VideosListMobile
          videos={videos}
          selectedVideos={selection.selectedIds}
          enabledChannels={enabledChannels}
          imageErrors={imageErrors}
          onToggleSelect={handleToggleSelect}
          onOpenModal={handleOpenModal}
          onToggleProtection={handleToggleProtection}
          onImageError={handleImageError}
          onAddChannel={handleAddChannel}
          showFilePath={showFilePaths}
        />
      );
    }
    return (
      <VideosTable
        videos={videos}
        selectedVideos={selection.selectedIds}
        enabledChannels={enabledChannels}
        imageErrors={imageErrors}
        orderBy={orderBy}
        sortOrder={sortOrder}
        deleteDisabled={deleteLoading}
        onSelectAll={handleSelectAll}
        onToggleSelect={handleToggleSelect}
        onSortChange={handleSortChange}
        onOpenModal={handleOpenModal}
        onToggleProtection={handleToggleProtection}
        onDeleteSingle={handleDeleteSingleVideo}
        onStrmChipClick={handleStrmChipClick}
        onImageError={handleImageError}
        onAddChannel={handleAddChannel}
        onOpenCacheDetail={handleOpenCacheDetail}
        onClearCachedRow={handleOpenClearCachedRow}
        showFilePaths={showFilePaths}
      />
    );
  };

  // Hide Sort in table view (table has column sort)
  const activeSort = listState.viewMode === 'table' && !isMobile ? undefined : sortConfig;

  const availableViewModes: VideoListViewMode[] = isMobile
    ? ['grid', 'list']
    : ['grid', 'table'];

  useEffect(() => {
    if (!availableViewModes.includes(listState.viewMode)) {
      listState.setViewMode(isMobile ? 'list' : 'table');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, listState.viewMode]);

  return (
    <Box>
      <VideoListContainer
        state={listState}
        selection={selection}
        viewModes={availableViewModes}
        filters={filterConfigs}
        sort={activeSort}
        searchPlaceholder="Search videos by name or channel..."
        headerSlot={headerSlot}
        itemCount={videos.length}
        isLoading={loading}
        isError={Boolean(loadError)}
        errorMessage={loadError}
        renderContent={(mode) => <div {...swipeHandlers}>{renderContent(mode)}</div>}
        pagination={paginationNode}
        paginationTop={paginationTopNode}
        paginationMode={useInfiniteScroll ? 'infinite' : 'pages'}
        infiniteScrollSentinel={infiniteSentinel}
        isMobile={isMobile}
      />

      <DeleteVideosDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        onConfirm={() => handleDeleteConfirm(selection.selectedIds)}
        videoCount={deleteCounts.deletable}
        skippedCount={deleteCounts.skipped}
      />

      <PurgeVideosDialog
        open={purgeDialogOpen}
        onClose={() => setPurgeDialogOpen(false)}
        onConfirm={() => handlePurgeConfirm(selection.selectedIds)}
        videoCount={purgeCounts.purgeable}
        skippedCount={purgeCounts.skipped}
      />

      <StrmDownloadDialog
        open={strmDownloadDialogOpen}
        onClose={() => {
          setStrmDownloadDialogOpen(false);
          setPendingStrmVideoId(null);
        }}
        onConfirm={handleStrmDownloadConfirm}
        videoCount={strmDownloadCounts.eligible}
        skippedCount={strmDownloadCounts.skipped}
      />

      <StrmRevertDialog
        open={strmRevertDialogOpen}
        onClose={() => {
          setStrmRevertDialogOpen(false);
          setPendingStrmVideoId(null);
        }}
        onConfirm={handleStrmRevertConfirm}
        videoCount={strmRevertCounts.eligible}
        skippedCount={strmRevertCounts.skipped}
      />

      <ChangeRatingDialog
        open={ratingDialogOpen}
        onClose={() => setRatingDialogOpen(false)}
        onApply={(rating) => handleApplyRating(rating, selection.selectedIds)}
        selectedCount={selection.count}
      />

      <ClearCachedMetadataDialog
        open={clearMetadataCacheDialogOpen}
        onClose={() => setClearMetadataCacheDialogOpen(false)}
        onConfirm={handleClearMetadataCacheConfirm}
        videoCount={clearMetadataCacheCounts.eligible}
        skippedCount={clearMetadataCacheCounts.skipped}
      />

      <ClearCachedVideoDialog
        open={clearCachedVideoDialogOpen}
        onClose={() => setClearCachedVideoDialogOpen(false)}
        onConfirm={handleClearCachedVideoConfirm}
        videoCount={clearCachedVideoCounts.eligible}
        skippedCount={clearCachedVideoCounts.skipped}
      />

      {cacheDetailTarget && (() => {
        const targetVideo = videos.find((v) => v.youtubeId === cacheDetailTarget.youtubeId);
        if (!targetVideo) return null;
        return (
          <CacheDetailDialog
            open
            onClose={() => setCacheDetailTarget(null)}
            video={targetVideo}
            kind={cacheDetailTarget.kind}
            token={token}
            onClear={handleClearSingleCacheDetail}
            clearing={clearingCacheDetail}
            onRefreshed={refetch}
          />
        );
      })()}

      {clearCachedRowTarget && (
        <ClearCachedRowDialog
          open
          onClose={() => setClearCachedRowTarget(null)}
          onConfirm={handleClearCachedRowConfirm}
          title={clearCachedRowTarget.youTubeVideoName}
          hasCachedMetadata={Boolean(clearCachedRowTarget.hasCachedMetadata)}
          hasCachedVideo={Boolean(clearCachedRowTarget.hasCachedVideo)}
          clearing={clearingCachedRow}
        />
      )}

      <DownloadSettingsDialog
        open={downloadDialogOpen}
        onClose={() => setDownloadDialogOpen(false)}
        onConfirm={handleDownloadConfirm}
        videoCount={downloadCounts.eligible}
        missingVideoCount={downloadCounts.missing}
        replaceVideoCount={downloadCounts.replace}
        unavailableVideoCount={downloadCounts.unavailable}
        defaultResolution={configState?.config?.preferredResolution || '1080'}
        defaultResolutionSource="global"
        mode="manual"
        token={token}
      />

      <Snackbar
        open={successMessage !== null}
        autoHideDuration={6000}
        onClose={() => setSuccessMessage(null)}
      >
        <Alert onClose={() => setSuccessMessage(null)} severity="success">
          {successMessage}
        </Alert>
      </Snackbar>

      <Snackbar
        open={errorMessage !== null}
        autoHideDuration={6000}
        onClose={() => setErrorMessage(null)}
      >
        <Alert onClose={() => setErrorMessage(null)} severity="error">
          {errorMessage}
        </Alert>
      </Snackbar>

      <Snackbar
        open={protectionSuccess !== null}
        autoHideDuration={4000}
        onClose={clearProtectionMessages}
      >
        <Alert onClose={clearProtectionMessages} severity="success">
          {protectionSuccess}
        </Alert>
      </Snackbar>
      <Snackbar
        open={protectionError !== null}
        autoHideDuration={4000}
        onClose={clearProtectionMessages}
      >
        <Alert onClose={clearProtectionMessages} severity="error">
          {protectionError}
        </Alert>
      </Snackbar>

      {modalVideo && (
        <VideoModal
          open
          onClose={() => setModalVideo(null)}
          video={videoDataToModalData(modalVideo)}
          token={token}
          onVideoDeleted={() => {
            setModalVideo(null);
            refetch();
          }}
          onProtectionChanged={(youtubeId, isProtected) => {
            setVideos((prev) =>
              prev.map((v) =>
                v.youtubeId === youtubeId ? { ...v, protected: isProtected } : v
              )
            );
          }}
          onRatingChanged={(youtubeId, rating) => {
            setVideos((prev) =>
              prev.map((v) =>
                v.youtubeId === youtubeId
                  ? {
                      ...v,
                      normalized_rating: rating,
                      rating_source: rating ? 'Manual Override' : null,
                    }
                  : v
              )
            );
          }}
        />
      )}

      {addChannelTarget && (
        <AddChannelDialog
          open
          onClose={() => setAddChannelTarget(null)}
          channelName={addChannelTarget.name}
          channelUrl={addChannelTarget.url}
        />
      )}
    </Box>
  );
}

export default VideosPage;
