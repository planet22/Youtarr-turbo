import { VideoData } from '../../types/VideoData';

type PathFields = Pick<VideoData, 'filePath' | 'audioFilePath' | 'profileFilePath' | 'profileAudioFilePath'>;

/**
 * The file paths to show for a video: a selected user profile's own links
 * when it has them, otherwise the library originals.
 */
export function displayedFilePaths(video: PathFields): string[] {
  return [
    video.profileFilePath || video.filePath,
    video.profileAudioFilePath || video.audioFilePath,
  ].filter((p): p is string => Boolean(p));
}
