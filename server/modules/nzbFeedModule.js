const logger = require('../logger');

/**
 * Newznab search-result XML + synthetic NZB file building/parsing for the
 * Sonarr/Radarr/Prowlarr integration (see server/routes/nzb.js). Hand-rolled
 * string templating, matching the existing escapeXml precedent in
 * nfoGenerator.js, rather than pulling in an XML library dependency.
 */

function escapeXml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RFC 822 date string, the format Newznab/RSS pubDate expects. */
function toPubDate(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

/**
 * Maps a `preferredResolution`-style quality string to a standard height
 * tier, for the `[XXXp]` label appended to search-result titles. Independent
 * copy of the same mapping used in server/routes/ytstream.js's
 * resolveQualityHeight/server/modules/strmMediaInfoCache.js - not imported
 * from either since a route module isn't a shared library and this one
 * additionally needs to round to the label tiers below rather than just cap.
 * @param {string} quality
 * @returns {number} one of 360/480/720/1080/1440/2160
 */
function resolveQualityTier(quality) {
  const q = String(quality || '1080').toLowerCase().trim();
  if (q === 'best' || q === 'max' || q === 'maximum') return 2160;
  const requested = Number.parseInt(q, 10);
  const tiers = [360, 480, 720, 1080, 1440, 2160];
  if (!Number.isFinite(requested) || requested <= 0) return 1080;
  // Snap down to the nearest tier at or below what's requested, so e.g. a
  // "1080" preference doesn't get rounded up to "1440".
  let tier = tiers[0];
  for (const t of tiers) {
    if (requested >= t) tier = t;
  }
  return tier;
}

/**
 * Rough KB/s per resolution tier, video only - same table as
 * server/routes/ytstream.js's RESOLUTION_BITRATE_KBPS (used there for
 * calculatedLength's Content-Length estimate). Independent copy for the same
 * reason as resolveQualityTier above.
 */
const RESOLUTION_BITRATE_KBPS = {
  2160: 20000,
  1440: 10000,
  1080: 5000,
  720: 2800,
  480: 1500,
  360: 800,
};
const AUDIO_BITRATE_KBPS = 192;

/**
 * @param {number} height - from resolveQualityTier
 * @param {number} durationSeconds
 * @returns {number} estimated bytes, biased slightly high (see
 *   ytstream.js's CALCULATED_LENGTH_PADDING_FACTOR for the same reasoning: a
 *   guess that's too low is more misleading than one that's too high).
 */
function estimateFileSizeBytes(height, durationSeconds) {
  const videoKbps = RESOLUTION_BITRATE_KBPS[height] || RESOLUTION_BITRATE_KBPS[1080];
  const totalKbps = videoKbps + AUDIO_BITRATE_KBPS;
  return Math.ceil((totalKbps * 1000 * durationSeconds) / 8);
}

const NEWZNAB_BASE_CATEGORIES = [
  { id: '0', name: 'Other', subcats: [] },
  {
    id: '2000',
    name: 'Movies',
    subcats: [
      { id: '2010', name: 'Foreign' },
      { id: '2020', name: 'Other' },
      { id: '2030', name: 'SD' },
      { id: '2040', name: 'HD' },
      { id: '2050', name: 'BluRay' },
      { id: '2060', name: '3D' },
    ],
  },
  { id: '5000', name: 'TV', subcats: [{ id: '5040', name: 'HD' }] },
];

/**
 * Builds the `t=caps` XML response. Adds one extra `<subcat>` per configured
 * category whose id isn't already part of the base tree, so a category using
 * a non-standard id still shows up somewhere sane.
 * @param {Array<{name:string, newznabCategoryIds:string[]}>} categories
 * @returns {string}
 */
function buildCapsXml(categories = []) {
  const knownIds = new Set();
  NEWZNAB_BASE_CATEGORIES.forEach((c) => {
    knownIds.add(c.id);
    c.subcats.forEach((s) => knownIds.add(s.id));
  });

  const extraByParent = new Map();
  for (const cat of categories) {
    for (const rawId of cat.newznabCategoryIds || []) {
      const id = String(rawId || '');
      if (!id || knownIds.has(id)) continue;
      const parentId = id.length === 4 ? `${id[0]}000` : id;
      if (!extraByParent.has(parentId)) extraByParent.set(parentId, []);
      extraByParent.get(parentId).push({ id, name: cat.name });
      knownIds.add(id);
    }
  }

  const categoryXml = NEWZNAB_BASE_CATEGORIES.map((c) => {
    logger.info({ category: c, extraSubcats: extraByParent.get(c.id) || [] }, 'buildCapsXml: category with extra subcats');
    const subcats = [...c.subcats, ...(extraByParent.get(c.id) || [])]
      .map((s) => `<subcat id="${escapeXml(s.id)}" name="${escapeXml(s.name)}"/>`)
      .join('');
    return `<category id="${escapeXml(c.id)}" name="${escapeXml(c.name)}">${subcats}</category>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
<server title="Youtarr" strapline="YouTube via Newznab" version="1.0"/>
<limits max="100" default="25"/>
<searching>
<search available="yes" supportedParams="q"/>
<tv-search available="yes" supportedParams="q,season,ep"/>
<movie-search available="yes" supportedParams="q"/>
<audio-search available="no"/>
<book-search available="no"/>
</searching>
<categories>${categoryXml}</categories>
</caps>`;
}

/**
 * Builds the `t=search|tvsearch|movie` RSS/XML response.
 * @param {Array<object>} results - videoSearchModule.searchVideos() output
 * @param {object} opts
 * @param {string} opts.categoryName - resolved category's config `name`
 * @param {string[]} opts.newznabCategoryIds - all IDs this category is
 *   declared under (see findCategory in server/routes/nzb.js); the first is
 *   used as the item's primary `<category>`, and each gets its own
 *   `newznab:attr name="category"` line, so a client matching on any of them
 *   still recognizes this result.
 * @param {string} opts.baseUrl - e.g. `${protocol}://${host}`
 * @param {string} opts.apikey - re-embedded into each item's download link
 * @param {string} [opts.quality] - preferredResolution-style string (e.g.
 *   "1080", "best") - the configured download quality, since every grab
 *   downloads at the same globally-configured quality regardless of the
 *   source video's own resolution (which flat-playlist search can't see -
 *   see nzb.js's search handler for why this isn't a real per-video probe).
 *   Drives both the `[XXXp]` title label and the file-size estimate.
 * @param {number} [opts.season] - Sonarr/Radarr's real season number, when
 *   this was a tvsearch with a known season+episode - carried through to the
 *   download link so the eventual grab can use it instead of Youtarr's own
 *   upload-year-as-season scheme. Only set when opts.ep is also set.
 * @param {number} [opts.ep] - real episode number, paired with opts.season.
 */
function buildSearchXml(results, { categoryName, newznabCategoryIds, baseUrl, apikey, quality, season, ep }) {
  const heightTier = resolveQualityTier(quality);
  const qualityLabel = `[${heightTier}p]`;
  const seasonEpisodeParams = (season != null && ep != null)
    ? `&season=${encodeURIComponent(season)}&ep=${encodeURIComponent(ep)}`
    : '';
  const categoryIds = (newznabCategoryIds && newznabCategoryIds.length) ? newznabCategoryIds : [''];
  const categoryAttrs = categoryIds
    .map((id) => `<newznab:attr name="category" value="${escapeXml(id)}"/>`)
    .join('\n');

  const items = results.map((r) => {
    const guid = `https://www.youtube.com/watch?v=${r.youtubeId}`;
    const baseTitle = r.title || r.youtubeId;
    const title = `${baseTitle} ${qualityLabel}`;
    const downloadUrl =
      `${baseUrl}/nzb/download/${encodeURIComponent(categoryName)}/${encodeURIComponent(r.youtubeId)}.nzb` +
      `?title=${encodeURIComponent(baseTitle)}&apikey=${encodeURIComponent(apikey)}${seasonEpisodeParams}`;
    // Real size isn't knowable until downloaded - estimated from the video's
    // actual duration (reliably available from search results) at the
    // configured quality's typical bitrate, rather than one flat number for
    // every result. Falls back to the flat placeholder only when duration
    // itself is unavailable.
    const size = typeof r.duration === 'number' && r.duration > 0
      ? estimateFileSizeBytes(heightTier, r.duration)
      : 2147483648;

    return `<item>
<title>${escapeXml(title)}</title>
<description>${escapeXml(title)}</description>
<guid isPermaLink="false">${escapeXml(guid)}</guid>
<comments>${escapeXml(guid)}</comments>
<pubDate>${toPubDate(r.publishedAt)}</pubDate>
<size>${size}</size>
<link>${escapeXml(downloadUrl)}</link>
<enclosure url="${escapeXml(downloadUrl)}" length="${size}" type="application/x-nzb"/>
<category>${escapeXml(categoryIds[0])}</category>
<newznab:attr name="size" value="${size}"/>
${categoryAttrs}
<newznab:attr name="language" value="English"/>
<newznab:attr name="files" value="1"/>
<newznab:attr name="grabs" value="0"/>
</item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/">
<channel>
<title>Youtarr</title>
<description>YouTube via Newznab</description>
${items}
</channel>
</rss>`;
}

/**
 * Builds the synthetic per-video NZB file served at
 * GET /nzb/download/:categoryName/:youtubeId.nzb - a real, valid NZB XML
 * document (Sonarr/Radarr just need it to parse as one) whose only real
 * purpose is carrying { youtubeId, categoryName } through Sonarr/Radarr's
 * normal NZB-handling pipeline back to addfile, with no server-side
 * session/cache needed in between. Encoded redundantly (meta tags, title
 * suffix, and a fake segment id) so parseNzbXml can recover it even if a
 * client strips optional-looking tags.
 */
function buildNzbXml({ youtubeId, categoryName, title, season, ep }) {
  const displayTitle = `${title || youtubeId} [${youtubeId}]`;
  const segmentId = `${youtubeId}@${categoryName}.youtarr.local`;
  const seasonEpisodeMeta = (season != null && ep != null)
    ? `\n<meta type="season">${escapeXml(season)}</meta>\n<meta type="episode">${escapeXml(ep)}</meta>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
<head>
<meta type="title">${escapeXml(displayTitle)}</meta>
<meta type="nzbName">${escapeXml(displayTitle)}</meta>
<meta type="type">youtarr/${escapeXml(categoryName)}</meta>
<meta type="youtubeId">${escapeXml(youtubeId)}</meta>
<meta type="category">${escapeXml(categoryName)}</meta>${seasonEpisodeMeta}
</head>
<file poster="youtarr@youtarr.local" date="${Math.floor(Date.now() / 1000)}" subject="${escapeXml(displayTitle)}">
<groups><group>alt.binaries.youtarr</group></groups>
<segments>
<segment bytes="1" number="1">${escapeXml(segmentId)}</segment>
</segments>
</file>
</nzb>`;
}

/**
 * Recovers { youtubeId, categoryName } from an uploaded NZB file's raw
 * bytes (server/routes/nzb.js's addfile handler). Tries, in order: <meta>
 * tags, the title's bracketed id suffix, then the fake segment message-id -
 * see buildNzbXml for what each of these looks like when Youtarr itself
 * wrote the file. Regex-based rather than a full XML parser, consistent
 * with escapeXml above (no new XML dependency).
 * @param {Buffer|string} xmlBuffer
 * @returns {{youtubeId: string|null, categoryName: string|null, nzbName: string|null, season: number|null, ep: number|null}}
 */
function parseNzbXml(xmlBuffer) {
  const xml = Buffer.isBuffer(xmlBuffer) ? xmlBuffer.toString('utf8') : String(xmlBuffer || '');

  const metaValue = (type) => {
    const re = new RegExp(`<meta[^>]*type=["']${type}["'][^>]*>([^<]*)</meta>`, 'i');
    const m = xml.match(re);
    return m ? m[1].trim() : null;
  };

  let youtubeId = metaValue('youtubeId');
  let categoryName = metaValue('category');
  const nzbName = metaValue('nzbName') || metaValue('title');
  const seasonRaw = metaValue('season');
  const epRaw = metaValue('episode');
  const season = seasonRaw !== null ? Number.parseInt(seasonRaw, 10) : null;
  const ep = epRaw !== null ? Number.parseInt(epRaw, 10) : null;

  if (!youtubeId) {
    const titleMatch = xml.match(/<meta[^>]*type=["']title["'][^>]*>([^<]*)<\/meta>/i) ||
      xml.match(/<title>([^<]*)<\/title>/i);
    if (titleMatch) {
      const bracket = titleMatch[1].match(/\[([A-Za-z0-9_-]{6,20})\]\s*$/);
      if (bracket) youtubeId = bracket[1];
    }
  }

  if (!youtubeId || !categoryName) {
    const segmentMatch = xml.match(/<segment[^>]*>([A-Za-z0-9_-]{6,20})@([^.]+)\.youtarr\.local<\/segment>/i);
    if (segmentMatch) {
      youtubeId = youtubeId || segmentMatch[1];
      categoryName = categoryName || segmentMatch[2];
    }
  }

  if (!youtubeId) {
    logger.warn({ xmlSnippet: xml.slice(0, 500) }, 'nzbFeedModule: could not recover youtubeId from uploaded NZB');
  }

  return {
    youtubeId: youtubeId || null,
    categoryName: categoryName || null,
    nzbName: nzbName || null,
    season: Number.isFinite(season) ? season : null,
    ep: Number.isFinite(ep) ? ep : null,
  };
}

module.exports = {
  escapeXml,
  buildCapsXml,
  buildSearchXml,
  buildNzbXml,
  parseNzbXml,
};
