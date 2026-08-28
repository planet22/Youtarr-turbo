const fs = require('fs');
const path = require('path');
const logger = require('../logger');

/**
 * Maps a yt-dlp codec tag (e.g. "avc1.640028", "mp4a.40.2", "vp09.00.10.08")
 * down to a short Jellyfin-style codec name. Unrecognized tags fall back to
 * the leading alphabetic token rather than being guessed.
 * @param {string} ytdlpCodec
 * @returns {string|null}
 */
function mapCodec(ytdlpCodec) {
  const codec = String(ytdlpCodec || '').toLowerCase();
  if (!codec || codec === 'none') return null;
  if (/^(avc1|h264)/.test(codec)) return 'h264';
  if (/^(hev1|hvc1|h265)/.test(codec)) return 'h265';
  if (/^vp0?9/.test(codec)) return 'vp9';
  if (/^vp0?8/.test(codec)) return 'vp8';
  if (/^av01/.test(codec)) return 'av1';
  if (/^mp4a/.test(codec)) return 'aac';
  if (/^opus/.test(codec)) return 'opus';
  if (/^vorbis/.test(codec)) return 'vorbis';
  if (/^mp3/.test(codec)) return 'mp3';
  if (/^ac-?3/.test(codec)) return 'ac3';
  const match = codec.match(/^[a-z0-9]+/);
  return match ? match[0] : null;
}

/**
 * Maps a `strm.quality`/`ytstream.quality` value to a max-height cap, same
 * mapping `resolveQualityHeight` in server/routes/ytstream.js uses. Kept as
 * an independent copy rather than importing from the route module, which is
 * a request-handling factory, not a shared library.
 * @param {string} quality
 * @returns {number|null} null means "no cap" (best)
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
 * Builds a `.strmtool.json` sidecar next to each `.strm` file, matching the
 * caching contract of the jinlin-teck/StrmTool Jellyfin plugin (jellyfin
 * branch): a `MediaInfoCacheData` JSON (isValid/mediaStreams/size/
 * runTimeTicks/container) that the plugin reads BEFORE probing a `.strm`
 * item, so a valid cache file makes it skip probing (and therefore skip
 * spinning up a real yt-dlp/ffmpeg pipeline against YouTube) entirely.
 *
 * Deliberately an approximation, not a reimplementation, of the actual `-f`
 * selector algebra `server/routes/ytstream.js` uses at playback time
 * (getDirectFormatSelector / getDashFormatSelectors / resolveVideoCodec) —
 * this only needs to produce plausible metadata for Jellyfin's UI/probe
 * skip, not predict the exact format that route will serve (which can
 * retry with a different player_client, fall back on 403, or auto-upgrade
 * codec for transcode=copy).
 */
class StrmMediaInfoCache {
  /**
   * @param {string} mediaBasePath - same base path passed to strmGenerator.writeStrmFile
   * @returns {string}
   */
  getMediaInfoCachePath(mediaBasePath) {
    const parsed = path.parse(mediaBasePath);
    return path.format({
      dir: parsed.dir,
      name: parsed.name,
      ext: '.strmtool.json',
    });
  }

  /**
   * @param {string} mediaBasePath
   * @param {object} meta - yt-dlp --dump-single-json metadata (has .formats[], .duration)
   * @param {{mode:string, quality:string, container:string, transcode:string}} ytstreamParams
   * @returns {string|null} absolute path of the written .strmtool.json, or null on failure
   */
  writeMediaInfoCacheFile(mediaBasePath, meta, ytstreamParams) {
    try {
      const cachePath = this.getMediaInfoCachePath(mediaBasePath);
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data = this._buildCacheData(meta, ytstreamParams);
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');

      logger.info({ cachePath, youtubeId: meta && meta.id }, 'STRM media info cache written');
      return cachePath;
    } catch (err) {
      logger.warn({ err, youtubeId: meta && meta.id }, 'STRM media info cache write failed');
      return null;
    }
  }

