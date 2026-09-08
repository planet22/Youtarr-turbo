import React, { useMemo, useRef, useState } from 'react';
import {
  Grid,
  Table,
  TableContainer,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  Typography,
  IconButton,
  Box,
  Collapse,
  Link,
} from '../ui';
import { ChevronDown, Eye as ShowEmptyIcon } from 'lucide-react';
import { Job, FailedVideo } from '../../types/Job';
import { VideoData } from '../../types/VideoData';
import { formatDownloadSpeed } from '../../utils/formatters';
import { useSwipeable } from 'react-swipeable';
import { useConfig } from '../../hooks/useConfig';
import VideoModal from '../shared/VideoModal';
import { VideoModalData } from '../shared/VideoModal/types';
import VideoThumbnail from './VideoThumbnail';
import MissingVideoChip from './MissingVideoChip';
import FailedVideoChip from './FailedVideoChip';
import FailedDownloadsDetail from './FailedDownloadsDetail';
import TerminatedChannelsDetail from './TerminatedChannelsDetail';
import {
  useListPageSize,
  useVideoListState,
  VideoListContainer,
  VideoListPaginationBar,
  type FilterConfig,
} from '../shared/VideoList';

interface DownloadHistoryProps {
  jobs: Job[];
  currentTime: Date;
  expanded: Record<string, boolean>;
  handleExpandCell: (id: string) => void;
  isMobile: boolean;
  token?: string | null;
  onVideoDeleted?: () => void;
}

function cleanJobTypeLabel(jobType: string): string {
  if (jobType.startsWith('Auto-retry')) return 'Auto-retry';
  if (jobType.includes('Channel Downloads')) return 'Channel Downloads';
  if (jobType.includes('Manually Added Urls')) {
    const apiKeyMatch = jobType.match(/\(via API: (.+)\)/);
    return apiKeyMatch ? `Manual Videos (API: ${apiKeyMatch[1]})` : 'Manual Videos';
  }
  if (jobType.startsWith('Sonarr/Radarr: ')) {
    const match = jobType.match(/^Sonarr\/Radarr: (.+?) \[(.+)\]$/);
    return match ? `NZB grab (${match[1]}): ${match[2]}` : 'NZB grab';
  }
  if (jobType.startsWith('STRM Cache: ')) return 'STRM Cache-on-play';
  if (jobType.startsWith('HLS Buffer Cache: ')) return 'HLS Buffer Cache';
  return jobType;
}

// Shared with the "Source" column and its filter dropdown, so the filter's
// option list always matches exactly what's displayed in that column.
function getJobSourceLabel(jobType: string): string {
  if (jobType.startsWith('Auto-retry')) return 'Auto-retry';
  if (jobType.includes('Channel Downloads')) return 'Channels';
  if (jobType.includes('Manually Added Urls')) {
    const apiKeyMatch = jobType.match(/\(via API: (.+)\)/);
    return apiKeyMatch ? `API: ${apiKeyMatch[1]}` : 'Manual Videos';
  }
  if (jobType === 'Playlist Downloads' || jobType.startsWith('Playlist: ')) return 'Playlists';
  if (jobType.startsWith('Sonarr/Radarr: ')) {
    const categoryMatch = jobType.match(/^Sonarr\/Radarr: (.+?) \[/);
    return categoryMatch ? `NZB (${categoryMatch[1]})` : 'NZB';
  }
  if (jobType.startsWith('STRM Cache: ')) return 'STRM Cache-on-play';
  if (jobType.startsWith('HLS Buffer Cache: ')) return 'HLS Buffer Cache';
  return 'Other';
}

// NZB-grab jobs (server/routes/nzb.js) are always single-video, but when the
// video's own JobVideo/Video rows are unavailable - e.g. an 'untracked'
// import strategy already removed them once Sonarr/Radarr imported the file -
// job.data.videos comes back empty even though we still know which video and
// title this job was for (job.data.nzb). Without this, the row falls back to
// cleanJobTypeLabel's raw jobType text (which only has the youtube id, not
// the title) and no thumbnail. Marked non-interactive by callers since there
// is no real database row behind it to open in VideoModal.
function nzbFallbackVideo(job: Job): VideoData | null {
  const nzb = job.data?.nzb;
  if (!nzb?.youtubeId) return null;
  return {
    id: 0,
    youtubeId: nzb.youtubeId,
    youTubeChannelName: '',
    youTubeVideoName: nzb.nzbName || nzb.youtubeId,
    timeCreated: '',
    originalDate: null,
    duration: null,
    description: null,
  };
}

// Rotates a single chevron rather than swapping two icon components, so the
// toggle reads as one continuous motion instead of a hard cut.
const ExpandChevron: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <ChevronDown
    style={{
      transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
      transition: 'transform 300ms var(--transition-bouncy, cubic-bezier(0.34,1.56,0.64,1))',
    }}
  />
);

