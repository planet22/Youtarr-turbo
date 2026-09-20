const { normalizeUrlToVideoId } = require('../youtubeUrlParser');

// Pure helpers that work out, from data already on a job object, which single
// video a job is about - so job-level events (created / started / finished)
// of a one-video job can be tied to that video instead of showing no video.
// Everything here reads only what the caller already holds; no lookups.

function videoIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = normalizeUrlToVideoId(url);
    return (parsed && parsed.id) || null;
  } catch (err) {
    return null;
  }
}

/**
 * @param {object} job - a jobModule job object
 * @returns {{youtubeId?: string, videoTitle?: string}} empty for multi-video or unknown jobs
 */
function singleVideoRefForJob(job) {
  const nzb = job && job.data && job.data.nzb;
  if (nzb && nzb.youtubeId) {
    return { youtubeId: nzb.youtubeId, videoTitle: nzb.nzbName || undefined };
  }

  const urls = job && job.data && job.data.urls;
  if (Array.isArray(urls) && urls.length === 1) {
    const youtubeId = videoIdFromUrl(urls[0]);
    if (youtubeId) return { youtubeId };
  }

  const videos = job && job.data && job.data.videos;
  if (Array.isArray(videos) && videos.length === 1 && videos[0] && videos[0].youtubeId) {
    return {
      youtubeId: videos[0].youtubeId,
      videoTitle: videos[0].youTubeVideoName || undefined,
      channelName: videos[0].youTubeChannelName || undefined,
    };
  }

  return {};
}

module.exports = { videoIdFromUrl, singleVideoRefForJob };