  /** @private */
  _buildCacheData(meta, ytstreamParams) {
    const formats = Array.isArray(meta.formats) ? meta.formats : [];
    const videoFormat = this._selectVideoFormat(formats, ytstreamParams.quality);
    const audioFormat = this._selectAudioFormat(formats, videoFormat);

    const videoStream = this._buildVideoStream(videoFormat, ytstreamParams);
    const audioStream = this._buildAudioStream(audioFormat, ytstreamParams);

    const data = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      isValid: true,
      mediaStreams: [videoStream, audioStream].filter(Boolean),
    };

    const size = (videoFormat && (videoFormat.filesize || videoFormat.filesize_approx)) || null;
    if (size) data.size = Math.round(size);

    if (typeof meta.duration === 'number' && meta.duration > 0) {
      data.runTimeTicks = Math.round(meta.duration * 10_000_000);
    }

    const container = ytstreamParams.container || (videoFormat && videoFormat.ext) || null;
    if (container) data.container = container;

    return data;
  }

  /** @private */
  _selectVideoFormat(formats, quality) {
    const heightCap = resolveQualityHeight(quality);
    const hasVideo = (f) => f.vcodec && f.vcodec !== 'none';
    let candidates = formats.filter(
      (f) => hasVideo(f) && (heightCap == null || (f.height && f.height <= heightCap))
    );
    if (candidates.length === 0) {
      candidates = formats.filter(hasVideo);
    }
    candidates.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || b.vbr || 0) - (a.tbr || a.vbr || 0));
    return candidates[0] || null;
  }

  /** @private */
  _selectAudioFormat(formats, videoFormat) {
    // Reuse the chosen video format's own audio track if it's progressive
    // (already has both a/v muxed) rather than picking a separate one.
    if (videoFormat && videoFormat.acodec && videoFormat.acodec !== 'none') {
      return videoFormat;
    }
    const hasAudioOnly = (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none');
    const candidates = formats.filter(hasAudioOnly);
    candidates.sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    return candidates[0] || null;
  }

  /**
   * Builds a nested MediaStream entry. Unlike the outer MediaInfoCacheData
   * fields (which have explicit [JsonPropertyName] camelCase overrides in
   * the plugin's C#), Jellyfin's own `MediaBrowser.Model.Entities.MediaStream`
   * class has none, so these must be PascalCase to match its raw property
   * names under System.Text.Json's default (no naming-policy) behavior.
   * `Type` is likewise a plain enum with no [JsonConverter], so it
   * serializes/deserializes as an integer (Audio=0, Video=1), not a string.
   * @private
   */
  _buildVideoStream(format, ytstreamParams) {
    if (!format) return null;
    const codec = ytstreamParams.transcode === 'h264' ? 'h264' : mapCodec(format.vcodec);
    const stream = {
      Index: 0,
      Type: 1, // MediaStreamType.Video
      IsDefault: true,
      IsInterlaced: false,
    };
    if (codec) stream.Codec = codec;
    if (format.width) stream.Width = format.width;
    if (format.height) stream.Height = format.height;
    if (format.fps) {
      stream.AverageFrameRate = format.fps;
      stream.RealFrameRate = format.fps;
    }
    const bitrateKbps = format.tbr || format.vbr;
    if (bitrateKbps) stream.BitRate = Math.round(bitrateKbps * 1000);
    return stream;
  }

  /** @private (see _buildVideoStream for the PascalCase/integer-enum rationale) */
  _buildAudioStream(format, ytstreamParams) {
    if (!format) return null;
    const codec = ytstreamParams.transcode === 'h264' ? 'aac' : mapCodec(format.acodec);
    const stream = {
      Index: 1,
      Type: 0, // MediaStreamType.Audio
      IsDefault: true,
      Language: 'und',
      Channels: format.audio_channels || 2,
    };
    if (codec) stream.Codec = codec;
    if (format.asr) stream.SampleRate = format.asr;
    const bitrateKbps = format.abr || format.tbr;
    if (bitrateKbps) stream.BitRate = Math.round(bitrateKbps * 1000);
    return stream;
  }
}

module.exports = new StrmMediaInfoCache();
