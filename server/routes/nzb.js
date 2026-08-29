const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const logger = require('../logger');
const configModule = require('../modules/configModule');
const videoSearchModule = require('../modules/videoSearchModule');
const jobModule = require('../modules/jobModule');
const nzbFeedModule = require('../modules/nzbFeedModule');
const { nzbDownloadJobLabel } = require('../modules/download/jobTypes');
const ChannelVideo = require('../models/channelvideo');
const Video = require('../models/video');
const { formatBytes } = require('../modules/notifications/utils');

/**
 * Makes Youtarr act as BOTH a Newznab-compatible search indexer AND a
 * SABnzbd-compatible download client, so Sonarr/Radarr/Prowlarr can search
 * YouTube through Youtarr and "download" (really: trigger a real Youtarr
 * download/STRM materialize of) a video, landing in a category-mapped
 * folder. Modeled on github.com/Nikorag/iplayarr, which does the same for
 * BBC iPlayer content. See docs/NZB.md.
 *
 * Deliberately mounted at /nzb, not /api - the existing /api/* prefix
 * carries apiLimiter + verifyToken (server.js), neither of which apply
 * here: this feature has its own single dedicated API key (verifyNzbApiKey
 * below), checked via the Newznab/SABnzbd `?apikey=` query-string
 * convention rather than Youtarr's session/header-based auth.
 *
 * No server-side cache/session exists between search and grab - everything
 * addfile needs is encoded directly in the synthetic NZB file itself (see
 * nzbFeedModule.buildNzbXml/parseNzbXml).
 */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ALLOWED_SEARCH_COUNTS = [10, 25, 50, 100];

function nearestAllowedCount(requested) {
  const n = Number.parseInt(requested, 10);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return ALLOWED_SEARCH_COUNTS.reduce((best, c) => (Math.abs(c - n) < Math.abs(best - n) ? c : best), ALLOWED_SEARCH_COUNTS[0]);
}

