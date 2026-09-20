/**
 * server/modules/ytstream/youtubeHlsMode.js
 *
 * `mode=youtube-hls`: serves YouTube's OWN HLS VOD playlist for a video
 * instead of producing anything locally.
 *
 * Every other remuxing mode has to invent a file that doesn't exist yet, so
 * its size, index and duration are unknown until the download is done - which
 * is why a player (Jellyfin's ffmpeg in particular) either waits for the whole
 * download or sees a short length. YouTube's HLS playlist is a finished VOD
 * playlist: it lists every segment and its duration up front, so a player
 * knows the exact length from the first byte, can seek anywhere, and starts
 * as soon as the first segment downloads. No ffmpeg, no yt-dlp media
 * download, no local file. By default segments are fetched by the player
 * straight from YouTube's CDN and only the small master playlist goes through
 * here; ytstream.youtubeHlsProxy can also route the media playlists, and the
 * segment requests (as redirects), through Youtarr - see youtubeHlsProxy.js.
 *
 * Flow: one `yt-dlp --dump-single-json` call finds the manifest URL (needs a
 * player client that offers HLS, so web_safari is added to the configured
 * client list), the master playlist is fetched, the variant matching the
 * configured quality is chosen, and either that variant's media playlist is
 * returned directly (audio muxed into the segments, the usual case) or a
 * one-variant master playlist (when audio/subtitles are separate renditions).
 * Every URI is made absolute. Results are cached for a while so repeated
 * probes and plays don't repeat the yt-dlp call.
 *
 * Standalone by design: shares nothing with hlsEngine.js, byteRangeHlsMode.js
 * or downloadCacheMode.js, so it can't regress them. Like the other
 * experimental modes there's no fallback to another mode: it works or 502s.
 *
 * Known limits: manifest URLs expire after a few hours and can be bound to
 * the requesting IP, so the player must reach YouTube from the same network
 * as this server; only what YouTube offers over HLS is available (H.264 up
 * to 1080p); age-restricted/members-only videos need cookies.
 */
const crypto = require('crypto');
const logger = require('../../logger');
const ytDlpRunner = require('../ytDlpRunner');
const { resolveQualityHeight } = require('./formatSelection');
const { streamDebug } = require('./streamDebug');
const { trackStream, untrackStream, failStreamThenUntrack, getStream } = require('./activeStreams');
const { checkChosenStreams } = require('./youtubeHlsStreamCheck');
const proxy = require('./youtubeHlsProxy');

const MANIFEST_PLAYER_CLIENT = 'web_safari';
const INFO_FETCH_TIMEOUT_MS = 30 * 1000;
const PLAYLIST_FETCH_TIMEOUT_MS = 15 * 1000;
// YouTube's manifest/segment URLs stay valid for hours; this is far inside that.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
// The Live Streams row: the player fetches segments straight from YouTube, so
// this server only ever sees the playlist request. A row is therefore held
// for the video's length after the last playlist request (never less than
// the floor), then dropped - or earlier by Stop.
const SESSION_HOLD_FLOOR_MS = 10 * 60 * 1000;
const SESSION_HOLD_PADDING_MS = 5 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 30 * 1000;
// With segments routed through Youtarr (youtubeHlsProxy = serve) activity is
// visible, so a row can end soon after the player stops asking.
const SERVE_IDLE_HOLD_MS = 3 * 60 * 1000;

/** streamId -> { lastRequestAt, holdMs } for every Live Streams row this mode owns */
const trackedSessions = new Map();
let sweepTimer = null;

