import React, { useState, useCallback, useEffect } from 'react';
import { Box, Typography, IconButton, Tooltip, Link } from '../../../ui';
import {
  Play as PlayArrowIcon,
  CloudOff as CloudOffIcon,
  Download as DownloadIcon,
  Block as BlockIcon,
  Info as InfoOutlinedIcon,
  Close as CloseIcon,
  WarningAmber as WarningAmberIcon,
  Lock as LockIcon,
} from '../../../../lib/icons';
import { VideoModalData } from '../types';
import { YOUTUBE_URL_BASE } from '../constants';

interface VideoPlayerProps {
  video: VideoModalData;
  token: string | null;
  onDownloadClick: () => void;
  isMobile: boolean;
}

const DEFAULT_LANDSCAPE_ASPECT_RATIO = 16 / 9;
const DEFAULT_PORTRAIT_ASPECT_RATIO = 9 / 16;

function VideoPlayer({ video, token, onDownloadClick, isMobile }: VideoPlayerProps) {
  const [playbackStarted, setPlaybackStarted] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [infoTooltipOpen, setInfoTooltipOpen] = useState(false);
  const [streamAspectRatio, setStreamAspectRatio] = useState<number | null>(null);
  // video.thumbnailUrl is always the LOCAL /images/videothumb-*.jpg path
  // (see videoDataToModalData) - that file only exists once something has
  // actually written it (a real download, channel sync, STRM
  // materialization), so a video that's merely been previewed/cache-warmed
  // (never downloaded) 404s there. Same local-then-YouTube-CDN fallback as
  // DownloadManager/VideoThumbnail.tsx, so the popup shows a real thumbnail
  // instead of the browser's broken-image icon.
  const [thumbnailSrc, setThumbnailSrc] = useState(video.thumbnailUrl);

  useEffect(() => {
    setPlaybackStarted(false);
    setStreamError(false);
    setInfoTooltipOpen(false);
    setStreamAspectRatio(null);
    setThumbnailSrc(video.thumbnailUrl);
  }, [video.youtubeId, video.thumbnailUrl]);

  const handleThumbnailError = useCallback(() => {
    const cdnThumbnailUrl = `https://i.ytimg.com/vi/${video.youtubeId}/hqdefault.jpg`;
    if (thumbnailSrc !== cdnThumbnailUrl) {
      setThumbnailSrc(cdnThumbnailUrl);
    }
  }, [thumbnailSrc, video.youtubeId]);

  // 'cached' (an untracked row whose hls-buffer cache file exists - see
  // videoDataToModalData) is streamable the same way a real download is:
  // /api/videos/:id/stream falls back to that cache file server-side when
  // there's no Videos table row at all.
  const canStream = (video.isDownloaded || video.status === 'cached') && video.status !== 'missing';
  const playbackType: 'video' | 'audio' =
    !video.filePath && video.audioFilePath ? 'audio' : 'video';
  // STRM-only library items store a .strm text file. Serve those through
  // /api/ytstream (same endpoint Jellyfin uses) so the browser gets real media.
  const isStrm =
    Boolean(video.isStrm) ||
    (typeof video.filePath === 'string' &&
      video.filePath.toLowerCase().endsWith('.strm'));
  // Pinned to mode=direct&quality=720 regardless of ytstream.defaultMode:
  // this is a plain native <video> element with no HLS engine (hls.js /
  // MSE) wired up, so it can't play mode=hls's .m3u8 manifest at all.
  // mode=ffmpeg was tried here previously, but it sends the response
  // headers before any bytes exist and makes the browser sit through a
  // full cold start (QSV init + dual yt-dlp fetch + ffmpeg mux, easily
  // 15-40s) — long enough that the browser's own stalled-connection
  // timeout fires, aborts, and retries near byte 0 forever, never
  // actually playing. mode=direct skips ffmpeg entirely (one yt-dlp -g
  // resolve, then a proxied progressive URL), so there's no live pipe to
  // stall on. quality is pinned to 720 (not left to server/global
  // default, which might be "best") because quality=best can itself
  // resolve to an HLS manifest URL from YouTube's own CDN — 720 is the
  // one mapping guaranteed to be a real progressive MP4 (see
  // docs/YTSTREAM.md's direct-mode quality table).
  const streamUrl = isStrm
    ? `/api/ytstream/${encodeURIComponent(video.youtubeId)}?mode=direct&quality=720`
    : token
      ? `/api/videos/${video.youtubeId}/stream?token=${encodeURIComponent(token)}${
          playbackType === 'audio' ? '&type=audio' : ''
        }`
      : null;

  const handlePlay = useCallback(() => {
    setPlaybackStarted(true);
  }, []);

  const handleStreamError = useCallback(() => {
    setStreamError(true);
    setPlaybackStarted(false);
  }, []);

  const handleStop = useCallback(() => {
    setPlaybackStarted(false);
  }, []);

  const handleVideoMetadata = useCallback((event: React.SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth, videoHeight } = event.currentTarget;
    if (videoWidth > 0 && videoHeight > 0) {
      setStreamAspectRatio(videoWidth / videoHeight);
    }
  }, []);

  const youtubeUrl = `${YOUTUBE_URL_BASE}${video.youtubeId}`;
  const isPlaying = canStream && playbackStarted && streamUrl && !streamError;
  const isPlayingVideo = isPlaying && playbackType === 'video';
  const isPlayingAudio = isPlaying && playbackType === 'audio';
  const fallbackAspectRatio = video.mediaType === 'short'
    ? DEFAULT_PORTRAIT_ASPECT_RATIO
    : DEFAULT_LANDSCAPE_ASPECT_RATIO;
  const displayAspectRatio = isPlayingVideo
    ? (streamAspectRatio ?? fallbackAspectRatio)
    : fallbackAspectRatio;
  const maxPlayerHeight = isMobile
    ? 'var(--video-modal-media-max-height-mobile, 52vh)'
    : 'var(--video-modal-media-max-height-desktop, 68vh)';

  return (
    <Box
      style={{
        position: 'relative',
        display: 'block',
        width: `min(100%, calc(${maxPlayerHeight} * ${displayAspectRatio}))`,
        maxWidth: '100%',
        ...(isPlayingVideo ? {} : { aspectRatio: `${displayAspectRatio}` }),
        padding: 0,
        backgroundColor: 'transparent',
        border: 'none',
        boxShadow: 'none',
        overflow: 'hidden',
        borderRadius: 'var(--video-modal-media-radius, var(--radius-ui))',
        margin: '0 auto',
        lineHeight: 0,
      }}
    >
      {/* Video element - absolutely positioned when playing */}
      {isPlayingVideo && (
        <Box
          component="video"
          data-testid="video-stream-element"
          src={streamUrl}
          controls
          autoPlay
          onError={handleStreamError}
          onLoadedMetadata={handleVideoMetadata}
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            maxHeight: maxPlayerHeight,
            objectFit: 'cover',
            borderRadius: 'inherit',
            verticalAlign: 'top',
          }}
        />
      )}

      {/* Thumbnail stays visible during audio playback - there is no video frame to show */}
      {!isPlayingVideo && (
        <Box
          component="img"
          src={thumbnailSrc}
          alt={video.title}
          onError={handleThumbnailError}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: 'inherit',
          }}
        />
      )}

      {/* Audio bar overlaid on the thumbnail when playing an audio-only download */}
      {isPlayingAudio && (
        <Box
          component="audio"
          data-testid="audio-stream-element"
          src={streamUrl}
          controls
          autoPlay
          onError={handleStreamError}
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            width: 'calc(100% - 16px)',
            zIndex: 2,
          }}
        />
      )}

      {/* Overlay content - shown when not playing */}
      {!isPlaying && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--video-modal-media-overlay-gradient, linear-gradient(to bottom, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.42) 100%))',
            gap: 8,
            borderRadius: 'inherit',
          }}
        >
          {streamError ? (
            <>
              <CloudOffIcon size={48} color="white" />
              <Typography variant="body2" sx={{ color: 'common.white' }}>
                {playbackType === 'audio' ? 'Unable to stream audio' : 'Unable to stream video'}
              </Typography>
              <Link
                href={youtubeUrl}
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                variant="body2"
                style={{ color: 'var(--video-modal-link-color, hsl(var(--primary)))' }}
              >
                Open in YouTube
              </Link>
            </>
          ) : canStream ? (
            <IconButton
              onClick={handlePlay}
              aria-label={playbackType === 'audio' ? 'Play audio' : 'Play video'}
              style={{
                backgroundColor: 'var(--video-modal-overlay-action-background, var(--media-overlay-background-strong))',
                color: 'var(--video-modal-overlay-action-foreground, var(--media-overlay-foreground))',
                width: 'var(--video-modal-overlay-action-size, 72px)',
                height: 'var(--video-modal-overlay-action-size, 72px)',
                zIndex: 2,
              }}
            >
              <PlayArrowIcon size={Number.parseInt('48', 10)} style={{ width: 'var(--video-modal-overlay-action-icon-size, 48px)', height: 'var(--video-modal-overlay-action-icon-size, 48px)' }} />
            </IconButton>
          ) : video.status === 'ignored' ? (
            <>
              <BlockIcon size={48} color="white" />
              <Typography variant="body1" sx={{ color: 'common.white', fontWeight: 500 }}>
                Ignored
              </Typography>
            </>
          ) : video.status === 'missing' ? (
            <>
              <WarningAmberIcon size={48} color="var(--warning)" />
              <Typography variant="body1" sx={{ color: 'common.white', fontWeight: 500 }}>
                File Missing
              </Typography>
              <IconButton
                onClick={onDownloadClick}
                aria-label="Re-download video"
                style={{
                  backgroundColor: 'var(--video-modal-overlay-action-background, var(--media-overlay-background-strong))',
                  color: 'var(--video-modal-overlay-action-foreground, var(--media-overlay-foreground))',
                  width: 'var(--video-modal-overlay-download-size, 90px)',
                  height: 'var(--video-modal-overlay-download-size, 90px)',
                  zIndex: 2,
                }}
              >
                <DownloadIcon style={{ width: 'var(--video-modal-overlay-download-icon-size, 50px)', height: 'var(--video-modal-overlay-download-icon-size, 50px)' }} />
              </IconButton>
            </>
          ) : video.status === 'members_only' ? (
            // Dark text + white glow stays legible on both light and dark
            // thumbnails. Hardcoded color: this label sits on top of an
            // arbitrary photo, not on themed UI background.
            <>
              <LockIcon
                size={48}
                color="#0f172a"
                style={{
                  filter:
                    'drop-shadow(0 0 4px rgba(255,255,255,0.95)) drop-shadow(0 0 10px rgba(255,255,255,0.75))',
                }}
              />
              <Typography
                variant="body1"
                sx={{
                  color: '#0f172a',
                  fontWeight: 600,
                  textShadow:
                    '0 0 4px rgba(255,255,255,0.95), 0 0 10px rgba(255,255,255,0.8), 0 0 16px rgba(255,255,255,0.55)',
                }}
              >
                Members Only
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  color: '#0f172a',
                  fontWeight: 500,
                  textAlign: 'center',
                  paddingLeft: 16,
                  paddingRight: 16,
                  textShadow:
                    '0 0 4px rgba(255,255,255,0.95), 0 0 10px rgba(255,255,255,0.8), 0 0 16px rgba(255,255,255,0.55)',
                }}
              >
                Youtarr cannot download this video or fetch its metadata
              </Typography>
            </>
          ) : (
            <IconButton
              onClick={onDownloadClick}
              aria-label="Download video"
              style={{
                backgroundColor: 'var(--video-modal-overlay-action-background, var(--media-overlay-background-strong))',
                color: 'var(--video-modal-overlay-action-foreground, var(--media-overlay-foreground))',
                width: 'var(--video-modal-overlay-download-size, 90px)',
                height: 'var(--video-modal-overlay-download-size, 90px)',
                zIndex: 2,
              }}
            >
              <DownloadIcon style={{ width: 'var(--video-modal-overlay-download-icon-size, 50px)', height: 'var(--video-modal-overlay-download-icon-size, 50px)' }} />
            </IconButton>
          )}
        </Box>
      )}

      {/* Playback controls - shown during playback */}
      {isPlaying && (
        <Box
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            zIndex: 2,
          }}
        >
          {canStream && !streamError && (
            <Box style={{ position: 'relative' }}>
              <IconButton
                size="small"
                onClick={() => setInfoTooltipOpen((prev) => !prev)}
                aria-label="Playback info"
                style={{
                  color: 'var(--video-modal-overlay-corner-foreground, var(--media-overlay-foreground))',
                  backgroundColor: 'var(--video-modal-overlay-corner-background, var(--media-overlay-background))',
                }}
              >
                <InfoOutlinedIcon size={16} />
              </IconButton>
              {infoTooltipOpen && (
                <Box
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    width: isMobile ? 'min(240px, calc(100vw - 40px))' : '260px',
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-ui)',
                    backgroundColor: 'var(--video-modal-info-bubble-background, var(--popover))',
                    color: 'var(--video-modal-info-bubble-foreground, var(--popover-foreground))',
                    border: 'var(--video-modal-info-bubble-border, 1px solid var(--border))',
                    boxShadow: 'var(--video-modal-info-bubble-shadow, var(--shadow-soft))',
                    zIndex: 3,
                  }}
                >
                  <Typography variant="caption" style={{ display: 'block', lineHeight: 1.5 }}>
                    {isStrm
                      ? 'This item is a STRM shortcut. Playback is resolved on demand via yt-dlp (capped at 720p here), so it may take a moment to start and depends on cookies/network.'
                      : playbackType === 'audio'
                        ? 'Audio is served directly without transcoding. Playback may buffer on slow connections.'
                        : 'Video is served directly without transcoding. Playback may buffer on slow connections.'}
                  </Typography>
                </Box>
              )}
            </Box>
          )}
          <Tooltip title="Stop playback">
            <IconButton
              size="small"
              onClick={handleStop}
              aria-label="Stop playback"
              style={{
                color: 'var(--video-modal-overlay-corner-foreground, var(--media-overlay-foreground))',
                backgroundColor: 'var(--video-modal-overlay-corner-background, var(--media-overlay-background))',
              }}
            >
              <CloseIcon size={16} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}

export default VideoPlayer;
