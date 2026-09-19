/**
 * server/modules/ytstream/youtubeHlsStreamCheck.js
 *
 * Diagnostic for mode=youtube-hls. The player fetches YouTube's video/audio
 * playlists and segments itself, so when it shows audio but no video nothing
 * on this server says why. After a resolve, this fetches (from the server) the
 * chosen video playlist, the audio rendition's playlist and the first segment
 * of each, and logs what came back: HTTP status, container type (from the
 * first bytes), whether segments are encrypted, segment count. It never
 * affects what is served.
 */
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');

const HEAD_BYTES = 16;
const FETCH_TIMEOUT_MS = 15 * 1000;
const HTTP_ERROR_STATUS = 400;
const MPEGTS_SYNC_BYTE = 0x47;
const FMP4_BOX_TYPES = ['ftyp', 'styp', 'moof', 'moov', 'sidx'];
const ADTS_SYNC_MASK = 0xf0;
// ffmpeg's HLS demuxer reads playlist lines into a 4096-byte buffer
// (MAX_URL_SIZE): a longer line is split, which breaks the playlist.
const FFMPEG_MAX_LINE_BYTES = 4096;
const MAX_TAG_LINES_LOGGED = 12;
const TAG_LINE_LOG_CHARS = 100;

/** @returns {string} what the first bytes of a segment look like */
function sniffContainer(bytes) {
  if (!bytes || bytes.length === 0) return 'empty';
  if (bytes.length >= 8 && FMP4_BOX_TYPES.includes(bytes.toString('latin1', 4, 8))) return 'fmp4';
  if (bytes[0] === MPEGTS_SYNC_BYTE) return 'mpegts';
  if (bytes.toString('latin1', 0, 6) === 'WEBVTT') return 'webvtt';
  if (bytes.toString('latin1', 0, 3) === 'ID3') return 'id3-audio';
  if (bytes[0] === 0xff && (bytes[1] & ADTS_SYNC_MASK) === ADTS_SYNC_MASK) return 'adts-audio';
  if (bytes[0] === 0x3c) return 'html-or-xml';
  return 'unknown';
}

async function defaultFetchHead(url) {
  const response = await fetch(url, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const bytes = Buffer.from(await response.arrayBuffer()).subarray(0, HEAD_BYTES);
  response.body?.cancel?.().catch(() => { /* already consumed */ });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentRange: response.headers.get('content-range'),
    contentLength: response.headers.get('content-length'),
    bytes,
  };
}

/** Pulls what the check needs out of a media playlist. */
function readMediaPlaylist(text, playlistUrl) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const segments = lines.filter((line) => !line.startsWith('#'));
  const map = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
  const key = lines.find((line) => line.startsWith('#EXT-X-KEY:'));
  const resolve = (uri) => new URL(uri, playlistUrl).toString();
  const mapUri = map ? (/URI="([^"]*)"/.exec(map) || [])[1] : null;
  const tagLines = [...new Set(lines.filter((line) => line.startsWith('#') && !line.startsWith('#EXTINF')))]
    .slice(0, MAX_TAG_LINES_LOGGED)
    .map((line) => line.slice(0, TAG_LINE_LOG_CHARS));
  const lineLengths = lines.map((line) => Buffer.byteLength(line));
  return {
    firstLine: (lines[0] || '').slice(0, TAG_LINE_LOG_CHARS),
    tagLines,
    maxLineBytes: lineLengths.reduce((max, length) => Math.max(max, length), 0),
    linesOverFfmpegLimit: lineLengths.filter((length) => length >= FFMPEG_MAX_LINE_BYTES).length,
    segmentCount: segments.length,
    firstSegmentUrl: segments.length ? resolve(segments[0]) : null,
    initUrl: mapUri ? resolve(mapUri) : null,
    encryption: key ? ((/METHOD=([A-Z0-9-]+)/.exec(key) || [])[1] || 'unknown') : 'NONE',
    targetDuration: (/#EXT-X-TARGETDURATION:(\d+)/.exec(text || '') || [])[1] || null,
    endList: /#EXT-X-ENDLIST/.test(text || ''),
  };
}

async function describeFetch(url, fetchHead) {
  try {
    const head = await fetchHead(url);
    return {
      status: head.status,
      contentType: head.contentType || null,
      contentRange: head.contentRange || null,
      firstBytesHex: head.bytes ? head.bytes.toString('hex') : null,
      container: sniffContainer(head.bytes),
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * @param {{kind: string, url: string}} target - 'video' or 'audio' media playlist
 * @returns {Promise<object>} what was found (also logged)
 */
async function checkStream(target, { fetchText, fetchHead }) {
  const result = { kind: target.kind, host: new URL(target.url).host };
  let text;
  try {
    text = await fetchText(target.url);
  } catch (err) {
    result.playlistError = err.message;
    return result;
  }
  const media = readMediaPlaylist(text, target.url);
  Object.assign(result, {
    segmentCount: media.segmentCount,
    targetDuration: media.targetDuration,
    endList: media.endList,
    encryption: media.encryption,
    firstLine: media.firstLine,
    tagLines: media.tagLines,
    maxLineBytes: media.maxLineBytes,
    linesOverFfmpegLimit: media.linesOverFfmpegLimit,
  });
  if (media.initUrl) result.init = await describeFetch(media.initUrl, fetchHead);
  if (media.firstSegmentUrl) result.firstSegment = await describeFetch(media.firstSegmentUrl, fetchHead);
  return result;
}

function looksBroken(result) {
  const bad = (part) => part && (part.error || part.status >= HTTP_ERROR_STATUS || part.container === 'html-or-xml' || part.container === 'empty');
  return !!(result.playlistError || result.segmentCount === 0 || result.linesOverFfmpegLimit > 0 || (result.firstLine && result.firstLine !== '#EXTM3U') || (result.encryption && result.encryption !== 'NONE') || bad(result.init) || bad(result.firstSegment));
}

/**
 * Checks each target and logs one line per stream (a warning when something
 * looks wrong). Never throws.
 * @param {{youtubeId: string, targets: Array<{kind: string, url: string}>, fetchText: Function, fetchHead?: Function}} params
 * @returns {Promise<object[]>}
 */
async function checkChosenStreams({ youtubeId, targets, fetchText, fetchHead = defaultFetchHead }) {
  const results = [];
  for (const target of targets) {
    try {
      const result = await checkStream(target, { fetchText, fetchHead });
      results.push(result);
      const broken = looksBroken(result);
      (broken ? logger.warn : logger.info).call(logger, { youtubeId, ...result }, broken
        ? 'ytstream: youtube-hls stream check - this stream looks unplayable from the server side'
        : 'ytstream: youtube-hls stream check - stream reachable');
    } catch (err) {
      streamDebug({ youtubeId, kind: target.kind, err: err.message }, 'ytstream: youtube-hls stream check failed unexpectedly');
    }
  }
  return results;
}

module.exports = { checkChosenStreams, checkStream, sniffContainer, readMediaPlaylist, looksBroken };