/** cacheKey -> { playlist: string, expiresAt: number } */
const playlistCache = new Map();
/** cacheKey -> Promise<string>, so concurrent requests for one video share a single resolve */
const inFlight = new Map();

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/** Compact facts about a playlist for the debug log (never the playlist itself: its URLs are signed). */
function summarizePlaylist(text) {
  const lines = String(text || '').split(/\r?\n/);
  const segmentUris = lines.filter((line) => line.trim() && !line.trim().startsWith('#'));
  return {
    bytes: String(text || '').length,
    lines: lines.length,
    segmentCount: segmentUris.length,
    durationSeconds: playlistDurationSeconds(text),
    hasEndList: /#EXT-X-ENDLIST/.test(text || ''),
    playlistType: (/#EXT-X-PLAYLIST-TYPE:(\w+)/.exec(text || '') || [])[1] || null,
    targetDuration: (/#EXT-X-TARGETDURATION:(\d+)/.exec(text || '') || [])[1] || null,
    hasInitSegment: /#EXT-X-MAP:/.test(text || ''),
    firstSegmentHost: segmentUris.length ? hostOf(segmentUris[0]) : null,
  };
}

/** Splits `KEY=value,KEY2="quoted, value"` into an object (quoted values lose their quotes). */
function parseAttributes(text) {
  const attrs = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const raw = match[2];
    attrs[match[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attrs;
}

/** @returns {string} `uri` resolved against `baseUrl` (absolute URIs pass through). */
function absoluteUrl(uri, baseUrl) {
  return new URL(uri, baseUrl).toString();
}

/** Makes the `URI="..."` attribute of a tag line absolute. */
function absolutizeTagUri(line, baseUrl) {
  return line.replace(/URI="([^"]*)"/g, (_match, uri) => `URI="${absoluteUrl(uri, baseUrl)}"`);
}

/**
 * @param {object} info - yt-dlp --dump-single-json output
 * @returns {string|null} the master playlist URL of the first HLS format, if any
 */
function pickManifestUrl(info) {
  const formats = Array.isArray(info && info.formats) ? info.formats : [];
  const hls = formats.find((format) => format && typeof format.manifest_url === 'string' && format.manifest_url);
  return hls ? hls.manifest_url : null;
}

/**
 * Parses a master playlist into its shared header tags, its EXT-X-MEDIA
 * renditions and its variants. A playlist with no variants is a media
 * playlist (returned with `variants: []`).
 */
function parseMasterPlaylist(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = [];
  const media = [];
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const uri = (lines[i + 1] || '').trim();
      const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const resolution = /^(\d+)x(\d+)$/.exec(attrs.RESOLUTION || '');
      variants.push({ infLine: line, uri, attrs, height: resolution ? Number(resolution[2]) : null });
      i += 1;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      media.push({ line, attrs: parseAttributes(line.slice('#EXT-X-MEDIA:'.length)) });
    } else if (line === '#EXTM3U' || line.startsWith('#EXT-X-VERSION') || line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
      header.push(line);
    }
  }
  return { header, media, variants };
}

const isAvc = (variant) => /avc1/i.test(variant.attrs.CODECS || '');
const bandwidth = (variant) => Number(variant.attrs.BANDWIDTH) || 0;

/**
 * Picks the variant for a quality setting: the tallest one at or under the
 * target height (H.264 preferred, then the highest bitrate). With none under
 * the target, `strictness === 'fixed'` gives up and anything else takes the
 * shortest one above it. A null target means "best".
 * @returns {object|null}
 */
function chooseVariant(variants, targetHeight, strictness) {
  const candidates = variants.filter((variant) => variant.height !== null && variant.uri);
  if (candidates.length === 0) return null;
  const better = (a, b) => (b.height - a.height) || (Number(isAvc(b)) - Number(isAvc(a))) || (bandwidth(b) - bandwidth(a));
  if (targetHeight === null || strictness === 'best') return [...candidates].sort(better)[0];
  const atOrUnder = candidates.filter((variant) => variant.height <= targetHeight);
  if (atOrUnder.length > 0) return [...atOrUnder].sort(better)[0];
  if (strictness === 'fixed') return null;
  return [...candidates].sort((a, b) => (a.height - b.height) || better(a, b))[0];
}

/**
 * Group attributes a variant can point at that the player needs to play it
 * (audio/video renditions). SUBTITLES is deliberately not one: YouTube's
 * caption playlists are WebVTT behind URLs ffmpeg refuses, and the failed
 * open leaves its HTTP connection half-read, so the video playlist requested
 * right after it fails with "Invalid data" and the player ends up with audio
 * only (seen with Jellyfin's ffmpeg). Captions are dropped from the master.
 */
const RENDITION_GROUP_ATTRS = ['AUDIO', 'VIDEO'];
const DROPPED_GROUP_ATTRS = ['SUBTITLES', 'CLOSED-CAPTIONS'];

const ORIGINAL_MARKER = /original|acont(=|%3D)original/i;

/** @returns {boolean} whether two language tags share a primary subtag ('en' matches 'en-US') */
function sameLanguage(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase().split(/[-_]/)[0] === String(b).toLowerCase().split(/[-_]/)[0];
}

/**
 * Picks the rendition of a group to serve. Dubbed videos list every language
 * (alphabetically, the original often last), so "the first" is usually a dub:
 *   0. the language the user asked for (ytstream.audioLanguage), when offered
 *   1. one YouTube marks as the original (its name or tags say "original")
 *   2. one in the video's own language (yt-dlp's `language`)
 *   3. one flagged DEFAULT=YES
 *   4. the first
 * @param {object[]} renditions - EXT-X-MEDIA items of one group
 * @param {string|null} audioLanguage - the video's own language
 * @param {string|null} [preferredLanguage] - the user's choice ('en', 'de', 'pt-BR'...)
 * @returns {{item: object, reason: string} | null}
 */
function chooseRendition(renditions, audioLanguage, preferredLanguage = null) {
  if (renditions.length === 0) return null;
  if (preferredLanguage) {
    const matches = renditions.filter((item) => sameLanguage(item.attrs.LANGUAGE, preferredLanguage));
    const requested = matches.find((item) => ORIGINAL_MARKER.test(item.line)) || matches[0];
    if (requested) return { item: requested, reason: `requested language ${preferredLanguage}` };
  }
  const original = renditions.find((item) => ORIGINAL_MARKER.test(item.line));
  if (original) return { item: original, reason: 'marked original' };
  const inLanguage = audioLanguage && renditions.find((item) => sameLanguage(item.attrs.LANGUAGE, audioLanguage));
  if (inLanguage) return { item: inLanguage, reason: `video language ${audioLanguage}` };
  const flagged = renditions.find((item) => item.attrs.DEFAULT === 'YES');
  if (flagged) return { item: flagged, reason: 'DEFAULT=YES' };
  return { item: renditions[0], reason: 'first listed' };
}

/** @returns {string} an EXT-X-MEDIA line, made the default rendition of its group */
function markDefault(item) {
  if (item.attrs.DEFAULT === 'YES') return item.line;
  return /DEFAULT=/.test(item.line) ? item.line.replace(/DEFAULT=\w+/, 'DEFAULT=YES') : `${item.line},DEFAULT=YES`;
}

/** @returns {string} the tag line without the given attribute (quoted or bare) */
function stripAttribute(line, name) {
  return line.replace(new RegExp(`,${name}=("[^"]*"|[^,]*)`, 'g'), '').replace(new RegExp(`(:)${name}=("[^"]*"|[^,]*),?`), '$1');
}

function variantRenditionGroups(variant) {
  return RENDITION_GROUP_ATTRS.filter((key) => variant.attrs[key]).map((key) => ({ type: key, id: variant.attrs[key] }));
}

/**
 * Builds the playlist to hand the player for a chosen variant: a one-variant
 * master carrying only the renditions that variant references. All URIs
 * absolute.
 */
function buildFilteredMaster(parsed, variant, masterUrl, options = {}) {
  const groups = variantRenditionGroups(variant);
  const lines = [...parsed.header];
  // One rendition per group. Videos with dubbed audio list every language,
  // and offering all of them makes a player fetch each playlist and often
  // pick a dub - see chooseRendition for how the one kept is chosen.
  for (const group of groups) {
    const renditions = parsed.media.filter((item) => item.attrs.TYPE === group.type && item.attrs['GROUP-ID'] === group.id);
    const chosen = chooseRendition(renditions, options.audioLanguage, options.preferredLanguage);
    if (!chosen) continue;
    let mediaLine = absolutizeTagUri(markDefault(chosen.item), masterUrl);
    if (group.type === 'AUDIO' && options.uriOverrides && options.uriOverrides.audioUri) {
      mediaLine = mediaLine.replace(/URI="[^"]*"/, `URI="${options.uriOverrides.audioUri}"`);
    }
    lines.push(mediaLine);
  }
  const infLine = DROPPED_GROUP_ATTRS.reduce((line, name) => stripAttribute(line, name), variant.infLine);
  lines.push(infLine, (options.uriOverrides && options.uriOverrides.variantUri) || absoluteUrl(variant.uri, masterUrl));
  return `${lines.join('\n')}\n`;
}

/** Makes every URI in a media playlist absolute (segment lines and URI="..." tags). */
function absolutizeMediaPlaylist(text, playlistUrl) {
  return `${String(text || '').split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return absolutizeTagUri(trimmed, playlistUrl);
    return absoluteUrl(trimmed, playlistUrl);
  }).join('\n')}\n`;
}

/** True when the text is a complete VOD media playlist (every segment listed, ended). */
function isCompleteMediaPlaylist(text) {
  return /#EXTINF:/.test(text) && /#EXT-X-ENDLIST/.test(text);
}

async function defaultFetchText(url) {
  const startedAt = Date.now();
  streamDebug({ host: hostOf(url), timeoutMs: PLAYLIST_FETCH_TIMEOUT_MS }, 'ytstream: youtube-hls fetching a playlist');
  const response = await fetch(url, { signal: AbortSignal.timeout(PLAYLIST_FETCH_TIMEOUT_MS) });
  streamDebug(
    { host: hostOf(url), status: response.status, contentType: response.headers.get('content-type'), ms: Date.now() - startedAt },
    'ytstream: youtube-hls playlist response headers received'
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${hostOf(url)}`);
  const text = await response.text();
  streamDebug({ host: hostOf(url), bytes: text.length, totalMs: Date.now() - startedAt }, 'ytstream: youtube-hls playlist body read');
  return text;
}

async function defaultFetchInfo(youtubeId, playerClient) {
  const clients = [playerClient || 'default', MANIFEST_PLAYER_CLIENT]
    .flatMap((value) => String(value).split(','))
    .filter((value, index, all) => value && all.indexOf(value) === index);
  const startedAt = Date.now();
  streamDebug(
    { youtubeId, configuredPlayerClient: playerClient || null, effectiveClients: clients, timeoutMs: INFO_FETCH_TIMEOUT_MS },
    'ytstream: youtube-hls running yt-dlp --dump-single-json to find the HLS manifest'
  );
  try {
    const info = await ytDlpRunner.fetchMetadata(
      `https://www.youtube.com/watch?v=${youtubeId}`,
      INFO_FETCH_TIMEOUT_MS,
      { extractorArgs: `youtube:player_client=${clients.join(',')}` }
    );
    const formats = Array.isArray(info && info.formats) ? info.formats : [];
    streamDebug(
      {
        youtubeId,
        ms: Date.now() - startedAt,
        title: info && info.title,
        durationSeconds: info && info.duration,
        isLive: info && info.is_live,
        availability: info && info.availability,
        formatCount: formats.length,
        hlsFormatCount: formats.filter((format) => format && format.manifest_url).length,
        protocols: [...new Set(formats.map((format) => format && format.protocol).filter(Boolean))],
      },
      'ytstream: youtube-hls yt-dlp metadata received'
    );
    return info;
  } catch (err) {
    streamDebug({ youtubeId, ms: Date.now() - startedAt, err: err.message }, 'ytstream: youtube-hls yt-dlp metadata call failed');
    throw err;
  }
}

