/**
 * server/modules/ytstream/videoBandwidthEstimate.js
 *
 * Shared, dependency-free home for the per-resolution-tier video bandwidth
 * estimate used by both hlsMasterPlaylist.js (its master playlist's
 * BANDWIDTH attribute) and strmMediaInfoCache.js (its per-stream BitRate
 * for transcode=h264, and the aggregate top-level bitrate). Split out from
 * hlsMasterPlaylist.js specifically so strmMediaInfoCache.js doesn't have
 * to pull in that file's own require('./streamDebug') -> configModule.js
 * chain (which reads a real config file at module-load time and breaks
 * any test that mocks fs without a full config behind it) just for this
 * one pure lookup.
 */

// Real encodes are CRF/QP-quality-targeted (see streamEncoderTuning.js), not
// fixed-bitrate, so there is no measured bandwidth to report - these are
// rough per-resolution-tier estimates, generous enough to avoid Jellyfin's
// own much cruder ~20 Mbps default guess forcing unnecessary transcoding,
// but not a precise contract. Sorted ascending by maxHeight; the first tier
// whose maxHeight covers the target height wins.
//
// 1080p bumped from 5_000_000 to 10_000_000 (2026-09-16): a live VAAPI
// QP=15/quality-tuning encode measured at 10,332,348 bps real output (via
// Jellyfin's own PlaybackInfo for the source stream) - the old 5 Mbps
// estimate understated real output by ~2x. Confirmed as one plausible
// cause of AVPlayer's CoreMediaErrorDomain -12318 "Segment exceeds
// specified bandwidth for variant" mid-playback on iOS: Jellyfin's own
// remux is a pure `-codec:v:0 copy` (byte-identical to whatever this
// encoder actually produced), so a BANDWIDTH declaration inherited from an
// understated estimate can be genuinely exceeded by real segments. Other
// tiers scaled by the same ~2x factor pending their own real measurements -
// only 1080p is evidence-based so far.
const VIDEO_BANDWIDTH_BPS_BY_HEIGHT_TIER = [
  { maxHeight: 480, bps: 3_000_000 },
  { maxHeight: 720, bps: 6_000_000 },
  { maxHeight: 1080, bps: 10_000_000 },
  { maxHeight: 1440, bps: 16_000_000 },
  { maxHeight: Infinity, bps: 30_000_000 },
];

/**
 * @param {number} height - target video height in pixels.
 * @returns {number} estimated video-only bandwidth in bits/sec.
 */
function estimateVideoBandwidthBps(height) {
  const tier = VIDEO_BANDWIDTH_BPS_BY_HEIGHT_TIER.find((t) => height <= t.maxHeight)
    || VIDEO_BANDWIDTH_BPS_BY_HEIGHT_TIER[VIDEO_BANDWIDTH_BPS_BY_HEIGHT_TIER.length - 1];
  return tier.bps;
}

module.exports = {
  estimateVideoBandwidthBps,
};
