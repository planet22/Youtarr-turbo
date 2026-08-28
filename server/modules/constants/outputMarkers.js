// Control markers passed from the per-video yt-dlp --exec post-processor
// (a separate Node process) to the parent via the yt-dlp stdout stream.
// YtdlpOutputRouter watches for these lines; they are not yt-dlp output.
const VIDEO_PERSISTED_MARKER = '[Youtarr:videoPersisted] ';

// Emitted repeatedly (throttled) during the optional post-download ffmpeg
// transcode (transcodeDownloadedVideo in videoDownloadPostProcessFiles.js),
// carrying a small JSON payload: {"percent":N,"etaSeconds":N,"speedFactor":N}.
// Unlike VIDEO_PERSISTED_MARKER this is a repeating stream, not one-shot.
const TRANSCODE_PROGRESS_MARKER = '[Youtarr:transcodeProgress] ';

module.exports = { VIDEO_PERSISTED_MARKER, TRANSCODE_PROGRESS_MARKER };