// SABnzbd's timeleft is "H:MM:SS" (no zero-padded hours).
function formatTimeleft(etaSeconds) {
  const total = Math.max(0, Math.round(etaSeconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Sonarr/Radarr run in their own container and may have the shared media
 * volume mounted at a different path than Youtarr sees it at internally
 * (e.g. Youtarr's directoryPath is /usr/src/app/data, but Sonarr's own
 * mount of that same folder is rooted elsewhere - or at /, with no prefix
 * at all). Rather than requiring Sonarr-side Remote Path Mapping, when
 * nzb.remoteBasePath is configured, every path reported to Sonarr/Radarr
 * (history's storage/path) has Youtarr's real directoryPath prefix swapped
 * for it. Left at its default (null/undefined), paths are reported
 * unchanged - the historical behavior for setups where both containers see
 * the same path.
 */
function remapPathForSonarr(absolutePath) {
  if (!absolutePath) return absolutePath;
  const cfg = configModule.getConfig();
  const remoteBase = cfg.nzb?.remoteBasePath;
  if (remoteBase === null || remoteBase === undefined) return absolutePath;
  const localBase = String(configModule.directoryPath || '').replace(/[/\\]+$/, '');
  if (!localBase || !absolutePath.startsWith(localBase)) return absolutePath;
  const suffix = absolutePath.slice(localBase.length); // keeps its leading slash, e.g. "/__sonarr/pcrobec/..."
  return `${String(remoteBase).replace(/[/\\]+$/, '')}${suffix}`;
}

function verifyNzbApiKey(req, res, next) {
  const cfg = configModule.getConfig();
  if (!cfg.nzb?.enabled || !cfg.nzb?.apiKey) {
    return res.status(503).send('Youtarr NZB integration is not enabled');
  }
  const provided = req.query.apikey;
  if (!provided || typeof provided !== 'string') {
    return res.status(401).send('Missing apikey');
  }
  // Stored in plaintext (see configSchema.ts's nzb.apiKey comment) - still a
  // constant-time compare against a length-normalized buffer pair so this
  // doesn't leak timing information about how much of the key matched.
  const storedBuf = Buffer.from(cfg.nzb.apiKey, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (storedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(storedBuf, providedBuf)) {
    return res.status(401).send('Invalid apikey');
  }
  next();
}

/**
 * Sonarr/Radarr's import step MOVES (or copies+deletes) whatever `storage`/
 * `path` a history entry reports into their own managed library folder. If
 * that pointed at Youtarr's own real library file, the file would vanish
 * from where Youtarr (and Jellyfin/Plex) expect it, and Youtarr's Video row
 * would go dangling. Instead, hardlink the real file into a dot-prefixed
 * staging folder (excluded from subfolder/library scanning, same convention
 * as .youtarr_tmp) and report that path - Sonarr/Radarr's move only removes
 * the hardlink; Youtarr's own copy is untouched since both links share the
 * same underlying data on disk. This is also self-cleaning: once Sonarr/
 * Radarr imports it, the staged hardlink is gone (moved away by them).
 * Idempotent per job via job.data.nzb.stagedPath, since Sonarr/Radarr poll
 * history repeatedly before importing.
 */
function stageForSonarrImport(job, categoryName, videoRow) {
  if (job.data.nzb.stagedPath && fs.existsSync(job.data.nzb.stagedPath)) {
    return job.data.nzb.stagedPath;
  }
  const filePath = videoRow?.filePath;
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const stagingDir = path.join(configModule.directoryPath, '.nzb_staging', categoryName);
  const stagedPath = path.join(stagingDir, path.basename(filePath));
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    if (!fs.existsSync(stagedPath)) {
      try {
        fs.linkSync(filePath, stagedPath);
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Another concurrent history poll already created it - fine.
        } else if (err.code === 'EXDEV') {
          logger.warn({ filePath, stagedPath }, 'nzb: staging folder is on a different filesystem than the library - falling back to a real copy (doubles disk usage until Sonarr/Radarr imports it)');
          fs.copyFileSync(filePath, stagedPath);
        } else {
          throw err;
        }
      }
    }
    job.data.nzb.stagedPath = stagedPath;
    return stagedPath;
  } catch (err) {
    logger.warn({ err, filePath }, "nzb: failed to stage file for Sonarr/Radarr import - reporting the real library path instead, so Sonarr/Radarr's import will move it out of Youtarr's library");
    return filePath;
  }
}

/**
 * For importStrategy 'untracked': Sonarr/Radarr are told the job is
 * complete with the real (only) file path and will move it away as usual.
 * Until then the video is a completely normal, visible entry in Youtarr's
 * own library (same as 'hardlink') - this function is what removes it, and
 * it is ONLY ever called in response to an explicit removal signal: a real
 * mode=history&name=delete call from Sonarr/Radarr (see the handler below),
 * or the user deleting/purging the video themselves in Youtarr's own UI
 * (the normal delete/purge flow, unrelated to this file). It must NEVER run
 * automatically just because a job completed or Sonarr/Radarr merely
 * polled history - doing so previously caused a real bug: if the DB row got
 * purged before Sonarr's own history poll ever read it (e.g. a Youtarr
 * restart in between), resolveNzbVideoRow had nothing left to fall back to
 * and Sonarr/Radarr received an empty path it could never import - the grab
 * would vanish from the queue without ever usably appearing in history.
 *
 * Only the Video row + its JobVideo/VideoWatchStatus rows are removed (same
 * scope as videoDeletionModule.purgeVideoById); ChannelVideo is deliberately
 * left alone - it keys by youtube_id and represents the YouTube-catalog
 * listing independent of this local download. The file itself is NEVER
 * touched here - Sonarr/Radarr's own import step is what moves it. Idempotent
 * via job.data.nzb.untracked.
 *
 * Also removes the video from yt-dlp's download-archive. That archive's
 * whole purpose is "don't re-download a file Youtarr still has" - once
 * untracked, Youtarr no longer has it (Sonarr/Radarr own it now), so a
 * later re-grab of the same video (a Sonarr retry, a second matching
 * release, etc.) must be allowed to actually re-download instead of
 * silently skipping ("already recorded in the archive") and then failing
 * because the original copy is gone from where it used to be.
 */
async function untrackFromYoutarrLibrary(job, videoRow) {
  if (job.data.nzb.untracked) return;
  const videoId = videoRow?.id;
  if (!videoId) return;
  try {
    const { JobVideo, VideoWatchStatus } = require('../models');
    await JobVideo.destroy({ where: { video_id: videoId } });
    await VideoWatchStatus.destroy({ where: { video_id: videoId } });
    await Video.destroy({ where: { id: videoId } });
    job.data.nzb.untracked = true;
  } catch (err) {
    logger.warn({ err, videoId }, 'nzb: failed to remove untracked video from Youtarr DB');
  }
  if (videoRow?.youtubeId) {
    try {
      const archiveModule = require('../modules/archiveModule');
      await archiveModule.removeVideoFromArchive(videoRow.youtubeId);
    } catch (err) {
      logger.warn({ err, youtubeId: videoRow.youtubeId }, 'nzb: failed to remove untracked video from yt-dlp archive');
    }
  }
}

/**
 * The video this job's history entry should report on. Usually just
 * job.data.videos[0] (populated fresh from the DB when the job completed -
 * see jobModule.js's completed-job video reload). But when yt-dlp finds the
 * video already in its download archive (already downloaded by an earlier
 * job, e.g. a prior manual grab or a retried NZB request), it skips the
 * download entirely - no --exec post-processor run, no JobVideo row created
 * for *this* job, so job.data.videos comes back empty even though the video
 * genuinely already exists in the library. Falls back to a fresh DB lookup
 * by youtubeId so Sonarr/Radarr still gets told the grab is complete (with
 * the video's real, already-downloaded path) instead of an empty history
 * entry they can never import.
 */
async function resolveNzbVideoRow(job) {
  const fromJob = job.data?.videos?.[0];
  if (fromJob?.filePath) return fromJob;
  const youtubeId = job.data?.nzb?.youtubeId;
  if (!youtubeId) return null;
  try {
    const video = await Video.findOne({ where: { youtubeId } });
    return video ? video.dataValues : null;
  } catch (err) {
    logger.warn({ err, youtubeId }, 'nzb: failed to look up already-downloaded video for history');
    return null;
  }
}

function findCategory(categories, { name, newznabCategoryId }) {
  if (name) {
    const byName = categories.find((c) => c.name === name);
    if (byName) return byName;
  }
  if (newznabCategoryId) {
    // Sonarr/Radarr routinely send `cat` as a comma-separated list (e.g. a
    // specific subcategory plus its parent, "5040,5000") rather than a
    // single id, and a category can itself be declared under several ids
    // (see newznabCategoryIds - one Youtarr category matching multiple
    // Newznab quality tiers). Match on any overlap between the two sets
    // instead of a single-value equality check - without this, a request
    // naming an id combination the category doesn't happen to have handy
    // silently falls through to "first configured category" below, which
    // for a multi-category setup means the *wrong* category's settings
    // (searchMode, importStrategy, etc.) get used regardless of what was
    // actually requested.
    const requestedIds = String(newznabCategoryId).split(',').map((id) => id.trim());
    const byId = categories.find((c) =>
      (c.newznabCategoryIds || []).some((id) => requestedIds.includes(String(id)))
    );
    if (byId) return byId;
  }
  return categories.find((c) => c.name) || null;
}

/**
 * Handles a real SABnzbd/NZBGet-style "remove this history entry" call
 * (mode=history&name=delete&value=<nzo_id>[,<nzo_id2>,...]). Real clients
 * drop the slot from history the moment this is called - so regardless of
 * import strategy, the job is flagged via job.data.nzb.historyRemoved and
 * the mode=history handler below excludes anything so flagged. Without
 * this, Sonarr/Radarr's own history poll kept re-discovering the same
 * "already deleted" entry forever (up to jobModule's 14-day retention),
 * which for 'untracked' strategy meant reporting it with a null path/0
 * bytes once the video row was gone - a ghost entry that never actually
 * left.
 *
 * Untracking the video from Youtarr's own DB (see
 * untrackFromYoutarrLibrary's doc comment for why) only happens for
 * 'untracked'-strategy videos - 'hardlink'-strategy videos are deliberately
 * left alone even though their history slot is now hidden: they're
 * permanent Youtarr library entries by design, not something a
 * download-client history cleanup should ever delete.
 * @param {string[]} jobIds - nzo_ids (Youtarr job ids) from the delete call's `value`
 */
async function handleHistoryDeleteRequest(jobIds) {
  const cfg = configModule.getConfig();
  const categories = cfg.nzb?.categories || [];
  for (const jobId of jobIds) {
    try {
      const job = jobModule.getJob(jobId);
      if (!job?.data?.nzb) continue;
      job.data.nzb.historyRemoved = true;
      const category = findCategory(categories, { name: job.data.nzb.categoryName });
      if ((category?.importStrategy || 'hardlink') === 'untracked') {
        const videoRow = await resolveNzbVideoRow(job);
        await untrackFromYoutarrLibrary(job, videoRow);
        logger.info({ jobId }, 'nzb: removed untracked video in response to history delete request');
      } else {
        logger.info({ jobId }, 'nzb: hid history entry in response to delete request (hardlink strategy - library video untouched)');
      }
    } catch (err) {
      logger.warn({ err, jobId }, 'nzb: failed to process history delete request');
    }
  }
}

/**
 * Optional per-category strictness filter ("additional local filter" in the
 * UI). YouTube search - even via the yt-dlp fallback - regularly returns
 * loosely-related results (reactions, compilations, unrelated uploads that
 * only share a keyword), which Sonarr/Radarr then grab as if they were the
 * real episode/movie. When a category enables this, results are dropped
 * unless the video's own title actually contains the search terms and,
 * for a tvsearch where Sonarr supplied season and/or episode, a
 * recognizable SxxExx-style code. Episode isn't always supplied (Sonarr
 * does season-pack searches with only a season), so the code check only
 * requires whichever of season/episode is actually known - never invents a
 * requirement for the missing half.
 */
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const LOCAL_FILTER_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'and', 'or']);

function queryTerms(query) {
  return normalizeForMatch(query)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !LOCAL_FILTER_STOPWORDS.has(t));
}

