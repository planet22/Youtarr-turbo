import React from 'react';
import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
  Checkbox,
  Chip,
  Tooltip,
  IconButton,
  Box,
  Stack,
} from '../../ui';
import {
  AlertCircle as ErrorOutlineIcon,
  Trash2 as DeleteIcon,
} from 'lucide-react';
import { Database as MetadataCacheIcon, Storage as CachedVideoIcon, ClearCache as ClearCacheIcon, Shield as ProtectSpacerIcon } from '../../../lib/icons';
import { formatDuration, formatYTDate } from '../../../utils';
import { formatAddedDateTime, formatFileSize, formatExpiresIn } from '../../../utils/formatters';
import { getDisplayPath } from '../../../utils/paths';
import { getMediaTypeInfo } from '../../../utils/videoStatus';
import { getEnabledChannelId } from '../../../utils/enabledChannels';
import { VideoData, EnabledChannel } from '../../../types/VideoData';
import RatingBadge from '../../shared/RatingBadge';
import DownloadFormatIndicator from '../../shared/DownloadFormatIndicator';
import ProtectionShieldButton from '../../shared/ProtectionShieldButton';
import ThumbnailClickOverlay from '../../shared/ThumbnailClickOverlay';
import AvailabilityChip from '../../shared/AvailabilityChip';
import { SHARED_STATUS_CHIP_SMALL_STYLE } from '../../shared/chipStyles';
import ChannelNameDisplay from './ChannelNameDisplay';
import WatchedChip from '../../shared/WatchedChip';

export interface VideosTableProps {
  videos: VideoData[];
  selectedVideos: string[];
  enabledChannels: EnabledChannel[];
  imageErrors: Record<string, boolean>;
  orderBy: 'published' | 'added';
  sortOrder: 'asc' | 'desc';
  deleteDisabled: boolean;
  onSelectAll: (checked: boolean) => void;
  onToggleSelect: (youtubeId: string) => void;
  onSortChange: (newOrderBy: 'published' | 'added') => void;
  onOpenModal: (video: VideoData) => void;
  onToggleProtection: (videoId: number) => void;
  onDeleteSingle: (videoId: number) => void;
  onStrmChipClick: (video: VideoData) => void;
  onImageError: (youtubeId: string) => void;
  onAddChannel: (channelName: string, channelUrl: string) => void;
  onOpenCacheDetail: (youtubeId: string, kind: 'metadata' | 'video') => void;
  // Single-click "delete" for an untracked row - clears both its cached
  // metadata and cached video (whichever it has) after a confirm dialog,
  // since there's no real library row/file for the usual delete action.
  onClearCachedRow: (video: VideoData) => void;
  // Reveals each row's file path(s) as a small full-width line underneath -
  // a page-level toggle (see VideosPage's "Show File Paths" filter chip),
  // not per-row, so it lives here as a single prop rather than row state.
  showFilePaths?: boolean;
}

// Checkbox, thumbnail, title, channel, published, downloaded, duration,
// size, rating, cached-metadata, status, actions.
const TABLE_COLUMN_COUNT = 12;

function videoCacheExpiryText(video: VideoData): string | null {
  if (video.isTracked === false) {
    return formatExpiresIn(video.cachedMetadataAt ? video.cachedMetadataExpiresAt : video.cachedVideoExpiresAt);
  }
  return formatExpiresIn(video.cachedVideoExpiresAt);
}