/**
 * youtubeHlsProxy = proxy/serve: fetches the chosen video (and audio) media
 * playlists now, registers them so Youtarr can serve them, and returns the
 * Youtarr URLs to put in the master in place of YouTube's.
 * @returns {Promise<{variantUri: string, audioUri: string|null}>}
 */
async function routePlaylistsThroughProxy({ youtubeId, quality, routing, proxyKey, variant, variantUrl, audioUrl, fetchText }) {
  const basePath = proxy.proxyBasePath(youtubeId, proxyKey);
  const [videoText, audioText] = await Promise.all([fetchText(variantUrl), audioUrl ? fetchText(audioUrl) : Promise.resolve(null)]);
  const kinds = { video: proxy.buildKindEntry({ kind: 'video', playlistUrl: variantUrl, text: videoText, bandwidthBps: bandwidth(variant), basePath }) };
  if (audioText !== null) kinds.audio = proxy.buildKindEntry({ kind: 'audio', playlistUrl: audioUrl, text: audioText, bandwidthBps: 0, basePath });
  proxy.register(proxyKey, { youtubeId, quality, mode: routing, kinds });
  logger.info(
    { youtubeId, routing, videoSegments: kinds.video.segments.length, audioSegments: kinds.audio ? kinds.audio.segments.length : 0, durationSeconds: kinds.video.totalSeconds },
    'ytstream: youtube-hls routing the video and audio playlists through Youtarr'
  );
  return { variantUri: `${basePath}/video.m3u8`, audioUri: audioText !== null ? `${basePath}/audio.m3u8` : null };
}

