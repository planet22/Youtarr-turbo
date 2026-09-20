/**
 * server/modules/ytstream/hlsMasterPlaylist.js
 *
 * `ytstream.hlsMasterPlaylist` (default on): wraps the real media playlist
 * in a thin HLS master playlist (#EXT-X-STREAM-INF with BANDWIDTH/RESOLUTION)
 * instead of serving the media playlist directly at the top-level ytstream
 * URL - the more broadly-compatible, spec-idiomatic HLS shape (Apple's HLS
 * Authoring Guidelines recommend a master playlist even for a single
 * rendition), and it stops Jellyfin guessing a ~20 Mbps default bandwidth on
 * a bare media playlist, which can force needless transcoding on
 * bandwidth-limited clients.
 *
 * CODECS is declared only when `transcode=h264`: that is the one case where
 * the output codec is deterministic (we picked it - always H.264 video +
 * AAC-LC audio, see the buildVideoEncoderArgs/`-c:a aac` callers in
 * probeShortcut.js/hlsEngine.js). Profile and level don't vary by encoder
 * backend, but the constraint-flags byte does: verified live against the
 * real `avcC` box of actual VAAPI-encoded segments, VAAPI writes `08` there,
 * not `00` - see H264_CONSTRAINT_FLAGS_HEX_BY_HARDWARE_MODE. A declared
 * CODECS string that doesn't byte-match the real SPS is a known cause of
 * strict HLS clients refusing to play a stream. Confirmed live: without
 * CODECS, Jellyfin can't confirm compatibility from the manifest alone and
 * falls back to repeatedly re-verifying via its own codec-detection segment
 * fetches instead of trusting the manifest once. `transcode=copy` passes
 * through the source's own real codec, which isn't known without probing
 * it - CODECS is omitted for that case, same as before.
 */
const { streamDebug } = require('./streamDebug');
const { estimateVideoBandwidthBps } = require('./videoBandwidthEstimate');
const { maybeSaveDebugPlaylistCopy } = require('./debugPlaylistCopy');

// Matches the real AAC audio settings every h264 encode pass uses (see
// buildVideoEncoderArgs callers in probeShortcut.js/hlsEngine.js: '-c:a aac
// -b:a 192k'), and is a reasonable stand-in for transcode=copy's passthrough
// audio too - copy's real audio bitrate varies per source, but this is only
// ever an estimate for a BANDWIDTH hint, not billed anywhere.
const AUDIO_BANDWIDTH_BPS = 192_000;

// H.264 "avc1.PPCCLL" codec tag: PP=profile_idc (0x64 = High, what every
// encoder backend here defaults to), CC=constraint flags, LL=level_idc. The
// level itself must cover the resolution actually being encoded (spec
// requirement, and some strict clients reject a level that's too low for
// the declared resolution) - reusing the same height tiers as the
// bandwidth estimate above for one consistent resolution ladder.
const H264_LEVEL_HEX_BY_HEIGHT_TIER = [
  { maxHeight: 480, levelHex: '1e' }, // Level 3.0
  { maxHeight: 720, levelHex: '1f' }, // Level 3.1
  { maxHeight: 1080, levelHex: '28' }, // Level 4.0
  { maxHeight: 1440, levelHex: '32' }, // Level 5.0
  { maxHeight: Infinity, levelHex: '33' }, // Level 5.1 (4K+)
];

// The constraint-flags (CC) byte is NOT the same across encoder backends,
// unlike profile/level - confirmed by decoding the real `avcC` box of live
// VAAPI-encoded segments (both carried `08`, not the previously-assumed
// `00`). Only vaapi has been verified this way; other backends keep the
// prior `00` assumption until checked the same way.
const H264_CONSTRAINT_FLAGS_HEX_BY_HARDWARE_MODE = {
  vaapi: '08',
};
const DEFAULT_H264_CONSTRAINT_FLAGS_HEX = '00';
// AAC-LC (aot=2, "Low Complexity") - what ffmpeg's built-in `aac` encoder
// always produces, matching `-c:a aac` in every h264 encode pass here.
const AAC_LC_CODEC_TAG = 'mp4a.40.2';

/**
 * @param {number} height - target video height in pixels.
 * @returns {number} estimated total (video + audio) bandwidth in bits/sec.
 */
function estimateHlsBandwidthBps(height) {
  return estimateVideoBandwidthBps(height) + AUDIO_BANDWIDTH_BPS;
}

/**
 * @param {string} transcode - the resolved `ytstream.transcode` value.
 * @param {number} height - target video height in pixels.
 * @param {string} hardwareMode - the resolved `ytstream.hardwareMode` value,
 *   for the constraint-flags byte (see H264_CONSTRAINT_FLAGS_HEX_BY_HARDWARE_MODE).
 * @returns {string|null} "avc1.xxxxxx,mp4a.40.2" when the output codec is
 *   deterministic (transcode=h264), else null (transcode=copy passes
 *   through the source's own codec, not known without probing it).
 */
