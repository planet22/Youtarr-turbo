import React from 'react';
import { CheckCircle as CheckCircleIcon, CloudOff as CloudOffIcon, Lock as LockIcon, NewReleases as NewReleasesIcon, Schedule as ScheduleIcon, VideoLibrary as VideoLibraryIcon, Block as BlockIcon, Storage as CachedIcon } from '../lib/icons';
import { ChannelVideo } from '../types/ChannelVideo';

// 'cached' is never produced by getVideoStatus below (ChannelVideo has no
// concept of an untracked buffer-cache file) - it's only ever set directly
// by VideosPage's videoDataToModalData for an untracked row that has one.
export type VideoStatus = 'never_downloaded' | 'downloaded' | 'missing' | 'members_only' | 'ignored' | 'cached';

export const getVideoStatus = (video: ChannelVideo): VideoStatus => {
  if (video.ignored) {
    return 'ignored';
  }
  if (video.availability === 'subscriber_only') {
    return 'members_only';
  }
  if (!video.added) {
    return 'never_downloaded';
  }
  if (video.removed) {
    return 'missing';
  }
  return 'downloaded';
};

export const getStatusColor = (status: VideoStatus) => {
  switch (status) {
    case 'downloaded':
      return 'success';
    case 'missing':
      return 'error';
    case 'never_downloaded':
      return 'warning';
    case 'members_only':
      return 'default';
    case 'ignored':
      return 'default';
    case 'cached':
      return 'info';
    default:
      return 'info';
  }
};

export const getStatusIcon = (status: VideoStatus) => {
  switch (status) {
    case 'downloaded':
      return <CheckCircleIcon size={16} data-testid="CheckCircleIcon" />;
    case 'missing':
      return <CloudOffIcon size={16} data-testid="CloudOffIcon" />;
    case 'members_only':
      return <LockIcon size={16} data-testid="LockIcon" />;
    case 'ignored':
      return <BlockIcon size={16} data-testid="BlockIcon" />;
    case 'cached':
      return <CachedIcon size={16} data-testid="CachedIcon" />;
    default:
      return <NewReleasesIcon size={16} data-testid="NewReleasesIcon" />;
  }
};

export const getStatusLabel = (status: VideoStatus) => {
  switch (status) {
    case 'downloaded':
      return 'Downloaded';
    case 'missing':
      return 'Missing';
    case 'members_only':
      return 'Members Only';
    case 'ignored':
      return 'Ignored';
    case 'cached':
      return 'Cached';
    default:
      return 'Not Downloaded';
  }
};

export const getStatusChipVariant = (status: VideoStatus): 'filled' | 'outlined' => {
  switch (status) {
    case 'downloaded':
    case 'missing':
      return 'filled';
    default:
      return 'outlined';
  }
};

export const getStatusChipStyle = (status: VideoStatus): React.CSSProperties => {
  switch (status) {
    case 'downloaded':
      return {
        backgroundColor: 'var(--success)',
        color: 'var(--success-foreground)',
      };
    case 'missing':
      return {
        backgroundColor: 'var(--destructive)',
        color: 'var(--destructive-foreground)',
      };
    case 'never_downloaded':
      return {
        backgroundColor: 'transparent',
        color: 'var(--warning)',
      };
    case 'ignored':
      return {
        backgroundColor: 'transparent',
        color: 'var(--muted-foreground)',
      };
    case 'cached':
      return {
        backgroundColor: 'transparent',
        color: 'var(--info)',
      };
    case 'members_only':
    default:
      return {
        backgroundColor: 'transparent',
        color: 'var(--muted-foreground)',
      };
  }
};

export const getMediaTypeInfo = (mediaType?: string | null) => {
  switch (mediaType) {
    case 'short':
      return {
        label: 'Short',
        color: 'secondary' as const,
        icon: <ScheduleIcon size={16} />,
      };
    case 'livestream':
      return {
        label: 'Live',
        color: 'error' as const,
        icon: <VideoLibraryIcon size={16} />,
      };
    default:
      return null;
  }
};