function titleMatchesEpisodeCode(title, season, ep) {
  if (season == null && ep == null) return true;
  const patterns = [];
  if (season != null && ep != null) {
    patterns.push(new RegExp(`\\bs0*${season}\\s*[.\\-]?\\s*e0*${ep}\\b`, 'i'));
    patterns.push(new RegExp(`\\b0*${season}\\s*x\\s*0*${ep}\\b`, 'i'));
    // Spelled-out form ("Season 22 Episode 5", "Series 22, Ep 5") - British
    // shows commonly say "Series" instead of "Season", and YouTube titles
    // spell episode codes out far more often than they use "S22E05".
    // \D{0,20} between the two numbers never crosses another digit, so this
    // can't accidentally span an unrelated number elsewhere in the title
    // (e.g. an air date).
    patterns.push(new RegExp(`\\bs(?:eason|eries)?\\.?\\s*0*${season}\\D{0,20}?e(?:p(?:isode)?)?\\.?\\s*0*${ep}\\b`, 'i'));
  } else if (season != null) {
    // No trailing \b here: a real title like "Celebrity Juice S22E01" has no
    // word boundary between the season digits and the following "E" (both
    // are word characters), so a \b would silently fail to match every
    // properly-coded title. A negative lookahead against another digit
    // still keeps "S22" from matching inside "S220".
    patterns.push(new RegExp(`\\bs(?:eason|eries)?\\.?\\s*0*${season}(?!\\d)`, 'i'));
  } else {
    patterns.push(new RegExp(`\\be(?:p(?:isode)?)?\\.?\\s*0*${ep}\\b`, 'i'));
    // "#5"-style numbering - common on YouTube for numbered series that
    // never actually use the word "Episode".
    patterns.push(new RegExp(`#\\s*0*${ep}\\b`));
  }
  return patterns.some((re) => re.test(title));
}

