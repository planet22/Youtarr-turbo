import React from 'react';
import { Box, Typography, Chip, Checkbox, Stack, IconButton, Tooltip } from '../../ui';
import { AlertCircle as ErrorOutlineIcon, Trash2 as DeleteIcon, Ghost as StealthCacheIcon } from 'lucide-react';
import { Database as MetadataCacheIcon, Storage as CachedVideoIcon, ClearCache as ClearCacheIcon } from '../../../lib/icons';
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
import WatchedChip from '../../shared/WatchedChip';
import { SHARED_STATUS_CHIP_SMALL_STYLE } from '../../shared/chipStyles';
import ChannelNameDisplay from './ChannelNameDisplay';

export interface VideosListMobileProps {
  videos: VideoData[];
  selectedVideos: string[];
  enabledChannels: EnabledChannel[];
  imageErrors: Record<string, boolean>;
  deleteDisabled: boolean;
  onToggleSelect: (youtubeId: string) => void;
  onOpenModal: (video: VideoData) => void;
  onToggleProtection: (videoId: number) => void;
  onDeleteSingle: (videoId: number) => void;
  onImageError: (youtubeId: string) => void;
  onAddChannel: (channelName: string, channelUrl: string) => void;
  onOpenCacheDetail: (youtubeId: string, kind: 'metadata' | 'video') => void;
  // Single-click "delete" for an untracked row - clears both its cached
  // metadata and cached video after a confirm dialog. Optional since not
  // every VideosListMobile call site wires up the confirm dialog (yet).
  onClearCachedRow?: (video: VideoData) => void;
  // Reveals the file path(s) as a small full-width line under each row - a
  // page-level toggle, see VideosTable's matching prop.
  showFilePath?: boolean;
}

const COMPACT_CHIP_HEIGHT = 20;
const COMPACT_CHIP_FONT_SIZE = '0.65rem';

const compactStatusChipStyle: React.CSSProperties = {
  ...SHARED_STATUS_CHIP_SMALL_STYLE,
  height: COMPACT_CHIP_HEIGHT,
  fontSize: COMPACT_CHIP_FONT_SIZE,
};

const compactRatingChipStyle: React.CSSProperties = {
  height: COMPACT_CHIP_HEIGHT,
  fontSize: COMPACT_CHIP_FONT_SIZE,
};

