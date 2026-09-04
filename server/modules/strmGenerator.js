const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const configModule = require('./configModule');
const { PROBE_SHORTCUT_USER_AGENT } = require('./ytstreamProbeShortcut');

/**
 * Maps a download-time video codec preference onto the ffmpeg `transcode`
 * option supported by /api/ytstream. Keeps STRM playback consistent with
 * whatever codec the user already chose for regular downloads:
 *   - 'default' -> yt-dlp already prefers H.264/MP4 at <=1080p, so a plain
 *     remux ('copy') is enough and cheapest on CPU.
 *   - 'h264'/'h265' -> explicit codec preference means the user cares about
 *     compatibility/consistency, so force a real re-encode to H.264/AAC
 *     ('h264') since /api/ytstream doesn't (yet) support an h265 output.
 * @param {string} videoCodec
 * @returns {'copy'|'h264'}
 */
function transcodeForVideoCodec(videoCodec) {
  return videoCodec === 'h264' || videoCodec === 'h265' ? 'h264' : 'copy';
}

/**
 * Writes .strm sidecar files for Jellyfin / Emby / Kodi libraries.
 */
class StrmGenerator {
  /**
   * @param {string} youtubeId
   * @param {object} [opts]
   * @param {'youtube'|'ytstream'} [opts.target]
   * @param {string} [opts.proxyBaseUrl]
   * @param {'direct'|'ffmpeg'|'hls'} [opts.ytstreamMode] - overrides ytstream.defaultMode
   * @param {'mp4'|'ts'} [opts.ytstreamContainer] - overrides ytstream.container
   * @param {'copy'|'h264'} [opts.ytstreamTranscode] - overrides ytstream.transcode
   * @param {boolean} [opts.ytstreamFakeLength] - overrides ytstream.calculatedLength
   * @param {string} [opts.quality] - overrides resolved quality (else derived
   *   from strm.quality / preferredResolution)
   * @returns {string} file contents (includes trailing newline)
   */
  buildStrmContent(youtubeId, opts = {}) {
    const cfg = configModule.getConfig();
    const strmCfg = cfg.strm || {};
    const target = opts.target || strmCfg.target || 'ytstream';
    const id = this._normalizeId(youtubeId);

    if (target === 'youtube') {
      return `https://www.youtube.com/watch?v=${id}\n`;
    }

    const base = (
      opts.proxyBaseUrl ||
      strmCfg.proxyBaseUrl ||
      process.env.YOUTARR_PUBLIC_URL ||
      'http://127.0.0.1:3011'
    ).replace(/\/$/, '');

    const url = `${base}${this._buildYtstreamPath(id, cfg, opts)}`;

    // Every .strm file carries the Kodi/Jellyfin pipe-syntax custom
    // User-Agent (`url|User-Agent=value`), unconditionally - not gated on
    // ytstream.probeShortcut or the playback mode. This marker is what lets
    // /api/ytstream tell a metadata probe apart from real playback at all
    // (exploiting a documented Jellyfin bug, jellyfin/jellyfin#10175:
    // ffprobe ignores this override and sends libavformat's bare default
    // "Lavf/x.y.z" UA, while real ffmpeg playback/transcode honors it - see
    // ytstream.js's isLikelyMetadataProbeRequest). Several independent
    // consumers rely on that detection - probeShortcut's own fake-clip
    // shortcut among them - and none of them
    // should silently lose their only signal because an unrelated setting
    // happened to be off. The `ytstream.probeShortcut` config value's job
    // is narrower and purely request-time: once a probe IS detected via
    // this marker, it decides whether to short-circuit with a cached fake
    // clip or fall through to real handling (see evaluateProbeShortcut in
    // ytstream.js) - it has no say over whether the marker itself exists.
    return `${url}|User-Agent=${encodeURIComponent(PROBE_SHORTCUT_USER_AGENT)}\n`;
  }

