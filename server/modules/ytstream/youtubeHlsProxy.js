/**
 * server/modules/ytstream/youtubeHlsProxy.js
 *
 * Optional routing of mode=youtube-hls's video/audio playlists and segments
 * through Youtarr (`ytstream.youtubeHlsProxy`):
 *
 *   off    - only the master playlist comes from Youtarr; the player fetches
 *            the media playlists and every segment straight from YouTube
 *            (nothing to see here, the default).
 *   proxy  - Youtarr also serves the video and audio media playlists, so each
 *            play, its quality and its viewers are visible. Segments still go
 *            straight from YouTube to the player.
 *   serve  - additionally every segment URL in those playlists points at
 *            Youtarr, which answers with a 302 redirect to the real YouTube
 *            segment. No video bytes pass through Youtarr, but each segment
 *            request is seen, giving playback position and an estimated data
 *            rate (the bytes themselves are never counted).
 *
 * The playlists are fetched when the master is resolved and kept in a small
 * in-memory registry (same lifetime as the resolved master). The handlers
 * only ever serve or redirect to what is in that registry, so they cannot be
 * used to reach any other URL.
 */
const crypto = require('crypto');
const logger = require('../../logger');
const { streamDebug } = require('./streamDebug');

const PROXY_MODES = ['off', 'proxy', 'serve'];
const REGISTRY_TTL_MS = 30 * 60 * 1000;
const REGISTRY_MAX_ENTRIES = 200;
const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const KEY_PATTERN = /^ythp-[a-f0-9]{20}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;
const PLAYLIST_FILE_PATTERN = /^(video|audio|media)\.m3u8$/;
const KIND_PATTERN = /^(video|audio|media)$/;
const SEGMENT_FILE_PATTERN = /^s(\d{1,6})\.[a-z0-9]{2,5}$/i;
const INIT_FILE_PATTERN = /^init\.[a-z0-9]{2,5}$/i;
const DEFAULT_SEGMENT_EXTENSION = '.ts';
const INIT_EXTENSION = '.mp4';
const BITS_PER_BYTE = 8;

/** @returns {'off'|'proxy'|'serve'} a setting value coerced to a known routing mode */
function normalizeProxyMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return PROXY_MODES.includes(mode) ? mode : 'off';
}

/** @returns {string} the registry key for a resolved playlist (its cache key, hashed) */
function buildProxyKey(cacheKey) {
  return `ythp-${crypto.createHash('sha1').update(String(cacheKey)).digest('hex').slice(0, 20)}`;
}

/** @returns {string} the root-relative URL prefix all of an entry's proxied URLs share */
function proxyBasePath(youtubeId, key) {
  return `/api/ytstream/${encodeURIComponent(youtubeId)}/yth/${key}`;
}

/** @type {Map<string, {youtubeId: string, quality: string, mode: string, expiresAt: number, kinds: object}>} */
const registry = new Map();

function get(key) {
  const entry = registry.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    registry.delete(key);
    streamDebug({ key }, 'ytstream: youtube-hls proxy registry entry expired');
    return null;
  }
  return entry;
}

const has = (key) => get(key) !== null;

/**
 * Stores the playlists of one resolved stream.
 * @param {string} key
 * @param {{youtubeId: string, quality: string, mode: 'proxy'|'serve', kinds: object}} entry
 */
function register(key, entry) {
  if (registry.size >= REGISTRY_MAX_ENTRIES && !registry.has(key)) {
    const evicted = registry.keys().next().value;
    registry.delete(evicted);
    streamDebug({ evicted, max: REGISTRY_MAX_ENTRIES }, 'ytstream: youtube-hls proxy registry full - evicted the oldest entry');
  }
  registry.set(key, { ...entry, expiresAt: Date.now() + REGISTRY_TTL_MS });
  streamDebug(
    { key, youtubeId: entry.youtubeId, mode: entry.mode, kinds: Object.keys(entry.kinds), entries: registry.size },
    'ytstream: youtube-hls proxy registered the playlists'
  );
}

/** @returns {string} `.ts`, `.m4s`... from a segment URL's path, else `.ts` (ffmpeg only follows known extensions) */
function segmentExtension(segmentUrl) {
  try {
    const match = /\.([a-z0-9]{2,5})$/i.exec(new URL(segmentUrl).pathname);
    return match ? `.${match[1].toLowerCase()}` : DEFAULT_SEGMENT_EXTENSION;
  } catch {
    return DEFAULT_SEGMENT_EXTENSION;
  }
}

function absolute(uri, baseUrl) {
  return new URL(uri, baseUrl).toString();
}

function absolutizeTagUri(line, baseUrl) {
  return line.replace(/URI="([^"]*)"/g, (_match, uri) => `URI="${absolute(uri, baseUrl)}"`);
}

/**
 * Parses a media playlist once into everything the handlers need: its
 * segments (URL, duration, start time) and its text in both forms - `proxy`
 * (segment URLs made absolute, still pointing at YouTube) and `serve`
 * (segment/init URLs pointing at Youtarr).
 *
 * @param {object} args
 * @param {'video'|'audio'|'media'} args.kind
 * @param {string} args.playlistUrl - where the text came from (relative URIs resolve against it)
 * @param {string} args.text
 * @param {number} args.bandwidthBps - bits per second of one second of this stream (0 when unknown); used only to estimate bytes
 * @param {string} args.basePath - see proxyBasePath
 */