function resolveHlsCodecsString(transcode, height, hardwareMode) {
  if (transcode !== 'h264') return null;
  const tier = H264_LEVEL_HEX_BY_HEIGHT_TIER.find((t) => height <= t.maxHeight)
    || H264_LEVEL_HEX_BY_HEIGHT_TIER[H264_LEVEL_HEX_BY_HEIGHT_TIER.length - 1];
  const constraintFlagsHex = H264_CONSTRAINT_FLAGS_HEX_BY_HARDWARE_MODE[hardwareMode] || DEFAULT_H264_CONSTRAINT_FLAGS_HEX;
  return `avc1.64${constraintFlagsHex}${tier.levelHex},${AAC_LC_CODEC_TAG}`;
}

/**
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} params.bandwidthBps
 * @param {string|null} [params.codecs] - CODECS attribute value, or omitted/null to skip it.
 * @param {string} params.mediaPlaylistUrl - absolute URL of the real media playlist.
 * @returns {string} a complete HLS master playlist, one variant.
 */
function buildHlsMasterPlaylist({ width, height, bandwidthBps, codecs, mediaPlaylistUrl }) {
  const codecsAttr = codecs ? `,CODECS="${codecs}"` : '';
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthBps},RESOLUTION=${width}x${height}${codecsAttr}`,
    mediaPlaylistUrl,
    '',
  ].join('\n');
}

/**
 * Resolves target width/height (same source-resolution lookup the real
 * encoder itself uses) and estimated bandwidth, then builds the master
 * playlist - or returns `rewrittenMediaPlaylist` unchanged when
 * `enabled` is false. Single decision point shared by both the real hls
 * request path (server/routes/ytstream.js) and the probe-shortcut instant-
 * playlist path (probeShortcut.js's tryServeInstantHlsPlaylist), so the two
 * can never drift apart.
 *
 * @param {boolean} params.enabled - ytstream.hlsMasterPlaylist config value.
 * @param {string} params.youtubeId
 * @param {string} params.quality - the resolved quality string (e.g. "1080").
 * @param {string} params.transcode - the resolved `ytstream.transcode` value, for CODECS.
 * @param {string} params.hardwareMode - the resolved `ytstream.hardwareMode` value, for CODECS.
 * @param {object} params.models - Sequelize models, for resolveVideoTargetResolution.
 * @param {string} params.mediaPlaylistUrl - absolute URL of the real media playlist.
 * @param {string} params.rewrittenMediaPlaylist - the media playlist body the
 *   caller would otherwise send at the top level (returned as-is when disabled).
 * @param {(youtubeId: string, models: object) => Promise<{width: number, height: number}>} params.resolveVideoTargetResolution
 * @param {(width: number, height: number, heightCap: number) => {width: number, height: number}} params.capResolutionToHeight
 * @param {(quality: string) => number} params.resolveQualityHeight
 * @returns {Promise<string>}
 */
async function buildHlsTopLevelPlaylistResponse({
  enabled, youtubeId, quality, transcode, hardwareMode, models, mediaPlaylistUrl, rewrittenMediaPlaylist,
  resolveVideoTargetResolution, capResolutionToHeight, resolveQualityHeight,
}) {
  if (!enabled) {
    streamDebug({ youtubeId, enabled: false }, 'ytstream: hlsMasterPlaylist disabled - serving the real media playlist directly at the top level');
    maybeSaveDebugPlaylistCopy({ youtubeId, kind: 'media', content: rewrittenMediaPlaylist });
    return rewrittenMediaPlaylist;
  }
  const sourceResolution = await resolveVideoTargetResolution(youtubeId, models);
  const { width, height } = capResolutionToHeight(sourceResolution.width, sourceResolution.height, resolveQualityHeight(quality));
  const bandwidthBps = estimateHlsBandwidthBps(height);
  const codecs = resolveHlsCodecsString(transcode, height, hardwareMode);
  streamDebug(
    { youtubeId, enabled: true, quality, transcode, sourceResolution, width, height, bandwidthBps, codecs, mediaPlaylistUrl },
    'ytstream: hlsMasterPlaylist enabled - wrapping the real media playlist in a master'
  );
  const masterPlaylist = buildHlsMasterPlaylist({ width, height, bandwidthBps, codecs, mediaPlaylistUrl });
  maybeSaveDebugPlaylistCopy({ youtubeId, kind: 'master', content: masterPlaylist });
  return masterPlaylist;
}

module.exports = {
  estimateHlsBandwidthBps,
  estimateVideoBandwidthBps,
  resolveHlsCodecsString,
  buildHlsMasterPlaylist,
  buildHlsTopLevelPlaylistResponse,
};