  /**
   * Resolves the effective `{mode, quality, container, transcode, calculatedLength}`
   * for the ytstream target, using the same precedence chain
   * `buildStrmContent` uses (opts override, then strm/ytstream config, then
   * cfg.preferredResolution/cfg.videoCodec, then hardcoded defaults). Exposed
   * publicly so other consumers (e.g. strmMediaInfoCache.js) can derive the
   * exact same params `/api/ytstream/:id` will see without duplicating this
   * resolution logic.
   * @param {object} cfg - configModule.getConfig()
   * @param {object} [opts] - same opts shape as buildStrmContent
   * @returns {{mode: string, quality: string, container: string, transcode: string, calculatedLength: boolean}}
   */
  resolveYtstreamParams(cfg, opts = {}) {
    const strmCfg = cfg.strm || {};
    const ytCfg = cfg.ytstream || {};

    const mode = opts.ytstreamMode || ytCfg.defaultMode || 'direct';
    const container = opts.ytstreamContainer || ytCfg.container || 'mp4';

    // Quality: STRM-specific override first, then fall back to the user's
    // actual download resolution setting, same as a full download would use.
    const quality = String(
      opts.quality || strmCfg.quality || ytCfg.quality || cfg.preferredResolution || '1080'
    );

    // Transcode: explicit override, else derived from the user's download
    // codec preference so ffmpeg mode matches what they'd get from a
    // regular download.
    const transcode = opts.ytstreamTranscode || ytCfg.transcode || transcodeForVideoCodec(cfg.videoCodec);

    const calculatedLength = Boolean(opts.ytstreamFakeLength ?? ytCfg.calculatedLength);

    return { mode, quality, container, transcode, calculatedLength };
  }

  /**
   * Builds the `/api/ytstream/:id?...` path + query string, carrying over
   * the same quality/codec choices the user already made for regular
   * downloads (`preferredResolution` / `videoCodec`) so STRM playback
   * matches what they'd have gotten from a full download, unless a
   * STRM-specific override (`strm.quality`, `ytstream.*`, or `opts.*`) says
   * otherwise.
   * @private
   */
  _buildYtstreamPath(id, cfg, opts = {}) {
    const { mode, quality, container, transcode, calculatedLength } = this.resolveYtstreamParams(cfg, opts);

    const params = new URLSearchParams({ mode, quality, container, transcode });
    if (calculatedLength) {
      params.set('calculatedLength', '1');
    }
    return `/api/ytstream/${encodeURIComponent(id)}?${params.toString()}`;
  }

  /**
   * @param {string} mediaPath - path with any extension (or none)
   * @returns {string}
   */
  getStrmPath(mediaPath) {
    const parsed = path.parse(mediaPath);
    return path.format({
      dir: parsed.dir,
      name: parsed.name,
      ext: '.strm',
    });
  }

  /**
   * @param {string} mediaPath
   * @param {string} youtubeId
   * @param {object} [opts]
   * @returns {string} absolute path of written .strm
   */
  writeStrmFile(mediaPath, youtubeId, opts = {}) {
    if (!mediaPath) {
      throw new Error('mediaPath is required');
    }

    const strmPath = this.getStrmPath(mediaPath);
    const dir = path.dirname(strmPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = this.buildStrmContent(youtubeId, opts);
    fs.writeFileSync(strmPath, content, 'utf8');

    const cfg = configModule.getConfig();
    logger.info(
      {
        strmPath,
        youtubeId: this._normalizeId(youtubeId),
        target: opts.target || (cfg.strm && cfg.strm.target) || 'ytstream',
      },
      'STRM file written'
    );

    return strmPath;
  }

  _normalizeId(youtubeId) {
    if (!youtubeId || typeof youtubeId !== 'string') {
      throw new Error('youtubeId is required');
    }
    const id = youtubeId.trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
      throw new Error(`Invalid YouTube id: ${youtubeId}`);
    }
    return id;
  }
}

module.exports = new StrmGenerator();