/**
 * Resolves a video to the playlist text to serve. Throws a descriptive Error
 * when YouTube offers no HLS manifest or no variant fits the quality.
 * @param {object} params - youtubeId, quality, qualityStrictness, playerClient
 * @param {{fetchInfo?: Function, fetchText?: Function}} [deps] - injectable for tests
 */
async function resolvePlaylist({ youtubeId, quality, qualityStrictness, playerClient, preferredLanguage, proxyMode = 'off', proxyKey = null }, deps = {}) {
  const fetchInfo = deps.fetchInfo || defaultFetchInfo;
  const fetchText = deps.fetchText || defaultFetchText;
  // Routing needs a registry key; without one (a dry run) nothing is registered.
  const routing = proxyKey ? proxy.normalizeProxyMode(proxyMode) : 'off';

  logger.info({ youtubeId, quality }, 'ytstream: youtube-hls resolving YouTube\'s HLS manifest via yt-dlp');
  const info = await fetchInfo(youtubeId, playerClient);
  const manifestUrl = pickManifestUrl(info);
  streamDebug({ youtubeId, manifestHost: manifestUrl ? hostOf(manifestUrl) : null, found: !!manifestUrl }, 'ytstream: youtube-hls looked for a manifest_url in the yt-dlp formats');
  if (!manifestUrl) {
    throw new Error('YouTube offered no HLS manifest for this video (live, age-restricted or members-only, or the player client does not expose one)');
  }

  const masterText = await fetchText(manifestUrl);
  const parsed = parseMasterPlaylist(masterText);
  streamDebug(
    {
      youtubeId,
      master: summarizePlaylist(masterText),
      variantCount: parsed.variants.length,
      renditionCount: parsed.media.length,
      variants: parsed.variants.map((v) => ({
        height: v.height, bandwidth: bandwidth(v), codecs: v.attrs.CODECS || null, avc: isAvc(v), groups: variantRenditionGroups(v).map((g) => `${g.type}:${g.id}`),
      })),
    },
    'ytstream: youtube-hls parsed the master playlist'
  );
  if (parsed.variants.length === 0) {
    // Already a media playlist.
    streamDebug({ youtubeId }, 'ytstream: youtube-hls manifest is already a media playlist - serving it with absolute URLs');
    if (deps.onChoice) deps.onChoice({ manifestHost: hostOf(manifestUrl), routing, servedAs: 'media playlist (the manifest was already one)' });
    if (routing === 'serve') {
      const media = proxy.buildKindEntry({ kind: 'media', playlistUrl: manifestUrl, text: masterText, bandwidthBps: 0, basePath: proxy.proxyBasePath(youtubeId, proxyKey) });
      proxy.register(proxyKey, { youtubeId, quality, mode: routing, kinds: { media } });
      return media.texts.serve;
    }
    return absolutizeMediaPlaylist(masterText, manifestUrl);
  }

  const targetHeight = resolveQualityHeight(quality);
  const variant = chooseVariant(parsed.variants, targetHeight, qualityStrictness);
  streamDebug(
    { youtubeId, quality, targetHeight, qualityStrictness, chosenHeight: variant && variant.height, gaveUp: !variant },
    'ytstream: youtube-hls variant selection'
  );
  if (!variant) {
    const offered = parsed.variants.map((v) => v.height).filter(Boolean).join(', ');
    throw new Error(`No HLS variant at or under ${targetHeight}p (offered: ${offered || 'none'})`);
  }

  logger.info(
    {
      youtubeId,
      requestedQuality: quality,
      chosenHeight: variant.height,
      chosenBandwidth: bandwidth(variant),
      chosenCodecs: variant.attrs.CODECS || null,
      offeredHeights: parsed.variants.map((v) => v.height).filter(Boolean),
      separateRenditions: variantRenditionGroups(variant).map((group) => group.type),
    },
    'ytstream: youtube-hls chose an HLS variant'
  );
  const variantUrl = absoluteUrl(variant.uri, manifestUrl);
  const choice = {
    manifestHost: hostOf(manifestUrl),
    offeredHeights: parsed.variants.map((v) => v.height).filter(Boolean),
    chosenHeight: variant.height,
    chosenBandwidth: bandwidth(variant),
    chosenCodecs: variant.attrs.CODECS || null,
    separateRenditions: variantRenditionGroups(variant).map((group) => group.type),
  };
  // Audio muxed into the segments (no separate rendition groups): serve the
  // media playlist itself, so the player gets the full segment list - and so
  // the exact duration - from this one response.
  if (variantRenditionGroups(variant).length === 0) {
    const mediaText = await fetchText(variantUrl);
    const complete = isCompleteMediaPlaylist(mediaText);
    streamDebug({ youtubeId, height: variant.height, variantHost: hostOf(variantUrl), media: summarizePlaylist(mediaText), complete }, 'ytstream: youtube-hls fetched the variant media playlist');
    if (complete && routing === 'serve') {
      const media = proxy.buildKindEntry({ kind: 'media', playlistUrl: variantUrl, text: mediaText, bandwidthBps: bandwidth(variant), basePath: proxy.proxyBasePath(youtubeId, proxyKey) });
      proxy.register(proxyKey, { youtubeId, quality, mode: routing, kinds: { media } });
      if (deps.onChoice) deps.onChoice({ ...choice, routing, servedAs: 'media playlist with segment URLs served by Youtarr (audio muxed)', segmentCount: media.segments.length, durationSeconds: media.totalSeconds });
      return media.texts.serve;
    }
    if (complete) {
      const served = absolutizeMediaPlaylist(mediaText, variantUrl);
      streamDebug({ youtubeId, height: variant.height, served: summarizePlaylist(served) }, 'ytstream: youtube-hls serving the variant media playlist directly');
      if (deps.onChoice) deps.onChoice({ ...choice, servedAs: 'media playlist (audio muxed into the segments)', segmentCount: summarizePlaylist(served).segmentCount, durationSeconds: playlistDurationSeconds(served) });
      return served;
    }
    streamDebug({ youtubeId }, 'ytstream: youtube-hls media playlist was not a complete VOD playlist (no segments or no ENDLIST) - falling back to a one-variant master');
  } else {
    streamDebug({ youtubeId, groups: variantRenditionGroups(variant) }, 'ytstream: youtube-hls variant uses separate renditions - serving a one-variant master so the player can find them');
  }
  const audioLanguage = (info && info.language) || null;
  const audioRenditions = parsed.media.filter((item) => item.attrs.TYPE === 'AUDIO' && item.attrs['GROUP-ID'] === variant.attrs.AUDIO);
  const chosenAudio = chooseRendition(audioRenditions, audioLanguage, preferredLanguage);
  const audioUrl = chosenAudio && chosenAudio.item.attrs.URI ? absoluteUrl(chosenAudio.item.attrs.URI, manifestUrl) : null;
  const uriOverrides = routing === 'off'
    ? null
    : await routePlaylistsThroughProxy({ youtubeId, quality, routing, proxyKey, variant, variantUrl, audioUrl, fetchText });
  const master = buildFilteredMaster(parsed, variant, manifestUrl, { audioLanguage, preferredLanguage, uriOverrides });
  streamDebug({ youtubeId, height: variant.height, routing, served: summarizePlaylist(master) }, 'ytstream: youtube-hls serving a one-variant master playlist');
  logger.info(
    {
      youtubeId,
      videoLanguage: audioLanguage,
      requestedLanguage: preferredLanguage || null,
      offered: audioRenditions.map((item) => ({ language: item.attrs.LANGUAGE || null, name: item.attrs.NAME || null, default: item.attrs.DEFAULT === 'YES', original: ORIGINAL_MARKER.test(item.line) })),
      chosen: chosenAudio ? { language: chosenAudio.item.attrs.LANGUAGE || null, name: chosenAudio.item.attrs.NAME || null, reason: chosenAudio.reason } : null,
    },
    'ytstream: youtube-hls chose the audio rendition'
  );
  if (deps.onChoice) {
    deps.onChoice({
      ...choice,
      routing,
      servedAs: 'one-variant master (separate audio playlist)',
      audio: {
        videoLanguage: audioLanguage,
        requestedLanguage: preferredLanguage || null,
        offered: audioRenditions.map((item) => ({ language: item.attrs.LANGUAGE || null, name: item.attrs.NAME || null, default: item.attrs.DEFAULT === 'YES', original: ORIGINAL_MARKER.test(item.line) })),
        chosen: chosenAudio ? { language: chosenAudio.item.attrs.LANGUAGE || null, name: chosenAudio.item.attrs.NAME || null, reason: chosenAudio.reason } : null,
      },
    });
  }
  // Diagnostic only, not awaited: shows in the log whether the video and audio
  // playlists/segments the player is about to fetch are reachable from here.
  // Skipped when routing through Youtarr, which has just fetched both playlists.
  if (routing === 'off') {
    checkChosenStreams({
      youtubeId,
      targets: [
        { kind: 'video', url: variantUrl },
        ...(audioUrl ? [{ kind: 'audio', url: audioUrl }] : []),
      ],
      fetchText,
      fetchHead: deps.fetchHead,
    }).catch((err) => streamDebug({ youtubeId, err: err.message }, 'ytstream: youtube-hls stream check crashed'));
  }
  return master;
}

