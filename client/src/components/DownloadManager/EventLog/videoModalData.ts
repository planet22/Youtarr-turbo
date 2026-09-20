import type { JobEvent } from '../../../types/JobEvent';
import type { VideoModalData } from '../../shared/VideoModal/types';

/**
 * Minimal data for the video detail popup (the one Download History opens)
 * from what a log entry itself recorded. A log entry holds no live library
 * state, so the popup starts from "not downloaded"; it loads the rest of the
 * video's details by id itself.
 */
export function eventToVideoModalData(event: JobEvent): VideoModalData {
  const youtubeId = event.youtubeId as string;
  return {
    youtubeId,
    title: event.videoTitle || youtubeId,
    channelName: event.channelName || '',
    thumbnailUrl: `/images/videothumb-${youtubeId}.jpg`,
    duration: null,
    publishedAt: null,
    addedAt: event.occurredAt,
    mediaType: 'video',
    status: 'never_downloaded',
    isDownloaded: false,
    isStrm: false,
    filePath: null,
    fileSize: null,
    audioFilePath: null,
    audioFileSize: null,
    isProtected: false,
    isIgnored: false,
    normalizedRating: null,
    ratingSource: null,
    databaseId: null,
    channelId: null,
  };
}