function fileNameOf(filePath?: string | null): string | null {
  if (!filePath) return null;
  const normalized = filePath.replace(/\\/g, '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name || null;
}

// Failures handed off to an auto-retry job report their final outcome on the
// retry job's row; showing them here too would double-count them.
function getDisplayableFailedVideos(job: Job): FailedVideo[] {
  return (job.data?.failedVideos || []).filter((video) => !video.autoRetryQueued);
}

function getDiagnosisTitles(job: Job): string[] {
  return (job.data?.diagnoses || []).map((diagnosis) => diagnosis.title);
}

// mm:ss for under an hour, h:mm otherwise - mirrors the live "In Progress"
// timer's format but doesn't wrap at 60 minutes the way that one does.
function formatJobDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

// How long a completed job actually ran for - only available once the
// finalizer has stamped data.endDate (older/in-flight jobs won't have it).
function jobDurationText(job: Job): string | null {
  if (job.status === 'In Progress' || !job.data?.endDate) return null;
  const start = new Date(job.timeInitiated).getTime();
  const end = new Date(job.data.endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return formatJobDurationMs(end - start);
}

// Zero-padded local date key (YYYY-MM-DD) matching the <input type="date">
// values DateRangeStringFilter works with, so lexical comparison sorts
// correctly without a timezone-shifting toISOString() round trip.
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Everything a text search should be able to match for a job: its videos'
// titles/channels, the nzb fallback title, and the raw job type text.
function jobSearchBlob(job: Job): string {
  const videos = job.data?.videos || [];
  const parts = [
    job.jobType,
    job.data?.nzb?.nzbName,
    ...videos.map((v) => v.youTubeVideoName),
    ...videos.map((v) => v.youTubeChannelName),
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function jobVideoToModalData(video: VideoData): VideoModalData {
  const isDownloaded = Boolean(video.filePath || video.audioFilePath) && !video.removed;
  const status: VideoModalData['status'] = video.removed
    ? 'missing'
    : isDownloaded
    ? 'downloaded'
    : 'never_downloaded';
  return {
    youtubeId: video.youtubeId,
    title: video.youTubeVideoName,
    channelName: video.youTubeChannelName,
    thumbnailUrl: `/images/videothumb-${video.youtubeId}.jpg`,
    duration: video.duration,
    publishedAt: video.originalDate || null,
    addedAt: video.timeCreated || null,
    mediaType: video.media_type || 'video',
    status,
    isDownloaded,
    isStrm: Boolean((video as { is_strm?: boolean }).is_strm) ||
      (typeof video.filePath === 'string' && video.filePath.toLowerCase().endsWith('.strm')),
    filePath: video.filePath || null,
    fileSize: video.fileSize ? Number(video.fileSize) : null,
    audioFilePath: video.audioFilePath || null,
    audioFileSize: video.audioFileSize ? Number(video.audioFileSize) : null,
    isProtected: video.protected || false,
    isIgnored: false,
    normalizedRating: video.normalized_rating || null,
    ratingSource: video.rating_source || null,
    databaseId: video.id,
    channelId: video.channel_id || null,
  };
}

const DownloadHistory: React.FC<DownloadHistoryProps> = ({
  jobs,
  currentTime,
  expanded,
  handleExpandCell,
  isMobile,
  token = null,
  onVideoDeleted,
}) => {
  const [modalVideo, setModalVideo] = useState<VideoData | null>(null);
  const [showNoVideoJobs, setShowNoVideoJobs] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [currentPage, setCurrentPage] = useState(1);
  // Same shared page-size control/values (and localStorage persistence) as
  // the Videos/Library page.
  const [itemsPerPage, setItemsPerPage] = useListPageSize('youtarr.downloadHistory.pageSize');
  const [visibleCount, setVisibleCount] = useState<number>(itemsPerPage);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const { config } = useConfig(token);
  const useInfiniteScroll = config.channelVideosHotLoad ?? false;

  // Same search box / filters button+badge / active-filter chips chrome the
  // Videos and Streaming pages use, for a consistent filtering experience
  // across list-style pages even though this one isn't listing videos.
  const listState = useVideoListState({ initialViewMode: 'table' });

  const handleImageError = (youtubeId: string) => {
    setImageErrors((prev) => ({ ...prev, [youtubeId]: true }));
  };

  const jobsForSourceOptions = jobs.filter((job) => !job.jobType?.includes('Import Subscriptions'));
  const sourceOptions = Array.from(
    new Set(jobsForSourceOptions.map((job) => getJobSourceLabel(job.jobType)))
  ).sort();
  const statusOptions = Array.from(
    new Set(jobsForSourceOptions.map((job) => job.status))
  ).sort();

  const normalizedSearch = listState.search.trim().toLowerCase();

  const jobsToDisplay = jobsForSourceOptions
    .filter((job) => (sourceFilter ? getJobSourceLabel(job.jobType) === sourceFilter : true))
    .filter((job) => (statusFilter ? job.status === statusFilter : true))
    .filter((job) => (normalizedSearch ? jobSearchBlob(job).includes(normalizedSearch) : true))
    .filter((job) => {
      if (!dateFrom && !dateTo) return true;
      const key = dateKey(new Date(job.timeCreated));
      if (dateFrom && key < dateFrom) return false;
      if (dateTo && key > dateTo) return false;
      return true;
    })
    .filter((job) => {
      if (showNoVideoJobs) {
        return true;
      }

      if (!job.data?.videos) {
        return true;
      }

      // NZB-grab jobs whose Video row was already deleted (Sonarr/Radarr's
      // 'untracked' import strategy) legitimately have an empty videos
      // array, but job.data.nzb still carries enough (youtubeId/title) to
      // render a real row via nzbFallbackVideo - hiding those by default
      // would throw away a displayable job just because its DB row is gone.
      if (job.data?.nzb?.youtubeId) {
        return true;
      }

      return job.data.videos.length > 0 || getDisplayableFailedVideos(job).length > 0;
    });

  const hasActiveFilters = Boolean(sourceFilter || statusFilter || dateFrom || dateTo || showNoVideoJobs);

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      { id: 'select', label: 'Source', value: sourceFilter, options: sourceOptions, onChange: setSourceFilter },
      { id: 'select', label: 'Status', value: statusFilter, options: statusOptions, onChange: setStatusFilter },
      // Jobs have no "published date" of their own (a job can cover several
      // videos) - this filters job.timeCreated, i.e. when the job actually
      // ran, so it's labeled "Downloaded" rather than the shared filter's
      // video-page-oriented "Published" default.
      { id: 'dateRangeString', label: 'Downloaded', dateFrom, dateTo, onFromChange: setDateFrom, onToChange: setDateTo },
      {
        id: 'toggle',
        label: 'Show jobs with no videos',
        icon: <ShowEmptyIcon size={16} />,
        value: showNoVideoJobs,
        onChange: setShowNoVideoJobs,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sourceFilter, sourceOptions.join('|'), statusFilter, statusOptions.join('|'), dateFrom, dateTo, showNoVideoJobs]
  );

  const totalPages = Math.max(1, Math.ceil(jobsToDisplay.length / itemsPerPage));
  const hasMoreHotLoadItems = visibleCount < jobsToDisplay.length;
  const currentJobs = useMemo(() => {
    if (useInfiniteScroll) {
      return jobsToDisplay.slice(0, visibleCount);
    }

    const indexOfLastJob = currentPage * itemsPerPage;
    const indexOfFirstJob = indexOfLastJob - itemsPerPage;
    return jobsToDisplay.slice(indexOfFirstJob, indexOfLastJob);
  }, [useInfiniteScroll, jobsToDisplay, visibleCount, currentPage, itemsPerPage]);

  React.useEffect(() => {
    setCurrentPage(1);
    setVisibleCount(itemsPerPage);
  }, [showNoVideoJobs, sourceFilter, statusFilter, normalizedSearch, dateFrom, dateTo, itemsPerPage]);

  React.useEffect(() => {
    if (!useInfiniteScroll) {
      return;
    }
    if (!loadMoreRef.current || !hasMoreHotLoadItems) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (entry.isIntersecting) {
          setVisibleCount((prev) => Math.min(prev + itemsPerPage, jobsToDisplay.length));
        }
      },
      {
        root: null,
        rootMargin: '0px 0px 180px 0px',
        threshold: 0,
      }
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [useInfiniteScroll, hasMoreHotLoadItems, itemsPerPage, jobsToDisplay.length]);

  const handlers = useSwipeable({
    onSwipedLeft: () => {
      if (currentPage < totalPages) setCurrentPage((p) => p + 1);
    },
    onSwipedRight: () => {
      if (currentPage > 1) setCurrentPage((p) => p - 1);
    },
    trackMouse: true,
  });

  const modalElement = modalVideo ? (
    <VideoModal
      open
      onClose={() => setModalVideo(null)}
      video={jobVideoToModalData(modalVideo)}
      token={token}
      onVideoDeleted={() => {
        setModalVideo(null);
        onVideoDeleted?.();
      }}
    />
  ) : null;

  const renderMobileJobs = () => (
    <Box {...handlers}>
      <Box className="flex flex-col gap-2.5">
        {currentJobs.map((job) => {
          const isExpanded = !!expanded[job.id];

          const videos = job.data?.videos || [];
          const isCompletedWithNoVideos = videos.length === 0 && job.status !== 'In Progress';

          let durationString = '';
          if (job.status !== 'In Progress') {
            durationString = isCompletedWithNoVideos ? `${job.status} - no new videos` : job.status;
            const ranFor = jobDurationText(job);
            if (ranFor) durationString += ` (${ranFor})`;
          } else {
            const jobStartTime = new Date(job.timeInitiated).getTime();
            const duration = new Date(currentTime.getTime() - jobStartTime);
            const mm = String(duration.getUTCMinutes()).padStart(2, '0');
            const ss = String(duration.getUTCSeconds()).padStart(2, '0');
            durationString = `${mm}m${ss}s`;
          }

          const timeCreated = new Date(job.timeCreated);
          const month = String(timeCreated.getMonth() + 1).padStart(2, '0');
          const day = String(timeCreated.getDate()).padStart(2, '0');
          const minutes = String(timeCreated.getMinutes()).padStart(2, '0');
          let hours = timeCreated.getHours();
          const period = hours >= 12 ? 'PM' : 'AM';

          const formattedJobType = getJobSourceLabel(job.jobType);

          hours = hours % 12;
          hours = hours ? hours : 12;
          const formattedTimeCreated = `${month}-${day} ${hours}:${minutes} ${period}`;

          const nzbFallback = videos.length === 0 ? nzbFallbackVideo(job) : null;
          const singleVideo = videos[0] || nzbFallback || undefined;
          const isNzbFallback = !videos[0] && !!nzbFallback;
          const hasMultiple = videos.length > 1;
          const titleText = singleVideo?.youTubeVideoName || (hasMultiple ? `Multiple (${videos.length})` : cleanJobTypeLabel(job.jobType));
          const channelText = !hasMultiple && !isNzbFallback ? singleVideo?.youTubeChannelName : undefined;
          const showThumbnail = !hasMultiple && !!singleVideo;
          const missingCount = videos.filter((v: VideoData) => v.removed).length;
          const failedForJob = getDisplayableFailedVideos(job);
          const terminatedChannels = job.data?.terminatedChannels || [];
          const terminationFailures = job.data?.terminationFailures || [];
          const skippedCount = job.data?.cumulativeSkipped || 0;
          const hasExpandable = hasMultiple || failedForJob.length > 0 || terminatedChannels.length > 0 || terminationFailures.length > 0;

          return (
            <Box
              key={job.id}
              style={{ border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}
              className="p-3"
            >
              <Box className="flex items-start justify-between gap-2">
                <Box className="flex items-center gap-2 flex-wrap min-w-0">
                  <Typography variant="subtitle2" className="font-semibold">
                    {hasMultiple ? (
                      `Multiple (${videos.length})`
                    ) : singleVideo ? (
                      isNzbFallback ? (
                        singleVideo.youTubeVideoName
                      ) : (
                        <Link
                          component="button"
                          type="button"
                          onClick={() => setModalVideo(singleVideo)}
                          style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
                        >
                          {singleVideo.youTubeVideoName}
                        </Link>
                      )
                    ) : (
                      titleText
                    )}
                  </Typography>
                  {hasMultiple && missingCount > 0 && (
                    <MissingVideoChip
                      label={`${missingCount} missing`}
                      tooltip={`${missingCount} of ${videos.length} video files not found on disk`}
                    />
                  )}
                  {failedForJob.length > 0 && (
                    <FailedVideoChip
                      count={failedForJob.length}
                      diagnosisTitles={getDiagnosisTitles(job)}
                    />
                  )}
                </Box>
                {hasExpandable && (
                  <IconButton size="small" onClick={() => handleExpandCell(job.id)}>
                    <ExpandChevron expanded={isExpanded} />
                  </IconButton>
                )}
              </Box>

              {channelText && (
                <Typography variant="caption" color="secondary" className="mt-0.5 block">
                  {channelText}
                </Typography>
              )}
              {!hasMultiple && fileNameOf(singleVideo?.filePath) && (
                <Typography variant="caption" color="secondary" className="mt-0.5 block" style={{ opacity: 0.75, wordBreak: 'break-all' }}>
                  {fileNameOf(singleVideo?.filePath)}
                </Typography>
              )}
              {job.data?.notes && (
                <Typography variant="caption" className="mt-0.5 block" style={{ color: 'var(--destructive)' }}>
                  {job.data.notes}
                </Typography>
              )}
              {skippedCount > 0 && (
                <Typography variant="caption" color="secondary" className="mt-0.5 block">
                  {skippedCount} already downloaded (skipped)
                </Typography>
              )}

              <Box className="mt-2 flex items-start gap-3">
                {showThumbnail && singleVideo && (
                  <VideoThumbnail
                    video={singleVideo}
                    width={96}
                    height={72}
                    onClick={isNzbFallback ? () => {} : () => setModalVideo(singleVideo)}
                    hasError={!!imageErrors[singleVideo.youtubeId]}
                    onError={() => handleImageError(singleVideo.youtubeId)}
                    iconSize={24}
                  />
                )}

                {hasMultiple ? (
                  <Box className="min-w-0 flex flex-1 flex-col gap-0.5">
                    <Box className="flex items-baseline gap-1 flex-wrap">
                      <Typography variant="caption" color="secondary">Date:</Typography>
                      <Typography variant="caption" className="font-medium">{formattedTimeCreated}</Typography>
                    </Box>
                    <Box className="flex items-baseline gap-x-4 gap-y-0.5 flex-wrap">
                      {formattedJobType && (
                        <Box className="flex items-baseline gap-1">
                          <Typography variant="caption" color="secondary">Source:</Typography>
                          <Typography variant="caption" className="font-medium">{formattedJobType}</Typography>
                        </Box>
                      )}
                      <Box className="flex items-baseline gap-1">
                        <Typography variant="caption" color="secondary">Status:</Typography>
                        <Typography variant="caption" className="font-medium">{durationString}</Typography>
                      </Box>
                    </Box>
                  </Box>
                ) : (
                  <Box className="min-w-0 flex flex-1 flex-col gap-0.5">
                    <Typography variant="caption" color="secondary">
                      Date: {formattedTimeCreated}
                    </Typography>
                    {formattedJobType && (
                      <Typography variant="caption" color="secondary">
                        Source: {formattedJobType}
                      </Typography>
                    )}
                    <Typography variant="caption" color="secondary">
                      Status: {durationString}
                    </Typography>
                    {singleVideo && formatDownloadSpeed(singleVideo.avgDownloadMBps) && (
                      <Typography variant="caption" color="secondary">
                        Speed: {formatDownloadSpeed(singleVideo.avgDownloadMBps)}
                      </Typography>
                    )}
                  </Box>
                )}
              </Box>

              {hasExpandable && (
                <Collapse in={isExpanded} timeout="auto" unmountOnExit fancy>
                  <Box className="mt-1.5 flex flex-col gap-1.5">
                    {videos.map((video: VideoData) => (
                      <Box key={video.youtubeId} className="flex flex-col">
                        <Link
                          component="button"
                          type="button"
                          onClick={() => setModalVideo(video)}
                          style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
                        >
                          {video.youTubeVideoName}
                        </Link>
                        <Box className="flex items-center gap-2 flex-wrap">
                          <Typography variant="caption" color="secondary">
                            {video.youTubeChannelName}
                          </Typography>
                          {formatDownloadSpeed(video.avgDownloadMBps) && (
                            <Typography variant="caption" color="secondary">
                              {formatDownloadSpeed(video.avgDownloadMBps)}
                            </Typography>
                          )}
                          {video.removed && <MissingVideoChip />}
                        </Box>
                      </Box>
                    ))}
                    <FailedDownloadsDetail
                      failedVideos={failedForJob}
                      diagnoses={job.data?.diagnoses}
                    />
                    <TerminatedChannelsDetail
                      terminatedChannels={terminatedChannels}
                      terminationFailures={terminationFailures}
                    />
                  </Box>
                </Collapse>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );

  const renderDesktopTable = () => (
    <TableContainer>
      <div {...handlers}>
        <Table>
          <TableHead>
            <TableRow>
              <TableCell>Date / Time</TableCell>
              <TableCell>Title</TableCell>
              <TableCell>Source</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Speed</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {currentJobs.map((job) => {
              const isExpanded = !!expanded[job.id];

              const videos = job.data?.videos || [];
              const isCompletedWithNoVideos = videos.length === 0 && job.status !== 'In Progress';

              let durationString = '';
              if (job.status !== 'In Progress') {
                durationString = isCompletedWithNoVideos ? `${job.status} - no new videos` : job.status;
                const ranFor = jobDurationText(job);
                if (ranFor) durationString += ` (${ranFor})`;
              } else {
                const jobStartTime = new Date(job.timeInitiated).getTime();
                const duration = new Date(currentTime.getTime() - jobStartTime);
                const mm = String(duration.getUTCMinutes()).padStart(2, '0');
                const ss = String(duration.getUTCSeconds()).padStart(2, '0');
                durationString = `${mm}m${ss}s`;
              }

              const timeCreated = new Date(job.timeCreated);
              const month = String(timeCreated.getMonth() + 1).padStart(2, '0');
              const day = String(timeCreated.getDate()).padStart(2, '0');
              const minutes = String(timeCreated.getMinutes()).padStart(2, '0');
              let hours = timeCreated.getHours();
              const period = hours >= 12 ? 'PM' : 'AM';

              const formattedJobType = getJobSourceLabel(job.jobType);

              hours = hours % 12;
              hours = hours ? hours : 12;
              const formattedTimeCreated = `${month}-${day} ${hours}:${minutes} ${period}`;

              const failedForJob = getDisplayableFailedVideos(job);
              const terminatedChannels = job.data?.terminatedChannels || [];
              const terminationFailures = job.data?.terminationFailures || [];
              const skippedCount = job.data?.cumulativeSkipped || 0;

              if (videos.length > 1 || failedForJob.length > 0 || terminatedChannels.length > 0 || terminationFailures.length > 0) {
                const missingCount = videos.filter((v: VideoData) => v.removed).length;
                const summaryLabel = videos.length > 1
                  ? `Multiple (${videos.length})`
                  : videos[0]?.youTubeVideoName || cleanJobTypeLabel(job.jobType);
                return (
                  <React.Fragment key={job.id}>
                    <TableRow hover onClick={() => handleExpandCell(job.id)}>
                      <TableCell>{formattedTimeCreated}</TableCell>
                      <TableCell>
                        <Box className="flex items-center gap-2 flex-wrap">
                          <span>{summaryLabel}</span>
                          {missingCount > 0 && (
                            <MissingVideoChip
                              label={`${missingCount} missing`}
                              tooltip={`${missingCount} of ${videos.length} video files not found on disk`}
                            />
                          )}
                          {failedForJob.length > 0 && (
                            <FailedVideoChip
                              count={failedForJob.length}
                              diagnosisTitles={getDiagnosisTitles(job)}
                            />
                          )}
                        </Box>
                        {job.data?.notes && (
                          <Typography variant="caption" className="block" style={{ color: 'var(--destructive)' }}>
                            {job.data.notes}
                          </Typography>
                        )}
                        {skippedCount > 0 && (
                          <Typography variant="caption" color="secondary" className="block">
                            {skippedCount} already downloaded (skipped)
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{formattedJobType}</TableCell>
                      <TableCell>{durationString}</TableCell>
                      {/* Blank at the summary-row level - this rolls up multiple
                          videos, each with its own speed; see the per-video Speed
                          cell in the expanded sub-table below instead. */}
                      <TableCell />
                      <TableCell align="right">
                        <Box style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--foreground)' }}>
                          <ExpandChevron expanded={isExpanded} />
                        </Box>
                      </TableCell>
                    </TableRow>

                    <TableRow>
                      <TableCell colSpan={6} style={{ padding: 0, border: 'none' }}>
                        <Collapse in={isExpanded} timeout="auto" unmountOnExit fancy>
                          <Box className="p-2">
                            {videos.length > 0 && (
                            <Table size="small">
                              <TableBody>
                                {videos.map((video: VideoData) => (
                                  <TableRow key={video.youtubeId}>
                                    <TableCell style={{ width: 180 }}>{formattedTimeCreated}</TableCell>
                                    <TableCell>
                                      <Box className="flex items-start gap-2 flex-wrap">
                                        <Link
                                          component="button"
                                          type="button"
                                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); setModalVideo(video); }}
                                          style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
                                        >
                                          {video.youTubeVideoName}
                                        </Link>
                                        {video.removed && <MissingVideoChip />}
                                      </Box>
                                      <Typography variant="caption" color="secondary" className="block">{video.youTubeChannelName}</Typography>
                                    </TableCell>
                                    <TableCell>{formattedJobType}</TableCell>
                                    <TableCell>{job.status}</TableCell>
                                    <TableCell>{formatDownloadSpeed(video.avgDownloadMBps)}</TableCell>
                                    <TableCell />
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                            )}
                            <FailedDownloadsDetail
                              failedVideos={failedForJob}
                              diagnoses={job.data?.diagnoses}
                            />
                            <TerminatedChannelsDetail
                              terminatedChannels={terminatedChannels}
                              terminationFailures={terminationFailures}
                            />
                          </Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </React.Fragment>
                );
              }

              const nzbFallback = videos.length === 0 ? nzbFallbackVideo(job) : null;
              const singleVideo = videos[0] || nzbFallback || undefined;
              const isNzbFallback = !videos[0] && !!nzbFallback;
              return (
                <TableRow key={job.id} hover>
                  <TableCell>{formattedTimeCreated}</TableCell>
                  <TableCell>
                    {singleVideo ? (
                      <Box className="flex items-start gap-3">
                        <span aria-hidden="true" style={{ display: 'none' }}>1</span>
                        <VideoThumbnail
                          video={singleVideo}
                          width={128}
                          height={72}
                          onClick={isNzbFallback ? () => {} : () => setModalVideo(singleVideo)}
                          hasError={!!imageErrors[singleVideo.youtubeId]}
                          onError={() => handleImageError(singleVideo.youtubeId)}
                          iconSize={32}
                        />
                        <Box className="min-w-0 flex-1">
                          {isNzbFallback ? (
                            <span>{singleVideo.youTubeVideoName}</span>
                          ) : (
                            <Link
                              component="button"
                              type="button"
                              onClick={() => setModalVideo(singleVideo)}
                              style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
                            >
                              {singleVideo.youTubeVideoName}
                            </Link>
                          )}
                          {!isNzbFallback && (
                            <Typography variant="caption" color="secondary" className="block">{singleVideo.youTubeChannelName}</Typography>
                          )}
                          {fileNameOf(singleVideo.filePath) && (
                            <Typography variant="caption" color="secondary" className="block" style={{ opacity: 0.75, wordBreak: 'break-all' }}>
                              {fileNameOf(singleVideo.filePath)}
                            </Typography>
                          )}
                          {job.data?.notes && (
                            <Typography variant="caption" className="block" style={{ color: 'var(--destructive)' }}>
                              {job.data.notes}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    ) : job.status === 'In Progress' ? (
                      <span>---</span>
                    ) : (
                      <Box>
                        <span>{cleanJobTypeLabel(job.jobType)}</span>
                        {job.data?.notes && (
                          <Typography variant="caption" className="block" style={{ color: 'var(--destructive)' }}>
                            {job.data.notes}
                          </Typography>
                        )}
                      </Box>
                    )}
                  </TableCell>
                  <TableCell>{formattedJobType || '---'}</TableCell>
                  <TableCell>{durationString}</TableCell>
                  <TableCell>{singleVideo ? formatDownloadSpeed(singleVideo.avgDownloadMBps) : ''}</TableCell>
                  <TableCell align="right" />
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </TableContainer>
  );

  const paginationBar = (placement: 'top' | 'bottom') => (
    <VideoListPaginationBar
      placement={placement}
      hasContent={jobsToDisplay.length > 0}
      useInfiniteScroll={useInfiniteScroll}
      page={currentPage}
      totalPages={totalPages}
      onPageChange={setCurrentPage}
      pageSize={itemsPerPage}
      onPageSizeChange={setItemsPerPage}
      isMobile={isMobile}
    />
  );

  const infiniteSentinel = useInfiniteScroll && hasMoreHotLoadItems ? (
    <div ref={loadMoreRef} style={{ height: 24, width: '100%', marginTop: 8 }} />
  ) : null;

  const headerSlot = (
    <div style={{ padding: '12px 16px 0 16px' }}>
      <Typography variant={isMobile ? 'h6' : 'h5'} align="center">
        Download History
      </Typography>
    </div>
  );

  return (
    <>
      <Grid item xs={12}>
        <VideoListContainer<string>
          state={listState}
          viewModes={['table']}
          filters={filterConfigs}
          searchPlaceholder="Search jobs by title or channel..."
          headerSlot={headerSlot}
          itemCount={currentJobs.length}
          isLoading={false}
          isError={false}
          customEmptyMessage={hasActiveFilters || normalizedSearch ? 'No jobs found matching your filters' : 'No jobs currently running'}
          renderContent={() => (isMobile ? renderMobileJobs() : renderDesktopTable())}
          pagination={paginationBar('bottom')}
          paginationTop={paginationBar('top')}
          paginationMode={useInfiniteScroll ? 'infinite' : 'pages'}
          infiniteScrollSentinel={infiniteSentinel}
          isMobile={isMobile}
        />
      </Grid>
      {modalElement}
    </>
  );
};

export default DownloadHistory;