function buildKindEntry({ kind, playlistUrl, text, bandwidthBps, basePath }) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const segments = [];
  const proxyLines = [];
  const serveLines = [];
  let extension = null;
  let initUrl = null;
  let pendingDuration = 0;
  let position = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
      proxyLines.push(line);
      serveLines.push(line);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      initUrl = absoluteFromTag(line, playlistUrl);
      proxyLines.push(absolutizeTagUri(line, playlistUrl));
      serveLines.push(line.replace(/URI="[^"]*"/, `URI="${basePath}/${kind}/init${INIT_EXTENSION}"`));
    } else if (line.startsWith('#')) {
      const withUris = absolutizeTagUri(line, playlistUrl);
      proxyLines.push(withUris);
      serveLines.push(withUris);
    } else {
      const url = absolute(line, playlistUrl);
      if (extension === null) extension = segmentExtension(url);
      segments.push({ url, durationSeconds: pendingDuration, startSeconds: position });
      position += pendingDuration;
      pendingDuration = 0;
      proxyLines.push(url);
      serveLines.push(`${basePath}/${kind}/s${segments.length - 1}${extension}`);
    }
  }
  return {
    kind,
    playlistUrl,
    segments,
    initUrl,
    bandwidthBps,
    totalSeconds: position,
    texts: { proxy: `${proxyLines.join('\n')}\n`, serve: `${serveLines.join('\n')}\n` },
  };
}

function absoluteFromTag(line, baseUrl) {
  const match = /URI="([^"]*)"/.exec(line);
  return match ? absolute(match[1], baseUrl) : null;
}

/**
 * Express handlers for the proxied playlists and segments.
 * @param {object} deps
 * @param {(req: import('express').Request) => string} deps.resolveClientIp
 * @param {(event: object) => void} deps.onActivity - told about every playlist/segment/init request (feeds the Live Streams row)
 */
function createProxyHandlers({ resolveClientIp, onActivity }) {
  const identify = (req) => ({ clientIp: resolveClientIp(req), userAgent: (req.headers && req.headers['user-agent']) || null });

  function handlePlaylist(req, res) {
    const { youtubeId, key, file } = req.params;
    const match = PLAYLIST_FILE_PATTERN.exec(file || '');
    if (!VIDEO_ID_PATTERN.test(youtubeId || '') || !KEY_PATTERN.test(key || '') || !match) {
      res.status(400).send('Invalid playlist request');
      return;
    }
    const entry = get(key);
    const stream = entry && entry.youtubeId === youtubeId ? entry.kinds[match[1]] : null;
    if (!stream) {
      streamDebug({ youtubeId, key, file }, 'ytstream: youtube-hls proxy playlist not found (expired or never registered) - 404');
      res.status(404).send('This playlist has expired - start the video again');
      return;
    }
    const body = entry.mode === 'serve' ? stream.texts.serve : stream.texts.proxy;
    res.set({ 'Content-Type': PLAYLIST_CONTENT_TYPE, 'Cache-Control': 'no-store' });
    res.status(200).send(body);
    const who = identify(req);
    logger.info(
      { youtubeId, key, kind: match[1], mode: entry.mode, segments: stream.segments.length, bytes: Buffer.byteLength(body), ...who },
      'ytstream: youtube-hls proxy served a media playlist'
    );
    onActivity({ type: 'playlist', key, youtubeId, quality: entry.quality, kind: match[1], mode: entry.mode, bytes: Buffer.byteLength(body), ...who });
  }

  function handleSegment(req, res) {
    const { youtubeId, key, kind, file } = req.params;
    const segmentMatch = SEGMENT_FILE_PATTERN.exec(file || '');
    const isInit = INIT_FILE_PATTERN.test(file || '');
    if (!VIDEO_ID_PATTERN.test(youtubeId || '') || !KEY_PATTERN.test(key || '') || !KIND_PATTERN.test(kind || '') || (!segmentMatch && !isInit)) {
      res.status(400).send('Invalid segment request');
      return;
    }
    const entry = get(key);
    const stream = entry && entry.youtubeId === youtubeId ? entry.kinds[kind] : null;
    const segment = stream && segmentMatch ? stream.segments[Number(segmentMatch[1])] : null;
    const target = isInit ? (stream && stream.initUrl) : (segment && segment.url);
    if (!target) {
      streamDebug({ youtubeId, key, kind, file }, 'ytstream: youtube-hls proxy segment not found - 404');
      res.status(404).send('Segment not found - start the video again');
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.redirect(302, target);
    const who = identify(req);
    const estimatedBytes = segment && stream.bandwidthBps ? Math.round((stream.bandwidthBps * segment.durationSeconds) / BITS_PER_BYTE) : 0;
    streamDebug(
      { youtubeId, key, kind, file, index: segmentMatch ? Number(segmentMatch[1]) : null, positionSeconds: segment ? segment.startSeconds : null, durationSeconds: segment ? segment.durationSeconds : null, estimatedBytes, targetHost: new URL(target).host, ...who },
      'ytstream: youtube-hls proxy redirected a segment request to YouTube (302)'
    );
    onActivity({
      type: isInit ? 'init' : 'segment', key, youtubeId, quality: entry.quality, kind, mode: entry.mode,
      index: segmentMatch ? Number(segmentMatch[1]) : null,
      positionSeconds: segment ? segment.startSeconds : null,
      totalSeconds: stream.totalSeconds,
      segmentCount: stream.segments.length,
      averageSegmentSeconds: stream.segments.length ? stream.totalSeconds / stream.segments.length : 0,
      durationSeconds: segment ? segment.durationSeconds : 0,
      estimatedBytes,
      ...who,
    });
  }

  return { handlePlaylist, handleSegment };
}

/** Test hook: forgets every registered playlist. */
function clearRegistry() {
  registry.clear();
}

module.exports = {
  PROXY_MODES,
  normalizeProxyMode,
  buildProxyKey,
  proxyBasePath,
  buildKindEntry,
  segmentExtension,
  register,
  get,
  has,
  createProxyHandlers,
  clearRegistry,
};