function VideosListMobile({
  videos,
  selectedVideos,
  enabledChannels,
  imageErrors,
  deleteDisabled,
  onToggleSelect,
  onOpenModal,
  onToggleProtection,
  onDeleteSingle,
  onImageError,
  onAddChannel,
  onOpenCacheDetail,
  onClearCachedRow,
  showFilePath = false,
}: VideosListMobileProps) {
  return (
    <Box>
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

        const showPathLine = showFilePath && Boolean(video.filePath || video.audioFilePath);
        const pathText = [video.filePath, video.audioFilePath]
          .filter((p): p is string => Boolean(p))
          .map(getDisplayPath)
          .join('  •  ');

        return (
          <React.Fragment key={video.youtubeId}>
          <Box
            role="button"
            tabIndex={0}
            onClick={() => onToggleSelect(video.youtubeId)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onToggleSelect(video.youtubeId);
              }
            }}
            style={{
              display: 'flex',
              gap: 10,
              padding: '10px 4px',
              borderBottom: showPathLine ? 'none' : '1px solid var(--border)',
              cursor: 'pointer',
              backgroundColor: isSelected ? 'var(--muted)' : undefined,
              opacity: isTracked ? 1 : 0.75,
              transition: 'background-color 0.15s ease',
              alignItems: 'flex-start',
            }}
          >
            <Box
              style={{
                flexShrink: 0,
                width: 120,
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
              onClick={(e) => e.stopPropagation()}
            >
            <Box
              style={{
                position: 'relative',
                width: 120,
                height: 68,
                overflow: 'hidden',
                backgroundColor: 'var(--media-placeholder-background)',
                borderRadius: 'var(--radius-thumb)',
              }}
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
                    fontSize: '0.65rem',
                  }}
                >
                  No thumb
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
                    fontSize: '0.55rem',
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
                    fontSize: '0.55rem',
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
              {video.duration ? (
                <Chip
                  label={formatDuration(video.duration)}
                  size="small"
                  style={{
                    position: 'absolute',
                    bottom: 2,
                    right: 2,
                    backgroundColor: 'var(--media-overlay-background-strong)',
                    color: 'var(--media-overlay-foreground)',
                    fontSize: '0.65rem',
                    height: 16,
                    zIndex: 2,
                  }}
                />
              ) : null}
              <Checkbox
                checked={isSelected}
                onClick={(e) => e.stopPropagation()}
                onChange={(event) => {
                  event.stopPropagation();
                  onToggleSelect(video.youtubeId);
                }}
                inputProps={{ 'aria-label': `Select ${video.youTubeVideoName}` }}
                style={{
                  position: 'absolute',
                  top: 2,
                  left: 2,
                  padding: 2,
                  backgroundColor: 'var(--media-overlay-background)',
                  color: 'var(--media-overlay-foreground)',
                  zIndex: 3,
                }}
              />
              {isTracked && video.id !== null && !video.removed && (
                <ProtectionShieldButton
                  isProtected={video.protected || false}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleProtection(video.id as number);
                  }}
                  style={{ position: 'absolute', bottom: 2, left: 2, zIndex: 3 }}
                />
              )}
            </Box>
            <Typography
              variant="caption"
              color="text.secondary"
              style={{
                fontSize: '0.65rem',
                lineHeight: 1.25,
                textAlign: 'center',
              }}
            >
              Published: {formatYTDate(video.originalDate)}
            </Typography>
          </Box>

            <Box style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography
                variant="subtitle2"
                className="font-semibold"
                style={{
                  cursor: 'pointer',
                  lineHeight: 1.25,
                  fontSize: '0.85rem',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenModal(video);
                }}
              >
                {video.youTubeVideoName}
              </Typography>
              <ChannelNameDisplay
                channelName={video.youTubeChannelName}
                enabledChannelId={channelId}
                videoChannelId={video.channel_id}
                variant="caption"
                className="block truncate"
                style={{ fontSize: '0.7rem' }}
                onAddChannel={onAddChannel}
              />
              <Stack direction="row" spacing={0.5} className="flex-wrap gap-1">
                {!video.removed && (video.filePath || video.audioFilePath) && (
                  <DownloadFormatIndicator
                    filePath={video.filePath}
                    audioFilePath={video.audioFilePath}
                    fileSize={video.fileSize}
                    audioFileSize={video.audioFileSize}
                    videoResolution={video.video_resolution}
                    compact
                  />
                )}
                {mediaTypeInfo && (
                  <Chip
                    size="small"
                    icon={mediaTypeInfo.icon}
                    label={mediaTypeInfo.label}
                    color={mediaTypeInfo.color}
                    variant="outlined"
                    style={compactStatusChipStyle}
                  />
                )}
                <RatingBadge
                  rating={video.normalized_rating}
                  ratingSource={video.rating_source}
                  showNA
                  size="small"
                  style={compactRatingChipStyle}
                />
                {isTracked && (video.removed ? (
                  <AvailabilityChip isAvailable={false} compact />
                ) : video.fileSize ? (
                  <AvailabilityChip isAvailable={true} compact />
                ) : null)}
                <WatchedChip watchedBy={video.watchedBy || []} compact />
                {video.hasCachedMetadata && (
                  <Tooltip title="Cached metadata — click for details">
                    <IconButton
                      size="small"
                      aria-label="Cached metadata"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenCacheDetail(video.youtubeId, 'metadata');
                      }}
                      style={{ padding: 2 }}
                    >
                      <MetadataCacheIcon size={14} />
                    </IconButton>
                  </Tooltip>
                )}
                {video.hasCachedVideo && (
                  <Tooltip title="Opportunistically cached from STRM - will automatically revert to STRM when it expires. Click for details.">
                    <Chip
                      size="small"
                      icon={<CachedVideoIcon size={12} />}
                      label={formatExpiresIn(video.cachedVideoExpiresAt) ?? 'Cached'}
                      variant="outlined"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenCacheDetail(video.youtubeId, 'video');
                      }}
                      style={{ ...compactStatusChipStyle, cursor: 'pointer' }}
                    />
                  </Tooltip>
                )}
                {video.hasStealthCache && (
                  <Tooltip title="Stealth-cached — playback served locally via Youtarr; still STRM, hidden from media server scans">
                    <Chip
                      size="small"
                      icon={<StealthCacheIcon size={12} color="#9c27b0" />}
                      label={video.stealthCacheFileSize ? formatFileSize(video.stealthCacheFileSize) : 'Cached'}
                      variant="outlined"
                      style={{ ...compactStatusChipStyle, borderColor: '#9c27b0', color: '#9c27b0' }}
                    />
                  </Tooltip>
                )}
              </Stack>
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  style={{ fontSize: '0.65rem', lineHeight: 1.3 }}
                >
                  Downloaded: {formatAddedDateTime(video.timeCreated)}
                  {fileSizeNumber && !(video.filePath || video.audioFilePath)
                    ? ` • ${formatFileSize(fileSizeNumber)}`
                    : ''}
                </Typography>
                {isTracked && video.id !== null && !video.removed && (
                  <Tooltip title="Delete video from disk">
                    <span onClick={(e) => e.stopPropagation()}>
                      <IconButton
                        color="error"
                        size="small"
                        data-testid="DeleteIcon"
                        aria-label="Delete video from disk"
                        onClick={() => onDeleteSingle(video.id as number)}
                        disabled={deleteDisabled}
                        style={{ padding: 2, flexShrink: 0 }}
                      >
                        <DeleteIcon size={16} />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                {!isTracked && (video.hasCachedMetadata || video.hasCachedVideo) && onClearCachedRow && (
                  <Tooltip title="Clear cached metadata and video">
                    <span onClick={(e) => e.stopPropagation()}>
                      <IconButton
                        color="error"
                        size="small"
                        aria-label="Clear cached metadata and video"
                        onClick={() => onClearCachedRow(video)}
                        style={{ padding: 2, flexShrink: 0 }}
                      >
                        <ClearCacheIcon size={16} />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
              </Box>
            </Box>
          </Box>
          {showPathLine && (
            <Box style={{ padding: '0 4px 8px 4px', borderBottom: '1px solid var(--border)' }}>
              <Typography
                variant="caption"
                color="text.secondary"
                style={{ fontSize: '0.65rem', wordBreak: 'break-all', display: 'block' }}
              >
                {pathText}
              </Typography>
            </Box>
          )}
          </React.Fragment>
        );
      })}
    </Box>
  );
}

export default VideosListMobile;