function cacheGet(key) {
  const entry = playlistCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    streamDebug({ key }, 'ytstream: youtube-hls cached playlist expired - dropping it');
    playlistCache.delete(key);
    return null;
  }
  return entry.playlist;
}

function cacheSet(key, playlist) {
  if (playlistCache.size >= CACHE_MAX_ENTRIES) {
    const evicted = playlistCache.keys().next().value;
    playlistCache.delete(evicted);
    streamDebug({ evicted, max: CACHE_MAX_ENTRIES }, 'ytstream: youtube-hls playlist cache full - evicted the oldest entry');
  }
  playlistCache.set(key, { playlist, expiresAt: Date.now() + CACHE_TTL_MS });
  streamDebug({ key, ttlMs: CACHE_TTL_MS, entries: playlistCache.size }, 'ytstream: youtube-hls cached the resolved playlist');
}

/**
 * Cached, de-duplicated resolve: repeated probes/plays of one video within the
 * TTL cost nothing, and concurrent requests share a single yt-dlp call.
 */
async function getPlaylist(params, deps) {
  const proxyMode = proxy.normalizeProxyMode(params.proxyMode);
  const key = `${params.youtubeId}|${resolveQualityHeight(params.quality)}|${params.qualityStrictness}|${params.preferredLanguage || ''}|${proxyMode}`;
  const proxyKey = proxyMode === 'off' ? null : proxy.buildProxyKey(key);
  let cached = cacheGet(key);
  // The master points at registered playlists: without them it would 404.
  if (cached && proxyKey && !proxy.has(proxyKey)) {
    streamDebug({ key, proxyKey }, 'ytstream: youtube-hls cached master has no registered playlists any more - resolving again');
    playlistCache.delete(key);
    cached = null;
  }
  if (cached) {
    streamDebug({ key }, 'ytstream: youtube-hls playlist cache hit');
    return { playlist: cached, cached: true };
  }
  if (inFlight.has(key)) {
    streamDebug({ key }, 'ytstream: youtube-hls joining an already-running resolve for this video');
  } else {
    streamDebug({ key }, 'ytstream: youtube-hls playlist cache miss - starting a resolve');
    const pending = resolvePlaylist({ ...params, proxyMode, proxyKey }, deps)
      .then((playlist) => {
        cacheSet(key, playlist);
        return playlist;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return { playlist: await inFlight.get(key), cached: false };
}

/** @returns {number|null} the summed #EXTINF durations in seconds, or null when the text lists no segments */
function playlistDurationSeconds(text) {
  let total = 0;
  let found = false;
  for (const match of String(text || '').matchAll(/#EXTINF:([\d.]+)/g)) {
    total += Number(match[1]);
    found = true;
  }
  return found ? total : null;
}

function buildStreamId(youtubeId, quality) {
  return `yth-${crypto.createHash('sha1').update(`${youtubeId}|${quality}`).digest('hex').slice(0, 20)}`;
}

function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    streamDebug({ rows: trackedSessions.size }, 'ytstream: youtube-hls Live Streams sweep tick');
    for (const [streamId, session] of trackedSessions) {
      if (now - session.lastRequestAt <= session.holdMs) continue;
      trackedSessions.delete(streamId);
      const ended = getStream(streamId);
      logger.info(
        { streamId, idleMs: now - session.lastRequestAt, segmentsServed: (ended && ended.segmentsServed) || 0, totalMB: ended ? Number((ended.bytesTransferred / (1024 * 1024)).toFixed(1)) : null, estimated: !!(ended && ended.bytesEstimated) },
        'ytstream: youtube-hls Live Streams row expired'
      );
      untrackStream(streamId, 'idle-timeout', null);
    }
    if (trackedSessions.size === 0) {
      clearInterval(sweepTimer);
      sweepTimer = null;
      streamDebug({}, 'ytstream: youtube-hls Live Streams sweeper stopped - no rows');
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/**
 * Makes sure this video/quality has a Live Streams row and records the
 * requesting client against it. A request for a video already shown just
 * joins the row (one row per video, several viewers).
 * @returns {{streamId: string, created: boolean}}
 */
function touchLiveRow({ youtubeId, quality, clientIp, userAgent }) {
  const streamId = buildStreamId(youtubeId, quality);
  const now = Date.now();
  const existing = getStream(streamId);
  if (existing) {
    existing.lastActivityAt = now;
    if (existing.viewers) existing.viewers.set(clientIp || 'unknown', { userAgent: userAgent || null, lastSeen: now });
    const session = trackedSessions.get(streamId);
    if (session) session.lastRequestAt = now;
    streamDebug(
      { streamId, youtubeId, quality, clientIp, viewers: existing.viewers ? existing.viewers.size : null, state: existing.state },
      'ytstream: youtube-hls request joined an existing Live Streams row'
    );
    return { streamId, created: false };
  }
  trackStream({
    streamId,
    mode: 'youtube-hls',
    youtubeId,
    quality,
    container: 'hls',
    transcode: 'copy',
    clientIp,
    userAgent,
    state: 'resolving',
    startedAt: now,
    bytesTransferred: 0,
    bytesPerSecond: 0,
    lastActivityAt: now,
    viewers: new Map([[clientIp || 'unknown', { userAgent: userAgent || null, lastSeen: now }]]),
    // The player fetches segments directly from YouTube, so there is no
    // process or transfer here to stop: Stop just removes this row.
    stop: () => {
      const stopped = getStream(streamId);
      logger.info({ streamId, youtubeId, segmentsServed: (stopped && stopped.segmentsServed) || 0 }, 'ytstream: youtube-hls row stopped from Live Streams');
      trackedSessions.delete(streamId);
      untrackStream(streamId, 'manual-stop', null);
    },
  });
  trackedSessions.set(streamId, { lastRequestAt: now, holdMs: SESSION_HOLD_FLOOR_MS });
  ensureSweeper();
  logger.info({ streamId, youtubeId, quality, clientIp, userAgent }, 'ytstream: youtube-hls request started - showing on Live Streams');
  return { streamId, created: true };
}

/**
 * Feeds a proxied playlist/segment request into the Live Streams row: bytes
 * (real for playlists, an estimate for redirected segments), the playback
 * position and a segment count. Creates the row again if it had expired.
 * @param {object} event - see youtubeHlsProxy's createProxyHandlers
 */
function recordProxyActivity(event) {
  const { streamId } = touchLiveRow({ youtubeId: event.youtubeId, quality: event.quality, clientIp: event.clientIp, userAgent: event.userAgent });
  const entry = getStream(streamId);
  const session = trackedSessions.get(streamId);
  if (entry) {
    entry.state = 'active';
    entry.lastActivityAt = Date.now();
    if (event.type === 'playlist') {
      entry.bytesTransferred += event.bytes || 0;
    } else if (event.type === 'segment') {
      entry.bytesTransferred += event.estimatedBytes || 0;
      entry.bytesEstimated = true;
      entry.segmentsServed = (entry.segmentsServed || 0) + 1;
      entry.playbackSeconds = event.positionSeconds;
      // The segment grid on the Streaming page follows the video stream only.
      if (event.kind !== 'audio' && event.segmentCount > 0 && Number.isInteger(event.index)) {
        if (!entry.segmentGrid || entry.segmentGrid.total !== event.segmentCount) {
          entry.segmentGrid = { total: event.segmentCount, durationSeconds: event.averageSegmentSeconds, requested: new Array(event.segmentCount).fill(false), current: null };
        }
        if (event.index < entry.segmentGrid.total) entry.segmentGrid.requested[event.index] = true;
        entry.segmentGrid.current = event.index;
      }
    }
  }
  if (session) {
    if (event.mode === 'serve') session.holdMs = SERVE_IDLE_HOLD_MS;
    if (event.type === 'segment' && !session.playbackLogged) {
      session.playbackLogged = true;
      logger.info(
        { streamId, youtubeId: event.youtubeId, kind: event.kind, index: event.index, positionSeconds: event.positionSeconds, totalSeconds: event.totalSeconds, clientIp: event.clientIp },
        'ytstream: youtube-hls playback started - the player requested its first segment through Youtarr'
      );
    }
  }
}

/** Marks the row active and sizes its hold time to the video's length. */
function markPlaylistServed(streamId, playlist, proxyMode = 'off') {
  const entry = getStream(streamId);
  if (entry) {
    entry.state = 'active';
    entry.bytesTransferred += Buffer.byteLength(playlist);
    entry.lastActivityAt = Date.now();
  }
  const session = trackedSessions.get(streamId);
  if (session) {
    const durationSeconds = playlistDurationSeconds(playlist);
    session.lastRequestAt = Date.now();
    session.holdMs = proxyMode === 'serve'
      ? SERVE_IDLE_HOLD_MS
      : (durationSeconds === null
        ? SESSION_HOLD_FLOOR_MS
        : Math.max(SESSION_HOLD_FLOOR_MS, durationSeconds * 1000 + SESSION_HOLD_PADDING_MS));
    streamDebug({ streamId, durationSeconds, holdMs: session.holdMs }, 'ytstream: youtube-hls sized the Live Streams row hold time to the video length');
  }
}

/** Handles the top-level `mode=youtube-hls` request. */
async function handleYoutubeHlsRequest(req, res, { youtubeId, quality, qualityStrictness, playerClient, audioLanguage, hlsProxy, clientIp, userAgent }, deps) {
  const proxyMode = proxy.normalizeProxyMode(hlsProxy);
  const startedAt = Date.now();
  streamDebug(
    { youtubeId, quality, qualityStrictness, playerClient: playerClient || null, routing: proxyMode, clientIp, userAgent, range: req.headers && req.headers.range, url: req.originalUrl },
    'ytstream: youtube-hls request received'
  );
  const { streamId, created } = touchLiveRow({ youtubeId, quality, clientIp, userAgent });
  try {
    const { playlist, cached } = await getPlaylist({ youtubeId, quality, qualityStrictness, playerClient, preferredLanguage: audioLanguage || null, proxyMode }, deps);
    markPlaylistServed(streamId, playlist, proxyMode);
    logger.info(
      {
        streamId, youtubeId, quality, cached, routing: proxyMode, resolveMs: Date.now() - startedAt, bytes: playlist.length,
        durationSeconds: playlistDurationSeconds(playlist), clientIp, userAgent,
      },
      'ytstream: youtube-hls served YouTube\'s own HLS playlist'
    );
    res.set({ 'Content-Type': PLAYLIST_CONTENT_TYPE, 'Cache-Control': 'no-store' });
    res.status(200).send(playlist);
    streamDebug({ streamId, youtubeId, totalMs: Date.now() - startedAt, bytes: playlist.length }, 'ytstream: youtube-hls response sent (200)');
  } catch (err) {
    logger.error({ err: err.message, streamId, youtubeId, quality }, 'ytstream: youtube-hls could not resolve an HLS playlist');
    // Only a row this request created is failed; one another viewer already
    // has active is left alone.
    if (created) {
      trackedSessions.delete(streamId);
      failStreamThenUntrack(streamId, 'failed', err.message);
    }
    res.status(502).send(`youtube-hls could not get an HLS playlist for this video: ${err.message}`);
    streamDebug({ streamId, youtubeId, totalMs: Date.now() - startedAt, rowFailed: created }, 'ytstream: youtube-hls response sent (502)');
  }
}

/**
 * Dry run for the simulate endpoint: what a request for these params would do,
 * without serving anything or creating a Live Streams row. `probe` also runs
 * the real yt-dlp lookup and manifest fetch to report the variant and audio
 * track that would be chosen (the same network cost a real first play pays).
 * @returns {Promise<object>}
 */
async function describeRun({ youtubeId, quality, qualityStrictness, playerClient, audioLanguage, hlsProxy }, { probe = false } = {}, deps = {}) {
  const preferredLanguage = audioLanguage || null;
  const proxyMode = proxy.normalizeProxyMode(hlsProxy);
  const key = `${youtubeId}|${resolveQualityHeight(quality)}|${qualityStrictness}|${preferredLanguage || ''}|${proxyMode}`;
  const routingText = {
    off: 'the YouTube HLS master playlist, served as-is; the player fetches the media playlists and segments from YouTube',
    proxy: 'the master playlist and both media playlists come from Youtarr; the player fetches segments from YouTube',
    serve: 'the master and media playlists come from Youtarr, and every segment URL points at Youtarr, which redirects (302) to YouTube',
  }[proxyMode];
  const result = {
    cacheKey: key,
    playlistCached: cacheGet(key) !== null,
    settings: { quality, qualityStrictness, playerClient: playerClient || null, audioLanguage: preferredLanguage, hlsProxy: proxyMode },
    wouldCall: `getPlaylist(${key}) - ${routingText}`,
    ignoredSettings: ['container', 'transcode', 'hardwareMode', 'tuning', 'calculatedLength'],
  };
  if (!probe) return result;
  try {
    let choice = null;
    // No proxyKey: a dry run resolves as it would but registers nothing.
    await resolvePlaylist({ youtubeId, quality, qualityStrictness, playerClient, preferredLanguage, proxyMode }, { ...deps, onChoice: (picked) => { choice = picked; } });
    result.choice = choice;
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

/** Test hook: drops every cached playlist and tracked row bookkeeping. */
function clearPlaylistCache() {
  playlistCache.clear();
  inFlight.clear();
  trackedSessions.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  handleYoutubeHlsRequest,
  resolvePlaylist,
  getPlaylist,
  playlistDurationSeconds,
  buildStreamId,
  pickManifestUrl,
  parseMasterPlaylist,
  parseAttributes,
  chooseVariant,
  buildFilteredMaster,
  chooseRendition,
  recordProxyActivity,
  describeRun,
  absolutizeMediaPlaylist,
  clearPlaylistCache,
};
