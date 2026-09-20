const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const { resolveQualityHeight } = require('./ytstream/formatSelection');
const { estimateVideoBandwidthBps } = require('./ytstream/videoBandwidthEstimate');

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

    const container = this._resolveContainer(ytstreamParams, videoFormat && videoFormat.ext);
    if (container) data.container = container;

    // Aggregate overall bitrate - Jellyfin's MediaSourceInfo has a
    // top-level Bitrate alongside per-MediaStream BitRate; this cache
    // previously only ever set the latter. Best-effort addition: could not
    // confirm the exact field name the jinlin-teck/StrmTool plugin's own
    // MediaInfoCacheData wrapper expects for this (repo not locatable to
    // verify), so this follows the SAME camelCase convention as this
    // wrapper's other own fields (size/runTimeTicks/container, which do
    // have confirmed [JsonPropertyName] overrides) rather than guessing
    // blind. Harmless no-op if the plugin doesn't read it. Investigated
    // because a live PlaybackInfo capture showed Jellyfin's own computed
    // sourceBitrate as 216 (bps) for a real ~10 Mbps stream - implausibly
    // low in a way that matches this repo's own prior documented "Size:
    // 162 Bytes" bug (reflecting the tiny .strm pointer file, not the
    // real media) - plausible same bug class, unconfirmed root cause.
    const totalBitrateBps = [videoStream, audioStream]
      .filter(Boolean)
      .reduce((sum, stream) => sum + (stream.BitRate || 0), 0);
    if (totalBitrateBps > 0) data.bitrate = totalBitrateBps;

    return data;
  }

  /**
   * mode=hls/hls-buffer serve a genuine HLS playlist (m3u8 + segments),
   * never a flat file - declaring the real session's own `container`
   * setting (mp4/mkv/ts) here would be the exact same lie the old
   * probe-shortcut synthetic clip told Jellyfin (see probeShortcut.js's
   * doc comment/MAJOR CORRECTION note): this plugin trusts this cache
   * file INSTEAD OF ever probing the .strm URL, so a wrong value here
   * can't be corrected later by a real probe the way the ffprobe path
   * can - Jellyfin would cache "flat file" permanently and fail outright
   * the moment it tries a non-Direct-Play transcode against the real
   * (HLS-shaped) URL.
   *
   * Deliberately independent of per-video yt-dlp metadata (formats/
   * duration/etc.) - only ytstreamParams (global config) decides this -
   * see updateContainerOnly, which relies on that to fix this field even
   * when no cached metadata exists to rebuild the rest of the file.
   * @private
   */
  _resolveContainer(ytstreamParams, fallbackContainer) {
    // mode=hls-byterange (byteRangeHlsMode.js) has TWO delivery styles for
    // the same underlying encode - see that module's own doc comment.
    // byteRangeDeliverAsFile=false (default): a genuine m3u8 playlist, not
    // a flat file - same "genuine playlist" reasoning as hls/hls-buffer
    // above. byteRangeDeliverAsFile=true: the opposite - a genuine flat,
    // Range-servable file is served directly, same as download-cache.
    // Getting either branch backwards for this mode reproduces the exact
    // Container-misdetection bug this whole investigation started from.
    if (ytstreamParams.mode === 'hls-byterange') {
      if (!ytstreamParams.byteRangeDeliverAsFile) return 'hls';
      // Plain file: fMP4, or Matroska when Container is set to mkv.
      return ytstreamParams.container === 'mkv' ? 'mkv' : 'mp4';
    }
    // mode=youtube-hls (youtubeHlsMode.js) serves YouTube's own m3u8 playlist.
    if (ytstreamParams.mode === 'youtube-hls') return 'hls';
    const isHlsMode = ytstreamParams.mode === 'hls' || ytstreamParams.mode === 'hls-buffer';
    // mode=download-cache (downloadCacheMode.js) always serves a real,
    // complete .mp4 - unlike every other mode, it ignores the configured
    // Container setting entirely (see that module's own doc comment), so
    // the ignored setting must not leak into this cache either.
    if (ytstreamParams.mode === 'download-cache') return 'mp4';
    return isHlsMode ? 'hls' : (ytstreamParams.container || fallbackContainer || null);
  }

  /**
   * Patches JUST the `container` field of an EXISTING `.strmtool.json`
   * sidecar to match the current ytstream config, without needing cached
   * yt-dlp metadata - unlike mediaStreams/size/runTimeTicks, container
   * never depended on per-video metadata (see _resolveContainer), so this
   * is safe to do even when there's nothing to rebuild the rest of the
   * file from. Used by regenerateVideoMetadataFiles for STRM videos with
   * no cached info.json - the majority of a STRM-only library, since STRM
   * materialization (strmMaterializer.js) never persists into the
   * info.json cache the way a full download's post-processing does.
   * @param {string} mediaBasePath
   * @param {{mode:string, container:string}} ytstreamParams
   * @returns {'written'|'already-correct'|'no-sidecar'|'write-failed'} distinguishes four
   *   real outcomes a caller needs for accurate reporting - a bare boolean
   *   previously collapsed "checked and already correct" into the same
   *   false as "never checked at all, no sidecar existed to check", which
   *   made regenerateVideoMetadataFiles's UI-facing skip count misleading
   *   (most "skipped" videos had in fact been verified correct).
   */
  updateContainerOnly(mediaBasePath, ytstreamParams) {
    const cachePath = this.getMediaInfoCachePath(mediaBasePath);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (err) {
      logger.info({ cachePath, err: err.message }, 'STRM media info cache container patch: no existing sidecar to read');
      return 'no-sidecar';
    }
    const container = this._resolveContainer(ytstreamParams, data.container);
    if (container === data.container) {
      logger.info({ cachePath, container }, 'STRM media info cache container patch: already correct, no write needed');
      return 'already-correct';
    }
    const previousContainer = data.container;
    data.container = container;
    data.timestamp = new Date().toISOString();
    try {
      fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.warn({ err, cachePath }, 'STRM media info cache container patch failed');
      return 'write-failed';
    }
    logger.info({ cachePath, previousContainer, container }, 'STRM media info cache container patch: written');
    return 'written';
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
    // transcode=h264 re-encodes at QP=15/quality tuning (see
    // streamEncoderTuning.js) - genuinely quality-targeted, not
    // bitrate-targeted, so the SOURCE format's own bitrate (format.tbr)
    // has no real relationship to what this app's own encoder actually
    // produces. Declaring it anyway understated real output by ~2x in a
    // live 1080p test (10,332,348 bps measured vs ~5,000,000 declared) -
    // plausibly why Jellyfin's own remux (a pure -codec:v:0 copy of
    // whatever this encoder produced) hit AVPlayer's CoreMediaErrorDomain
    // -12318 "Segment exceeds specified bandwidth for variant" mid-
    // playback, if it inherits its variant's BANDWIDTH from this same
    // declared BitRate. estimateVideoBandwidthBps is the SAME
    // real-output-informed estimate hlsMasterPlaylist.js's own BANDWIDTH
    // attribute uses, kept in sync via one shared tier table.
    // transcode=copy passes the source through untouched, so format.tbr
    // stays accurate there.
    const bitrateBps = ytstreamParams.transcode === 'h264' && format.height
      ? estimateVideoBandwidthBps(format.height)
      : (format.tbr || format.vbr) * 1000;
    if (bitrateBps) stream.BitRate = Math.round(bitrateBps);
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