function VideosTable({
  videos,
  selectedVideos,
  enabledChannels,
  imageErrors,
  orderBy,
  sortOrder,
  deleteDisabled,
  onSelectAll,
  onToggleSelect,
  onSortChange,
  onOpenModal,
  onToggleProtection,
  onDeleteSingle,
  onStrmChipClick,
  onImageError,
  onAddChannel,
  onOpenCacheDetail,
  onClearCachedRow,
  showFilePaths = false,
}: VideosTableProps) {
  // A video's main row and its filename row (when showFilePaths is on) are
  // two separate <tr> siblings, so the ui/table.tsx `hover` prop's CSS
  // :hover pseudo-class only ever lights up whichever one the cursor is
  // literally over. Tracking hover in state and applying it to both rows
  // keeps the pair looking like one highlighted unit.
  const [hoveredYoutubeId, setHoveredYoutubeId] = React.useState<string | null>(null);
  const allIds = videos.map((v) => v.youtubeId);
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selectedVideos.includes(id));
  const someSelected = !allSelected && allIds.some((id) => selectedVideos.includes(id));

  return (
    <Paper style={{ overflow: 'hidden' }}>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell component="th" style={{ width: 48 }}>
                <Checkbox
                  indeterminate={someSelected}
                  checked={allSelected}
                  onChange={(event) => onSelectAll(event.target.checked)}
                  inputProps={{ 'aria-label': 'Select all videos' }}
                />
              </TableCell>
              <TableCell component="th" style={{ width: 160 }}>Thumbnail</TableCell>
              <TableCell component="th">Title</TableCell>
              <TableCell component="th" style={{ width: '18%' }}>Channel</TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 120 }}>
                <TableSortLabel
                  active={orderBy === 'published'}
                  direction={orderBy === 'published' ? sortOrder : 'asc'}
                  onClick={() => onSortChange('published')}
                >
                  Published
                </TableSortLabel>
              </TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 120 }}>
                <TableSortLabel
                  active={orderBy === 'added'}
                  direction={orderBy === 'added' ? sortOrder : 'asc'}
                  onClick={() => onSortChange('added')}
                >
                  Downloaded
                </TableSortLabel>
              </TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 90 }}>Duration</TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 90 }}>Size</TableCell>
              <TableCell component="th" style={{ width: 90 }}>Rating</TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 70 }}>Cache</TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 180 }}>Status</TableCell>
              <TableCell component="th" style={{ whiteSpace: 'nowrap', width: 90 }}>Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {videos.map((video) => {
              const isSelected = selectedVideos.includes(video.youtubeId);
              const isTracked = video.isTracked !== false;
              const channelId = getEnabledChannelId(
                video.youTubeChannelName,
                video.channel_id,
                enabledChannels
              );
              const mediaTypeInfo = getMediaTypeInfo(video.media_type);
              const fileSizeNumber = video.fileSize
                ? typeof video.fileSize === 'string'
                  ? parseInt(video.fileSize, 10)
                  : video.fileSize
                : null;
              // .strm files are text pointers, not media - their real size reads
              // as a meaningless "0MB" here. Match DownloadFormatIndicator's chip.
              const isVideoStrm =
                typeof video.filePath === 'string' && video.filePath.toLowerCase().endsWith('.strm');
              const downloadedTooltip = videoCacheExpiryText(video);
              const pathText = [video.filePath, video.audioFilePath]
                .filter((p): p is string => Boolean(p))
                .map(getDisplayPath)
                .join('  •  ');

              return (
                <React.Fragment key={video.youtubeId}>
                <TableRow
                  style={{
                    cursor: 'pointer',
                    backgroundColor: isSelected || hoveredYoutubeId === video.youtubeId ? 'var(--muted)' : undefined,
                    opacity: isTracked ? 1 : 0.75,
                    transition: 'background-color 0.15s ease',
                  }}
                  onClick={() => onToggleSelect(video.youtubeId)}
                  onMouseEnter={() => setHoveredYoutubeId(video.youtubeId)}
                  onMouseLeave={() => setHoveredYoutubeId(null)}
                >
                  <TableCell>
                    <Checkbox
                      checked={isSelected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => onToggleSelect(video.youtubeId)}
                      inputProps={{ 'aria-label': `Select ${video.youTubeVideoName}` }}
                    />
                  </TableCell>
                  <TableCell>
                    <Box
                      style={{
                        position: 'relative',
                        width: 144,
                        height: 81,
                        overflow: 'hidden',
                        backgroundColor: 'var(--media-placeholder-background)',
                        borderRadius: 'var(--radius-thumb)',
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {imageErrors[video.youtubeId] ? (
                        <Typography
                          variant="caption"
                          style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            filter: video.removed ? 'grayscale(100%) brightness(0.6)' : 'none',
                          }}
                        >
                          No thumbnail
                        </Typography>
                      ) : (
                        <img
                          src={`/images/videothumb-${video.youtubeId}.jpg`}
                          alt="thumbnail"
                          style={{
                            width: '100%',
                            height: '100%',
                            objectFit: video.media_type === 'short' ? 'contain' : 'cover',
                            filter: video.removed ? 'grayscale(100%) brightness(0.6)' : 'none',
                          }}
                          onError={() => onImageError(video.youtubeId)}
                        />
                      )}
                      <ThumbnailClickOverlay
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onOpenModal(video);
                        }}
                      />
                      {!isTracked && (
                        <Box
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            backgroundColor: 'var(--media-overlay-background, rgba(0,0,0,0.6))',
                            color: 'var(--media-overlay-foreground)',
                            padding: '2px 4px',
                            fontSize: '0.6rem',
                            fontWeight: 'bold',
                            textAlign: 'center',
                            zIndex: 2,
                          }}
                        >
                          Untracked
                        </Box>
                      )}
                      {video.youtube_removed && (
                        <Box
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            backgroundColor: 'var(--media-overlay-danger-background)',
                            color: 'var(--media-overlay-foreground)',
                            padding: '2px 4px',
                            fontSize: '0.6rem',
                            fontWeight: 'bold',
                            textAlign: 'center',
                            zIndex: 2,
                          }}
                        >
                          Removed
                        </Box>
                      )}
                      {video.removed && (
                        <Box
                          style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundColor: 'rgba(244, 67, 54, 0.3)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            zIndex: 1,
                            pointerEvents: 'none',
                          }}
                        >
                          <ErrorOutlineIcon
                            className="text-destructive"
                            style={{ fontSize: '1.5rem' }}
                          />
                        </Box>
                      )}
                    </Box>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Typography
                      variant="body2"
                      className="font-semibold"
                      style={{
                        cursor: 'pointer',
                        lineHeight: 1.3,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                      onClick={() => onOpenModal(video)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onOpenModal(video);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      {video.youTubeVideoName}
                    </Typography>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <ChannelNameDisplay
                      channelName={video.youTubeChannelName}
                      enabledChannelId={channelId}
                      videoChannelId={video.channel_id}
                      variant="body2"
                      onAddChannel={onAddChannel}
                    />
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    {formatYTDate(video.originalDate)}
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    {downloadedTooltip ? (
                      <Tooltip title={downloadedTooltip}>
                        <span>{formatAddedDateTime(video.timeCreated)}</span>
                      </Tooltip>
                    ) : (
                      formatAddedDateTime(video.timeCreated)
                    )}
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    {video.duration ? formatDuration(video.duration) : '-'}
                  </TableCell>
                  <TableCell style={{ whiteSpace: 'nowrap' }}>
                    {isVideoStrm ? 'STRM' : fileSizeNumber ? formatFileSize(fileSizeNumber) : '-'}
                  </TableCell>
                  <TableCell>
                    <RatingBadge
                      rating={video.normalized_rating}
                      ratingSource={video.rating_source}
                      showNA
                      size="small"
                    />
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {video.hasCachedMetadata && (
                      <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Tooltip title="Cached metadata — click for details">
                          <IconButton
                            size="small"
                            aria-label="Cached metadata"
                            onClick={() => onOpenCacheDetail(video.youtubeId, 'metadata')}
                          >
                            <MetadataCacheIcon size={16} />
                          </IconButton>
                        </Tooltip>
                        {video.cachedMetadataAt && (
                          <Typography variant="caption" color="text.secondary" style={{ whiteSpace: 'nowrap' }}>
                            {video.cachedMetadataAgo ?? formatAddedDateTime(video.cachedMetadataAt)}
                          </Typography>
                        )}
                      </Box>
                    )}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} className="flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                      {!video.removed && (video.filePath || video.audioFilePath) && (
                        <DownloadFormatIndicator
                          filePath={video.filePath}
                          audioFilePath={video.audioFilePath}
                          fileSize={video.fileSize}
                          audioFileSize={video.audioFileSize}
                          videoResolution={video.video_resolution}
                          onVideoChipClick={isTracked ? () => onStrmChipClick(video) : undefined}
                        />
                      )}
                      {mediaTypeInfo && (
                        <Chip
                          size="small"
                          icon={mediaTypeInfo.icon}
                          label={mediaTypeInfo.label}
                          color={mediaTypeInfo.color}
                          variant="outlined"
                          style={SHARED_STATUS_CHIP_SMALL_STYLE}
                        />
                      )}
                      {isTracked && (video.removed ? (
                        <AvailabilityChip isAvailable={false} />
                      ) : video.fileSize ? (
                        <AvailabilityChip isAvailable={true} />
                      ) : null)}
                      {video.hasCachedVideo && (
                        <Tooltip title="Cached video — click for details">
                          <Chip
                            size="small"
                            icon={<CachedVideoIcon size={14} />}
                            label="Cached"
                            variant="outlined"
                            onClick={() => onOpenCacheDetail(video.youtubeId, 'video')}
                            style={{ ...SHARED_STATUS_CHIP_SMALL_STYLE, cursor: 'pointer' }}
                          />
                        </Tooltip>
                      )}
                      <WatchedChip watchedBy={video.watchedBy || []} />
                    </Stack>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Box className="flex items-center gap-1">
                      {isTracked && video.id !== null && !video.removed ? (
                        <ProtectionShieldButton
                          isProtected={video.protected || false}
                          onClick={() => onToggleProtection(video.id as number)}
                          variant="inline"
                        />
                      ) : (
                        // Keeps the delete/clear-cache icon that follows
                        // lined up with rows that do show the protect
                        // button (untracked rows never get one).
                        <IconButton size="small" disabled aria-hidden="true" style={{ visibility: 'hidden' }}>
                          <ProtectSpacerIcon size={16} />
                        </IconButton>
                      )}
                      {isTracked && video.id !== null && !video.removed && (
                        <Tooltip title="Delete video from disk">
                          <span>
                            <IconButton
                              color="error"
                              size="small"
                              data-testid="DeleteIcon"
                              aria-label="Delete video from disk"
                              onClick={() => onDeleteSingle(video.id as number)}
                              disabled={deleteDisabled}
                            >
                              <DeleteIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                      )}
                      {!isTracked && (video.hasCachedMetadata || video.hasCachedVideo) && (
                        <Tooltip title="Clear cached metadata and video">
                          <IconButton
                            color="error"
                            size="small"
                            aria-label="Clear cached metadata and video"
                            onClick={() => onClearCachedRow(video)}
                          >
                            <ClearCacheIcon size={16} />
                          </IconButton>
                        </Tooltip>
                      )}
                    </Box>
                  </TableCell>
                </TableRow>
                {showFilePaths && pathText && (
                  // The tbody's divide-y rule borders every <tr> after the
                  // first - overriding it here (on the <tr>, not the <td>)
                  // keeps this line visually attached to the row above it,
                  // so the divider falls after the path text instead of
                  // between it and the row it belongs to.
                  <TableRow
                    style={{
                      borderTop: 'none',
                      cursor: 'pointer',
                      backgroundColor: isSelected || hoveredYoutubeId === video.youtubeId ? 'var(--muted)' : undefined,
                    }}
                    onClick={() => onToggleSelect(video.youtubeId)}
                    onMouseEnter={() => setHoveredYoutubeId(video.youtubeId)}
                    onMouseLeave={() => setHoveredYoutubeId(null)}
                  >
                    <TableCell
                      colSpan={TABLE_COLUMN_COUNT}
                      style={{ paddingTop: 0, paddingBottom: 6 }}
                    >
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        style={{ wordBreak: 'break-all', display: 'block' }}
                      >
                        {pathText}
                      </Typography>
                    </TableCell>
                  </TableRow>
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

export default VideosTable;
