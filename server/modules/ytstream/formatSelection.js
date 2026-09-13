/**
 * server/modules/ytstream/formatSelection.js
 *
 * yt-dlp format-selector construction and quality/resolution helpers shared
 * across ytstream's playback modes - extracted from
 * server/routes/ytstream.js so they're a real importable module instead of
 * trapped in that file's private route-factory closure. strmMediaInfoCache.js
 * and networkTuningBenchmark.js previously kept their own independent copies
 * of a subset of this logic specifically because it wasn't importable
 * before this extraction; both now import this module instead.
 */

const FORMAT_SELECTORS = {
  BroadCompatibility720p:
    'b[protocol!*=m3u8][ext=mp4][height=720]/b[protocol!*=m3u8][ext=mp4][height<=720]/b[height=720]/b[height<=720]',
  Balanced1080p:
    'b[height=1080]/b[height=720]/b[height<=1080]/b[height<=720]/b',
  MaximumQuality: 'b',
};

/**
 * Height cap shared by every quality-resolving call site (direct-family's
 * `getDirectFormatSelector` and hls/hls-buffer's `getDashFormatSelectors`
 * below). The DASH selectors don't need named-preset exact strings — just
 * the height ceiling — since resolution isn't limited to whatever YouTube
 * happens to serve progressively. Returns null for "no cap" (best).
 */
function resolveQualityHeight(quality) {
  const q = String(quality || '720').toLowerCase().trim();
  if (q === 'best' || q === 'max' || q === 'maximum') return null;
  if (q === '720' || q === 'broad' || q === 'compat') return 720;
  if (q === '1080' || q === 'balanced') return 1080;
  const height = Number.parseInt(q, 10);
  return Number.isFinite(height) && height > 0 ? height : 720;
}

/**
 * `strictness` ('fixed' | 'fallback' | 'best', see ytstream.qualityStrictness)
 * controls how the configured height gets turned into a selector:
 * 'best' always ignores it (bare 'b', whatever's actually best-available -
 * for direct mode that's the itag-18-only progressive ceiling); 'fixed'
 * matches only that exact height, no fallback clauses, so yt-dlp fails
 * cleanly (a real "requested format not available") rather than silently
 * substituting a different one; 'fallback' (default, matches this
 * function's long-standing behavior) chains from the exact height down to
 * best-available.
 */
function getDirectFormatSelector(quality, strictness = 'fallback') {
  if (strictness === 'best') return FORMAT_SELECTORS.MaximumQuality;

  const height = resolveQualityHeight(quality);
  if (!height) return FORMAT_SELECTORS.MaximumQuality; // quality itself was best/max/maximum

  if (strictness === 'fixed') {
    return `b[height=${height}]`;
  }

  if (height === 720) return FORMAT_SELECTORS.BroadCompatibility720p;
  if (height === 1080) return FORMAT_SELECTORS.Balanced1080p;
  return (
    `b[protocol!*=m3u8][ext=mp4][height=${height}]/` +
    `b[protocol!*=m3u8][ext=mp4][height<=${height}]/` +
    `b[height=${height}]/` +
    `b[height<=${height}]/` +
    'b'
  );
}

/**
 * Video-only + audio-only selectors for hls/hls-buffer's yt-dlp+ffmpeg
 * pipeline. YouTube only serves progressive (single-file, already-muxed)
 * formats up to 720p — DASH is required for 1080p+, which is why this is
 * a separate selector pair from getDirectFormatSelector.
 */
function getDashFormatSelectors(quality, strictness = 'fallback') {
  const height = resolveQualityHeight(quality);
  let heightFilter = '';
  if (height && strictness !== 'best') {
    heightFilter = strictness === 'fixed' ? `[height=${height}]` : `[height<=${height}]`;
  }
  return {
    videoFormat: `bv*${heightFilter}[vcodec^=avc1]/bv*${heightFilter}`,
    audioFormat: 'ba[acodec^=mp4a]/ba',
  };
}

/**
 * `vcodec` as yt-dlp reports it is a full codec tag (e.g. `avc1.640028`,
 * `vp9`, `av01.0.05M.08`) — only the `avc1`/`h264` prefix means H.264.
 */
function isH264Codec(codec) {
  return /^(avc1|h264)/i.test(String(codec || ''));
}

/**
 * Caps {width, height} at `heightCap` (decrease-only, even width — same
 * semantics as buildVideoEncoderArgs's scale filter), so a placeholder/probe
 * clip matches what the real encode produces when requested quality is
 * lower than the source. Without this a native-4K video at quality=1080 got
 * a 4K placeholder, visibly mismatched once playback handed off to the real
 * first segment.
 * @param {number|null} heightCap - from resolveQualityHeight; null ("best") leaves the source resolution untouched.
 */
function capResolutionToHeight(width, height, heightCap) {
  if (!heightCap || !height || height <= heightCap) return { width, height };
  const scale = heightCap / height;
  return { width: Math.max(2, Math.round((width * scale) / 2) * 2), height: heightCap };
}

module.exports = {
  FORMAT_SELECTORS,
  resolveQualityHeight,
  getDirectFormatSelector,
  getDashFormatSelectors,
  isH264Codec,
  capResolutionToHeight,
};