function applyLocalTitleFilter(results, query, { season = null, ep = null } = {}) {
  const terms = queryTerms(query);
  return results.filter((r) => {
    const normalizedTitle = normalizeForMatch(r.title);
    const termsOk = terms.every((term) => normalizedTitle.includes(term));
    return termsOk && titleMatchesEpisodeCode(r.title, season, ep);
  });
}

module.exports = function createNzbRoutes() {
  const router = express.Router();
  router.use(['/nzb/newznab', '/nzb/download', '/nzb/sab'], verifyNzbApiKey);

  // ---- Newznab ----

  router.get('/nzb/newznab', async (req, res) => {
    logger.info({ query: req.query }, 'nzb: newznab request');
    const cfg = configModule.getConfig();
    const categories = cfg.nzb?.categories || [];
    const t = String(req.query.t || '').toLowerCase();

    if (t === 'caps') {
      logger.info('nzb: caps request');
      res.type('application/xml').send(nzbFeedModule.buildCapsXml(categories));
      return;
    }

    if (t === 'search' || t === 'tvsearch' || t === 'movie') {
      logger.info({ query: req.query }, `nzb: ${t} request`);
      const category = findCategory(categories, { newznabCategoryId: req.query.cat });
      if (!category) {
        res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="200" description="No category configured"/>');
        return;
      }

      const query = String(req.query.q || '').trim();
      const count = nearestAllowedCount(req.query.limit);
      const responseOpts = {
        categoryName: category.name,
        newznabCategoryIds: category.newznabCategoryIds,
        baseUrl: `${req.protocol}://${req.get('host')}`,
        apikey: req.query.apikey,
        // The quality every grab actually downloads at - see
        // nzbFeedModule.buildSearchXml's `quality` doc for why this drives
        // the title's [XXXp] label and size estimate instead of a per-video
        // probe (search results have no real resolution data available).
        quality: cfg.preferredResolution,
      };

      // No `q` is standard Newznab "RSS mode" - Prowlarr's indexer Test uses
      // it and Sonarr/Radarr's periodic
      // RSS auto-sync (not just manual searches) depends on it returning
      // real recent items, not an empty set. There's no live "trending
      // YouTube" search to answer this with, so it's served from Youtarr's
      // own knowledge of channel videos instead - the most recently known
      // videos across all subscriptions, newest first.
      if (!query) {
        try {
          const recent = await ChannelVideo.findAll({
            where: { ignored: false, youtube_removed: false, media_type: 'video' },
            order: [['publishedAt', 'DESC']],
            limit: count,
          });
          const results = recent.map((v) => ({
            youtubeId: v.youtube_id,
            title: v.title,
            publishedAt: v.publishedAt,
          }));
          res.type('application/xml').send(nzbFeedModule.buildSearchXml(results, responseOpts));
        } catch (err) {
          logger.error({ err }, 'nzb: RSS-mode (blank query) lookup failed');
          res.status(500).type('application/xml').send('<?xml version="1.0"?><error code="900" description="Search failed"/>');
        }
        return;
      }

      try {
        let newquery = query;
        let season = null;
        let ep = null;
        if (t === 'tvsearch' && (req.query.season || req.query.ep)) {
          if (req.query.season) {
            season = Number.parseInt(req.query.season, 10);
            if (!Number.isFinite(season)) {
              res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="201" description="Invalid season number"/>');
              return;
            }
          }
          if (req.query.ep) {
            ep = Number.parseInt(req.query.ep, 10);
            if (!Number.isFinite(ep)) {
              res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="201" description="Invalid episode number"/>');
              return;
            }
          }

          if (category.searchMode === 'episode') {
            const seasonStr = season !== null ? 'S' + String(season).padStart(2, '0') : '';
            const epStr = ep !== null ? 'E' + String(ep).padStart(2, '0') : '';
            newquery = `${query} ${seasonStr}${epStr}`;
            logger.info({ query, season, ep , newquery}, 'nzb: tvsearch with episode mode - adjusted query');
          }

          // Carry Sonarr/Radarr's real season+episode through to the grab so
          // a series-mode download can use them instead of Youtarr's own
          // upload-year-as-season scheme (see seriesEpisodeResolver.js).
          // Only passed through when both are known - a season-only or
          // episode-only override would land in a mismatched folder/filename.
          if (season !== null && ep !== null) {
            responseOpts.season = season;
            responseOpts.ep = ep;
          }
        }

        let results = await videoSearchModule.searchVideos(newquery, count);

        if (category.additionalLocalFilter) {
          const beforeCount = results.length;
          // Only enforce the season/episode-code requirement in 'episode'
          // search mode - a 'flat' category has explicitly opted out of
          // season/episode-aware query building above, so it shouldn't
          // silently get season/episode-aware *filtering* anyway. Without
          // this, a flat-mode tvsearch with season/ep params (Sonarr sends
          // these on every tvsearch, regardless of how the category is
          // configured) demanded the title literally contain "Season 22"/
          // "S22" - text real YouTube titles essentially never have -
          // which quietly filtered every real result down to zero.
          const codeConstraint = (t === 'tvsearch' && category.searchMode === 'episode') ? { season, ep } : {};
          results = applyLocalTitleFilter(results, query, codeConstraint);
          logger.info(
            { categoryName: category.name, beforeCount, afterCount: results.length },
            'nzb: applied additional local filter'
          );
        }

        logger.debug({ results }, 'nzb: search complete');

        res.type('application/xml').send(nzbFeedModule.buildSearchXml(results, responseOpts));
      } catch (err) {
        logger.error({ err, query }, 'nzb: search failed');
        res.status(500).type('application/xml').send('<?xml version="1.0"?><error code="900" description="Search failed"/>');
      }
      return;
    }

    res.status(400).type('application/xml').send('<?xml version="1.0"?><error code="202" description="Unsupported search type"/>');
  });

  // ---- Synthetic per-video NZB download link ----

  router.get('/nzb/download/:categoryName/:file', (req, res) => {
    logger.info({ params: req.params, query: req.query }, 'nzb: download request');
    const { categoryName, file } = req.params;
    const youtubeId = String(file || '').replace(/\.nzb$/i, '');
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
      return res.status(400).send('Invalid video id');
    }
    const title = req.query.title ? String(req.query.title) : youtubeId;
    const season = req.query.season !== undefined ? Number.parseInt(req.query.season, 10) : null;
    const ep = req.query.ep !== undefined ? Number.parseInt(req.query.ep, 10) : null;
    const xml = nzbFeedModule.buildNzbXml({
      youtubeId,
      categoryName,
      title,
      season: Number.isFinite(season) ? season : null,
      ep: Number.isFinite(ep) ? ep : null,
    });
    res.set({
      'Content-Type': 'application/x-nzb',
      'Content-Disposition': `attachment; filename="${youtubeId}.nzb"`,
    });
    res.send(xml);
  });

  // ---- SABnzbd ----

  router.all('/nzb/sab/api', upload.any(), async (req, res) => {
    logger.info({ method: req.method, query: req.query, params: req.params, body: req.body }, 'nzb/sab/api request');
    const mode = String(req.query.mode || '').toLowerCase();
    const cfg = configModule.getConfig();
    const categories = cfg.nzb?.categories || [];

    if (mode === 'version') {
      logger.info('nzb: version request');
      res.json({ version: '1.0.0' });
      return;
    }

    if (mode === 'get_config') {
      logger.info('nzb: get_config request');
      // Field names/types match iplayarr's SabNZBDConfigCategoryResponse
      // exactly, including the mandatory '*' catch-all category Sonarr/
      // Radarr expect as the first entry.
      res.json({
        config: {
          misc: { download_dir: '', complete_dir: '' },
          categories: [
            { name: '*', order: 0, pp: '3', script: 'None', dir: '', newzbin: '', priority: 0 },
            ...categories.map((c, index) => ({
              name: c.name,
              order: index + 1,
              pp: '',
              script: 'None',
              dir: c.subfolder || '',
              newzbin: '',
              priority: 0,
            })),
          ],
          servers: [],
        },
      });
      return;
    }

    if (mode === 'addfile') {
      logger.info({ files: req.files, body: req.body }, 'nzb: addfile request');
      const downloadModule = require('../modules/downloadModule');
      const file = (req.files || [])[0];
      if (!file || !file.buffer) {
        // Real SABnzbd always answers addfile with HTTP 200 and a JSON
        // status field, even for a rejected upload - Sonarr/Radarr's
        // SabnzbdProxy treats any non-2xx as a DownloadClientException
        // (connection/health failure), which would incorrectly mark the
        // whole download client unavailable instead of just skipping this
        // one release.
        res.status(200).json({ status: false, error: 'No NZB file uploaded' });
        return;
      }

      const { youtubeId, categoryName, nzbName, season, ep } = nzbFeedModule.parseNzbXml(file.buffer);
      if (!youtubeId) {
        res.status(200).json({ status: false, error: 'Could not recover video id from NZB' });
        return;
      }

      const category = findCategory(categories, { name: categoryName });
      if (!category) {
        res.status(200).json({ status: false, error: `Unknown category: ${categoryName}` });
        return;
      }

      try {
        const jobId = await downloadModule.doSpecificDownloads({
          body: {
            urls: [`https://www.youtube.com/watch?v=${youtubeId}`],
            jobLabel: nzbDownloadJobLabel(category.name, youtubeId),
            overrideSettings: {
              subfolder: category.subfolder || null,
              mediaMode: category.mediaMode || 'download',
              // Real season/episode from Sonarr/Radarr's tvsearch, when
              // known - see downloadModule.js/strmMaterializer.js for how
              // this overrides the upload-year-as-season default.
              ...(season != null && ep != null ? { seriesSeasonOverride: season, seriesEpisodeOverride: ep } : {}),
              // Sonarr/Radarr generate their own artwork/nfo on import - skip
              // Youtarr's nfo/season.nfo/tvshow.nfo/fanart/backdrop/poster/
              // thumbnail-jpg for every NZB grab, real download or STRM.
              skipMediaSidecarFiles: true,
            },
            nzb: { categoryName: category.name, youtubeId, nzbName: nzbName || youtubeId },
          },
        });
        res.json({ status: true, nzo_ids: [String(jobId)] });
      } catch (err) {
        logger.error({ err, youtubeId, categoryName }, 'nzb: addfile failed to enqueue download');
        res.status(200).json({ status: false, error: err.message || 'Failed to enqueue download' });
      }
      return;
    }

    if (mode === 'queue') {
      logger.info('nzb: queue request');
      const jobs = jobModule.getRunningJobs().filter(
        (j) => j.data?.nzb && (j.status === 'Pending' || j.status === 'In Progress')
      );
      let snapshot = null;
      try {
        const downloadModule = require('../modules/downloadModule');
        snapshot = downloadModule.getCurrentActivitySnapshot ? downloadModule.getCurrentActivitySnapshot() : null;
      } catch { /* best-effort only */ }

      // Field names/types match iplayarr's SabNZBDQueueResponse/SabNZBQueueEntry
      // (github.com/Nikorag/iplayarr) exactly - Sonarr/Radarr's SABnzbd client
      // expects numeric mb/mbleft/percentage, not strings, and several
      // always-present skeleton fields it otherwise fails to deserialize.
      const slots = jobs.map((j, index) => {
        const isCurrent = snapshot && String(snapshot.jobId) === String(j.id);
        const progress = isCurrent ? snapshot.activity?.progress : null;
        const totalBytes = progress?.totalBytes || 0;
        const downloadedBytes = progress?.downloadedBytes || 0;
        const percent = progress?.percent ? Math.trunc(progress.percent) : 0;
        logger.info({ jobId: j.id, isCurrent, totalBytes, downloadedBytes, percent }, 'nzb: queue entry');
        return {
          status: j.status === 'In Progress' ? 'Downloading' : 'Queued',
          index,
          password: '',
          avg_age: '0d',
          script: 'None',
          direct_unpack: '',
          mb: totalBytes / (1024 * 1024),
          mbleft: Math.max(0, (totalBytes - downloadedBytes) / (1024 * 1024)),
          filename: j.data.nzb.nzbName,
          labels: [],
          priority: 'Normal',
          cat: j.data.nzb.categoryName || 'youtarr',
          timeleft: formatTimeleft(progress?.etaSeconds || 0),
          percentage: percent,
          nzo_id: String(j.id),
          unpackopts: 3,
        };
      });

      logger.info({ slots }, 'nzb: queue response');

      res.json({
        queue: {
          speedlimit: 0,
          speedlimit_abs: 0,
          paused: false,
          limit: 10,
          start: 0,
          have_warnings: 0,
          pause_int: 0,
          left_quota: 0,
          version: '4.0.0',
          cache_art: 0,
          cache_size: '0 MB',
          finishaction: null,
          paused_all: false,
          quota: 0,
          have_quota: false,
          diskspace1: '0 G',
          diskspacetotal1: '0 G',
          diskspace1_norm: '0 G',
          status: slots.some((s) => s.status === 'Downloading') ? 'Downloading' : 'Idle',
          noofslots_total: slots.length,
          noofslots: slots.length,
          finish: 0,
          speed: '0 KB/s',
          size: '0 MB',
          sizeleft: '0 MB',
          kbpersec: '0',
          slots,
        },
      });
      return;
    }

    // Real SABnzbd/NZBGet history entries persist until explicitly removed -
    // Sonarr/Radarr send this (mode=history&name=delete&value=<nzo_id>[,...])
    // when the user removes an item from Activity/History in their own UI,
    // or when "Remove completed downloads" is enabled. This is the only
    // thing that should ever purge an 'untracked'-strategy video from
    // Youtarr's own library - see handleHistoryDeleteRequest's doc comment.
    if (mode === 'history' && String(req.query.name || '').toLowerCase() === 'delete') {
      const jobIds = String(req.query.value || '').split(',').map((s) => s.trim()).filter(Boolean);
      logger.info({ jobIds }, 'nzb: history delete request');
      await handleHistoryDeleteRequest(jobIds);
      res.json({ status: true });
      return;
    }

    if (mode === 'history') {
      logger.info('nzb: history request');
      const jobs = jobModule.getRunningJobs().filter(
        (j) => j.data?.nzb && !j.data.nzb.historyRemoved &&
          ['Complete', 'Complete with Warnings', 'Error', 'Terminated'].includes(j.status)
      );

      logger.info({ jobs: jobs.map((j) => ({ jobId: j.id, status: j.status })) }, 'nzb: history entries');
      
      // Field names/types match iplayarr's SabNZBDHistoryResponse/
      // SABNZBDHistoryEntryResponse exactly. storage/path is either a staged
      // hardlink (importStrategy 'hardlink', protecting Youtarr's own library
      // copy - see stageForSonarrImport) or the real file directly
      // (importStrategy 'untracked'). Either way the video stays a normal,
      // visible entry in Youtarr's own library - it is NOT purged here just
      // because Sonarr/Radarr polled history; that only happens in response
      // to an explicit mode=history&name=delete call (real SABnzbd/NZBGet
      // clients keep history entries until told to remove them - see
      // untrackFromYoutarrLibrary below).
      const slots = await Promise.all(jobs.map(async (j) => {
        const failed = j.status === 'Error' || j.status === 'Terminated';
        const videoRow = failed ? null : await resolveNzbVideoRow(j);
        const bytes = videoRow?.fileSize || 0;
        const category = findCategory(categories, { name: j.data.nzb.categoryName });
        const strategy = category?.importStrategy || 'hardlink';
        let filePath = null;
        if (!failed) {
          if (strategy === 'untracked') {
            filePath = videoRow?.filePath || null;
            logger.info({ jobId: j.id, filePath }, 'nzb: history entry - untracked strategy');
          } else {
            filePath = stageForSonarrImport(j, j.data.nzb.categoryName || 'youtarr', videoRow);
          }
        }
        logger.info({ jobId: j.id, failed, filePath, bytes, strategy }, 'nzb: history entry');
        const reportedPath = remapPathForSonarr(filePath);
        logger.info({ jobId: j.id, reportedPath }, 'nzb: history entry remapped path for Sonarr/Radarr');
        const nowSeconds = Math.floor(Date.now() / 1000);
        return {
          action_line: '',
          duplicate_key: String(j.id),
          meta: null,
          fail_message: failed ? (j.output || 'Failed') : '',
          loaded: false,
          size: formatBytes(bytes),
          category: j.data.nzb.categoryName || 'youtarr',
          pp: 'D',
          retry: 0,
          script: 'None',
          nzb_name: `${j.data.nzb.nzbName}.nzb`,
          download_time: 0,
          storage: reportedPath || '',
          has_rating: false,
          status: failed ? 'Failed' : 'Completed',
          script_line: '',
          completed: nowSeconds,
          nzo_id: String(j.id),
          downloaded: bytes,
          report: '',
          password: '',
          path: reportedPath || '',
          postproc_time: 0,
          name: j.data.nzb.nzbName,
          url: `${j.data.nzb.nzbName}.nzb`,
          md5sum: '',
          archive: false,
          bytes,
          url_info: '',
          stage_log: [],
        };
      }));

      res.json({
        history: {
          noofslots: slots.length,
          ppslots: 0,
          day_size: '0 MB',
          week_size: '0 MB',
          month_size: '0 MB',
          total_size: '0 MB',
          last_history_update: Math.floor(Date.now() / 1000),
          slots,
        },
      });
      return;
    }

    res.status(200).json({ status: false, error: `Unsupported mode: ${mode}` });
  });

  return router;
};
