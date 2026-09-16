/**
 * server/modules/ytstream/videoResolution.js
 *
 * Resolves the {width, height} a video's real encode/placeholder/probe
 * clip should target. Extracted from server/routes/ytstream.js so it's a
 * real importable module shared by both the cache-finalize concern
 * (resolveActualServedFileInfo's StreamHistory Format column) and the HLS
 * session engine's placeholder/probe-clip warm-up, instead of trapped in
 * that file's private route-factory closure.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');

// Used only when a video's real resolution can't be resolved yet - a plain
// 16:9 fallback, not a target.
const HLS_PLACEHOLDER_FALLBACK_WIDTH = 1280;
const HLS_PLACEHOLDER_FALLBACK_HEIGHT = 720;

/**
 * Resolves the {width, height} the real encode would actually use for this
 * video — a generic fixed resolution would misreport a video's true
 * dimensions to a probe, and looks visibly wrong (letterboxed/stretched) as
 * a "loading" placeholder for a genuinely portrait/unusual-aspect-ratio
 * source. Prefers Video.video_resolution (set from a real downloaded
 * file's own ffprobe); STRM-only videos have no downloaded file to probe,
 * so falls back to reading the .strmtool.json sidecar strmMediaInfoCache.js
 * already writes next to the .strm (same format-selection logic ytstream
 * itself would use to pick a format). Never throws — returns the plain
 * 16:9 fallback if neither source is available yet (e.g. before this
 * video's first STRM materialize has ever run).
 * @returns {Promise<{width: number, height: number}>}
 */
async function resolveVideoTargetResolution(youtubeId, models) {
  const fallback = { width: HLS_PLACEHOLDER_FALLBACK_WIDTH, height: HLS_PLACEHOLDER_FALLBACK_HEIGHT };
  if (!models || !models.Video) {
    streamDebug({ youtubeId, source: 'fallback', reason: 'no Video model injected' }, 'ytstream: resolveVideoTargetResolution');
    return fallback;
  }
  try {
    const video = await models.Video.findOne({
      where: { youtubeId },
      attributes: ['filePath', 'video_resolution'],
    });
    if (!video) {
      streamDebug({ youtubeId, source: 'fallback', reason: 'no Video row (untracked)' }, 'ytstream: resolveVideoTargetResolution');
      return fallback;
    }

    if (video.video_resolution) {
      const match = /^(\d+)x(\d+)$/.exec(String(video.video_resolution).trim());
      if (match) {
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (width > 0 && height > 0) {
          streamDebug({ youtubeId, source: 'Video.video_resolution', width, height }, 'ytstream: resolveVideoTargetResolution');
          return { width, height };
        }
      }
    }

    if (video.filePath && video.filePath.toLowerCase().endsWith('.strm')) {
      const parsed = path.parse(video.filePath);
      const cachePath = path.format({ dir: parsed.dir, name: parsed.name, ext: '.strmtool.json' });
      if (fs.existsSync(cachePath)) {
        const cache = JSON.parse(await fs.promises.readFile(cachePath, 'utf8'));
        const videoStream = Array.isArray(cache.mediaStreams)
          ? cache.mediaStreams.find((s) => s.Type === 1) // MediaStreamType.Video
          : null;
        if (videoStream && videoStream.Width && videoStream.Height) {
          streamDebug({ youtubeId, source: 'strmtool.json', width: videoStream.Width, height: videoStream.Height }, 'ytstream: resolveVideoTargetResolution');
          return { width: videoStream.Width, height: videoStream.Height };
        }
      }
    }
    streamDebug({ youtubeId, source: 'fallback', reason: 'no video_resolution and no usable .strmtool.json', filePath: video.filePath }, 'ytstream: resolveVideoTargetResolution');
  } catch (err) {
    logger.warn({ err, youtubeId }, 'ytstream: failed to resolve target resolution for placeholder/probe clip; using fallback');
  }
  return fallback;
}

module.exports = { resolveVideoTargetResolution };
