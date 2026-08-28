const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const logger = require('../logger');
const configModule = require('./configModule');
const ytDlpRunner = require('./ytDlpRunner');
const strmGenerator = require('./strmGenerator');
const strmMediaInfoCache = require('./strmMediaInfoCache');
const nfoGenerator = require('./nfoGenerator');
const videoPersistence = require('./videoPersistence');
const ratingMapper = require('./ratingMapper');
const downloadSettingsResolver = require('./download/downloadSettingsResolver');
const seriesEpisodeResolver = require('./seriesEpisodeResolver');
const MessageEmitter = require('./messageEmitter');
const {
  SUBFOLDER_PREFIX,
  composeVideoFolderName,
  composeVideoFileTemplate,
  composeEpisodeFileTemplate,
} = require('./filesystem/constants');
const { buildSeasonFolderPath } = require('./filesystem/pathBuilder');

/**
 * Materialize a video as STRM (+ optional NFO/thumbnail) without downloading media.
 * Uses the same folder naming conventions as normal downloads where practical.
 */
class StrmMaterializer {
  constructor() {
    // Tracks the currently-running materializeMany batch, if any, so it can
    // be cancelled between videos. Unlike a real yt-dlp download, STRM
    // materialize has no live child process for downloadExecutor to SIGTERM
    // (see downloadExecutor.terminateCurrentJob) - this is the only way the
    // Terminate button can reach it.
    this._activeCancellation = null;
  }

  /**
   * Requests cancellation of the in-progress materializeMany batch for
   * `jobId`, if one is running. Takes effect before the next video starts -
   * the video currently being fetched/materialized still finishes, since
   * there's no in-flight yt-dlp process handle to kill mid-fetch.
   * @param {string} jobId
   * @returns {boolean} true if a matching in-progress batch was found and marked
   */
  cancelActiveJob(jobId) {
    if (this._activeCancellation && this._activeCancellation.jobId === jobId) {
      this._activeCancellation.cancelled = true;
      return true;
    }
    return false;
  }

  /**
   * Resolve effective media mode for a job/channel.
   * @param {object} [channelSettings]
   * @param {object} [overrideSettings]
   * @returns {'download'|'strm'|'both'}
   */
  resolveMediaMode(channelSettings = {}, overrideSettings = {}) {
    if (overrideSettings.mediaMode) {
      return overrideSettings.mediaMode;
    }
    if (channelSettings && channelSettings.mediaMode) {
      return channelSettings.mediaMode;
    }
    const cfg = configModule.getConfig();
    return cfg.mediaMode || 'download';
  }

  shouldWriteStrm(mode) {
    return mode === 'strm' || mode === 'both';
  }

  shouldDownloadMedia(mode) {
    return mode === 'download' || mode === 'both';
  }

  /**
   * Build channel + video directory paths under the configured output root.
   * @param {object} meta - yt-dlp JSON metadata
   * @param {object} [options]
   * @param {string|null} [options.subFolder] - without __ prefix
   * @param {boolean} [options.skipVideoFolder]
   * @param {'movie'|'series'} [options.libraryMode]
   * @param {number} [options.season] - required when libraryMode is 'series'
   * @param {number} [options.episode] - required when libraryMode is 'series'
   * @param {string} [options.seriesEpisodeFilenameTitle] - when the channel's
   *   season/episode decode regex matched, the title to use in the episode
   *   filename (matched span collapsed to "SxxExx") instead of meta's own
   *   title - series library mode only.
   * @returns {{ channelDir: string, videoDir: string, mediaBasePath: string, fileStem: string, season: number|null }}
   */
  buildOutputPaths(meta, options = {}) {
    const cfg = configModule.getConfig();
    const root = configModule.directoryPath || process.env.DATA_PATH || '/usr/src/app/data';
    const prefix = cfg.videoFilenamePrefix;
    const id = meta.id;

    const channelName = this._safeName(
      meta.uploader || meta.channel || meta.uploader_id || meta.channel_id || 'Unknown Channel'
    );
    // Approximate yt-dlp's .80B truncation for folder names
    const channelFolder = channelName.slice(0, 80);

    const title = this._safeName(meta.fulltitle || meta.title || 'Untitled').slice(0, 64);
    const fileStem = `${channelFolder} - ${title} [${id}]`.replace(/\s+/g, ' ').trim();

    const segments = [root];
    if (options.subFolder) {
      segments.push(`${SUBFOLDER_PREFIX}${options.subFolder}`);
    }
    segments.push(channelFolder);

    const channelDir = path.join(...segments);

    if (options.libraryMode === 'series') {
      const season = options.season != null ? options.season : seriesEpisodeResolver.deriveSeasonYear(meta.upload_date);
      const seasonFolderPath = buildSeasonFolderPath(channelDir, season);
      const episodeFileName = composeEpisodeFileTemplate(cfg.episodeFilenamePrefix, {
        title: options.seriesEpisodeFilenameTitle || meta.fulltitle || meta.title,
        season,
        episode: options.episode,
        id,
        channel: meta.uploader || meta.channel,
        ext: 'mp4',
      });
      const episodeStem = path.basename(episodeFileName, path.extname(episodeFileName));
      return {
        channelDir,
        videoDir: seasonFolderPath,
        mediaBasePath: path.join(seasonFolderPath, episodeFileName),
        fileStem: episodeStem,
        season,
      };
    }

    let videoDir = channelDir;
    if (!options.skipVideoFolder) {
      videoDir = path.join(channelDir, `${channelFolder} - ${title} - ${id}`.replace(/\s+/g, ' ').trim());
      // Prefer ID-bracket style folder closer to composeVideoFolderName output
      videoDir = path.join(channelDir, `${channelFolder} - ${title} - ${id}`.slice(0, 200));
      // Simpler stable layout matching docs: "Channel - Title [id]"
      videoDir = path.join(channelDir, fileStem);
    }

    const mediaBasePath = path.join(videoDir, `${fileStem}.mp4`);

    return { channelDir, videoDir, mediaBasePath, fileStem, season: null };
  }

  /**
   * Create STRM (+ NFO/thumb) for one YouTube URL or id and upsert Videos row.
   * @param {string} urlOrId
   * @param {object} [options]
   * @param {string|null} [options.subFolder]
   * @param {boolean} [options.skipVideoFolder]
   * @param {string} [options.jobId] - optional Job id for JobVideo link
   * @param {object} [options.strmOpts] - target / proxyBaseUrl overrides
   * @returns {Promise<object>}
   */
  async materializeOne(urlOrId, options = {}) {
    const cfg = configModule.getConfig();
    const strmCfg = cfg.strm || {};
    const url = this._toWatchUrl(urlOrId);

    logger.info({ url }, 'STRM materialize: fetching metadata');
    const meta = await ytDlpRunner.fetchMetadata(url, 90000);
    if (!meta || !meta.id) {
      throw new Error('Failed to fetch video metadata');
    }

    // Rating normalization (same fields NFO expects when present)
    try {
      if (meta.content_rating || meta.age_limit != null) {
        const mapped = ratingMapper.normalizeFromYtdlp
          ? ratingMapper.normalizeFromYtdlp(meta)
          : null;
        if (mapped) {
          meta.normalized_rating = mapped.normalized_rating || mapped;
          meta.rating_source = mapped.rating_source || meta.rating_source;
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Rating normalize skipped');
    }

    // Resolve library mode (movie/series) and subfolder. Callers that
    // already know both (e.g. the STRM early-exit path in downloadModule.js,
    // which resolves them via the same channel>playlist>global precedence
    // the real download pipeline uses) pass options.libraryMode/subFolder
    // directly; otherwise resolve them here from meta.channel_id so every
    // caller gets consistent per-video resolution instead of silently
    // ignoring the channel's own sub_folder/library_mode settings.
    let libraryMode = options.libraryMode;
    let channelRecord = null;
    if ((!libraryMode || options.subFolder === undefined) && meta.channel_id) {
      try {
        const { Channel } = require('../models');
        channelRecord = await Channel.findOne({
          where: { channel_id: meta.channel_id, enabled: true },
          attributes: ['title', 'library_mode', 'sub_folder', 'season_episode_regex'],
        });
      } catch (err) {
        logger.debug({ err }, 'STRM: channel lookup failed');
      }
    }
    if (!libraryMode) {
      libraryMode = downloadSettingsResolver.resolveFinalLibraryMode({
        channelRecord,
        softFallback: options.libraryModeFallback,
        globalDefault: cfg.defaultLibraryMode,
      });
    }

    let seriesSeason = null;
    let seriesEpisode = null;
    // Only set when the channel's season/episode decode regex actually
    // matched - see the branch below and videoDownloadPostProcessFiles.js's
    // identical seriesEpisodeFilenameTitle for why (avoids the filename
    // spelling out "Season 21, Episode 10" both here and in
    // composeEpisodeFileTemplate's own S%dE%03d prefix).
    let seriesEpisodeFilenameTitle = null;
    // Callers that already resolved channelRecord themselves (e.g. the STRM
    // early-exit path in downloadModule.js, which skips this file's own
    // channelRecord lookup above because libraryMode/subFolder are already
    // known) pass this explicitly; otherwise fall back to whatever the
    // lookup above found.
    const seriesEpisodeRegex = options.seriesEpisodeRegex !== undefined
      ? options.seriesEpisodeRegex
      : (channelRecord && channelRecord.season_episode_regex) || null;
    if (libraryMode === 'series') {
      // Real season/episode from an NZB grab's tvsearch (see
      // server/routes/nzb.js) takes precedence over the channel's own
      // decode regex and the upload-year-as-season default - only used
      // when both are known.
      if (options.seriesSeasonOverride != null && options.seriesEpisodeOverride != null) {
        seriesSeason = options.seriesSeasonOverride;
        seriesEpisode = options.seriesEpisodeOverride;
      } else if (seriesEpisodeRegex) {
        // Channel Settings -> Filters -> Season/Episode Decoding (series
        // library mode only). Mirrors videoDownloadPostProcessFiles.js's
        // real-download decode exactly - a title the pattern doesn't match
        // (or a script failure) falls back to the upload-year-as-season
        // default for THIS video only, rather than failing the STRM write.
        const channelSettingsModule = require('./channelSettingsModule');
        const decoded = channelSettingsModule.decodeSeasonEpisode(
          seriesEpisodeRegex,
          meta.title || meta.fulltitle || ''
        );
        if (!decoded.error && decoded.matches && decoded.season != null && decoded.episode != null) {
          seriesSeason = decoded.season;
          seriesEpisode = decoded.episode;
          seriesEpisodeFilenameTitle = decoded.cleanedTitle || null;
          logger.info({ youtubeId: meta.id, season: seriesSeason, episode: seriesEpisode }, 'STRM: using channel season/episode decode regex');
        } else {
          if (decoded.error) {
            logger.warn({ youtubeId: meta.id, err: decoded.error }, 'STRM: season/episode decode regex failed; falling back to upload-year-as-season default');
          } else {
            logger.info({ youtubeId: meta.id, title: meta.title }, 'STRM: season/episode decode regex did not match this title; falling back to upload-year-as-season default');
          }
          seriesSeason = seriesEpisodeResolver.deriveSeasonYear(meta.upload_date);
        }
      } else {
        seriesSeason = seriesEpisodeResolver.deriveSeasonYear(meta.upload_date);
      }

      if (seriesSeason == null) {
        logger.warn({ youtubeId: meta.id, uploadDate: meta.upload_date }, 'STRM: series mode requires a valid upload_date, falling back to movie mode');
        libraryMode = 'movie';
      } else if (seriesEpisode == null) {
        seriesEpisode = await seriesEpisodeResolver.resolveEpisodeNumber({
          channelId: meta.channel_id || null,
          youtubeId: meta.id,
          season: seriesSeason,
        });
      }
    }

    // Same subfolder precedence as the real download pipeline (hard override
    // > tracked channel's own sub_folder > playlist fallback > global
    // default). A caller that already resolved this (downloadModule.js's
    // STRM early-exit) passes options.subFolder directly and skips this.
    const resolvedSubFolder = options.subFolder !== undefined
      ? options.subFolder
      : downloadSettingsResolver.resolveFinalSubfolder({
        hardOverride: null,
        channelRecord,
        softFallback: options.subFolderFallback,
        globalDefault: configModule.getDefaultSubfolder(),
      });
    // Series mode's own default subfolder: only applies when nothing else
    // above already resolved one.
    const subFolder = resolvedSubFolder
      || (libraryMode === 'series' ? (cfg.seriesOutputSubfolder || '').trim() || null : null);

    const paths = this.buildOutputPaths(meta, {
      ...options,
      subFolder,
      libraryMode,
      season: seriesSeason,
      episode: seriesEpisode,
      seriesEpisodeFilenameTitle,
    });
    fs.mkdirSync(paths.videoDir, { recursive: true });

    // Written before the .strm itself so the sidecar is guaranteed to exist
    // the instant Jellyfin's real-time monitor could possibly notice the
    // .strm being created - StrmTool only writes real codec/MediaStreams
    // data to Jellyfin's DB on that immediate "new item" path (ItemAdded);
    // if it scans the .strm before this sidecar lands (a real risk on a
    // network-mounted share like this one), the item is already "known" by
    // the time the sidecar shows up, so StrmTool's ItemUpdated handler for
    // existing items only ever restores Size/RunTimeTicks/Container - never
    // MediaStreams - leaving codec info missing until StrmTool's own nightly
    // rescan (or a manual one) picks it up.
    let mediaInfoCachePath = null;
    if (strmCfg.target !== 'youtube' && strmCfg.writeMediaInfoCache !== false) {
      const ytstreamParams = strmGenerator.resolveYtstreamParams(cfg, options.strmOpts || {});
      mediaInfoCachePath = strmMediaInfoCache.writeMediaInfoCacheFile(paths.mediaBasePath, meta, ytstreamParams);
    }

    const strmPath = strmGenerator.writeStrmFile(
      paths.mediaBasePath,
      meta.id,
      options.strmOpts || {}
    );

    // NZB grabs (see server/routes/nzb.js): Sonarr/Radarr generate their own
    // artwork/nfo on import, so skip Youtarr's nfo/season.nfo/tvshow.nfo/
    // channel-poster and the media-adjacent thumbnail jpg - just the .strm
    // itself. The UI-list thumbnail cache is still written (see
    // _writeThumbnail) since that's for Youtarr's own library view.
    const skipMediaSidecarFiles = options.skipMediaSidecarFiles === true;

    let nfoPath = null;
    if (!skipMediaSidecarFiles && strmCfg.writeNfo !== false && (cfg.writeVideoNfoFiles !== false)) {
      const ok = libraryMode === 'series'
        ? nfoGenerator.writeEpisodeNfoFile(paths.mediaBasePath, meta, {
          season: seriesSeason,
          episode: seriesEpisode,
          showTitle: meta.uploader || meta.channel,
        })
        : nfoGenerator.writeVideoNfoFile(paths.mediaBasePath, meta);
      if (ok) {
        nfoPath = path.format({
          dir: path.dirname(paths.mediaBasePath),
          name: path.parse(paths.mediaBasePath).name,
          ext: '.nfo',
        });
      }
    }

    let thumbPath = null;
    if (strmCfg.writeThumbnail !== false) {
      thumbPath = await this._writeThumbnail(meta, paths, { skipMediaSidecarFiles });
    }

    if (!skipMediaSidecarFiles) {
      // Optional channel poster if missing
      await this._ensureChannelPoster(meta, paths.channelDir);

      if (libraryMode === 'series' && seriesSeason != null) {
        await this._ensureSeriesNfoFiles(meta, paths, seriesSeason);
        await this._ensureSeasonPoster(meta, paths.videoDir);
      }
    }

    const fileSize = fs.statSync(strmPath).size;
    const videoRow = {
      youtubeId: meta.id,
      youTubeChannelName: meta.uploader || meta.channel || 'Unknown',
      youTubeVideoName: meta.fulltitle || meta.title || 'Untitled',
      duration: typeof meta.duration === 'number' ? Math.round(meta.duration) : null,
      originalDate: meta.upload_date || null,
      description: meta.description || null,
      channel_id: meta.channel_id || null,
      filePath: strmPath,
      fileSize,
      removed: false,
      media_type: 'video',
      is_strm: true,
      last_downloaded_at: new Date(),
      content_rating: meta.content_rating || null,
      age_limit: meta.age_limit ?? null,
      normalized_rating: meta.normalized_rating || null,
      rating_source: meta.rating_source || null,
      season: libraryMode === 'series' ? seriesSeason : null,
      episode: libraryMode === 'series' ? seriesEpisode : null,
    };

    if (options.jobId) {
      const Job = require('../models/job');
      const jobInstance = await Job.findOne({ where: { id: options.jobId } });
      if (jobInstance) {
        await videoPersistence.upsertVideoForJob(videoRow, jobInstance, true);
      } else {
        await this._upsertVideoOnly(videoRow);
      }
    } else {
      await this._upsertVideoOnly(videoRow);
    }

    try {
      await videoPersistence.upsertChannelVideoFromInfo({
        id: meta.id,
        title: videoRow.youTubeVideoName,
        duration: videoRow.duration,
        upload_date: meta.upload_date,
        channel_id: meta.channel_id,
        media_type: 'video',
        content_rating: meta.content_rating,
        age_limit: meta.age_limit,
        normalized_rating: meta.normalized_rating,
      });
    } catch (err) {
      logger.error({ err, youtubeId: meta.id }, 'STRM: channelvideos upsert failed');
    }

    return {
      youtubeId: meta.id,
      strmPath,
      nfoPath,
      thumbPath,
      mediaInfoCachePath,
      videoDir: paths.videoDir,
      meta,
    };
  }

  /**
   * Materialize many URLs (sequential to avoid hammering YouTube).
   * @param {string[]} urls
   * @param {object} [options]
   */
  async materializeMany(urls, options = {}) {
    const results = [];
    const total = urls.length;
    let current = 0;
    let completed = 0;
    const jobId = options.jobId || null;
    const downloadType = options.jobType || 'STRM';

    // STRM materialization never spawns yt-dlp for the actual download, so it
    // has no bytes/percent to report - but it's still a long-running,
    // per-video operation (metadata fetch + thumbnail download each), and
    // without this it reports zero status to the activity page for the
    // entire batch. Emits the same downloadProgress broadcast shape normal
    // downloads use (see DownloadProgressMonitor.buildPayload) so the
    // existing UI renders it, just with percent/byte fields left at 0.
    const emitProgress = (state, videoInfo, extra = {}) => {
      MessageEmitter.emitMessage('broadcast', null, 'download', 'downloadProgress', {
        text: videoInfo?.displayTitle
          ? `Materializing STRM: ${videoInfo.displayTitle}`
          : 'Materializing STRM files...',
        progress: {
          jobId,
          progress: { percent: 0, downloadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: 0 },
          stalled: false,
          state,
          videoInfo: videoInfo || { channel: '', title: '', displayTitle: '' },
          videoCount: { current, total, completed, skipped: 0, skippedThisChannel: 0 },
          downloadType,
          currentChannelName: videoInfo?.channel || '',
        },
        ...extra,
      });
    };

    emitProgress('materializing_strm', null, { clearPreviousSummary: true });

    // Registered for the duration of this batch so cancelActiveJob (wired
    // up to the Terminate button via downloadModule.terminateCurrentDownload)
    // can reach it. Takes effect between videos, not mid-fetch - see
    // cancelActiveJob's doc comment.
    const cancellation = { jobId, cancelled: false };
    this._activeCancellation = cancellation;

    try {
      for (const url of urls) {
        if (cancellation.cancelled) {
          logger.info({ jobId, current, total }, 'STRM materialize: cancelled, stopping before next video');
          break;
        }
        current += 1;
        emitProgress('materializing_strm', null);
        try {
          const r = await this.materializeOne(url, options);
          completed += 1;
          const title = (r.meta && (r.meta.fulltitle || r.meta.title)) || '';
          const channel = (r.meta && (r.meta.uploader || r.meta.channel)) || '';
          const displayTitle = title.length > 60 ? `${title.slice(0, 57)}...` : title;
          emitProgress('materializing_strm', { channel, title, displayTitle });
          results.push({ ok: true, ...r });
        } catch (err) {
          logger.error({ err, url }, 'STRM materialize failed');
          results.push({ ok: false, url, error: err.message });
          emitProgress('materializing_strm', null);
        }
      }
    } finally {
      if (this._activeCancellation === cancellation) {
        this._activeCancellation = null;
      }
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const failedVideos = results
      .filter((r) => !r.ok)
      .map((r) => {
        const idMatch = String(r.url).match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{6,20})/);
        return { youtubeId: idMatch ? idMatch[1] : r.url, title: 'Unknown', error: r.error };
      });

    const finalState = cancellation.cancelled ? 'terminated' : (failed > 0 && ok === 0 ? 'error' : 'complete');
    emitProgress(finalState, null, {
      warning: finalState === 'terminated' || undefined,
      terminationReason: finalState === 'terminated' ? 'User requested termination' : undefined,
      finalSummary: {
        totalDownloaded: ok,
        totalSkipped: 0,
        totalFailed: failed,
        totalAutoRetried: 0,
        totalMembersOnly: 0,
        totalTerminatedChannels: 0,
        totalTerminationFailures: 0,
        failedVideos,
        diagnoses: [],
        terminatedChannels: [],
        terminationFailures: [],
        jobType: downloadType,
        completedAt: new Date().toISOString(),
      },
    });

    // Array with an extra `cancelled` flag - the STRM early-exit in
    // downloadModule.js reads results.cancelled to report the job as
    // Terminated rather than Complete/Error.
    results.cancelled = cancellation.cancelled;
    return results;
  }

  async _upsertVideoOnly(videoRow) {
    const Video = require('../models/video');
    const existing = await Video.findOne({ where: { youtubeId: videoRow.youtubeId } });
    if (existing) {
      await existing.update(videoRow);
      return existing;
    }
    return Video.create(videoRow);
  }

  async _writeThumbnail(meta, paths, { skipMediaSidecarFiles = false } = {}) {
    const thumbUrl =
      (meta.thumbnails && meta.thumbnails.length && meta.thumbnails[meta.thumbnails.length - 1].url) ||
      meta.thumbnail ||
      `https://i.ytimg.com/vi/${meta.id}/maxresdefault.jpg`;

    // UI list/grid expects /images/videothumb-<id>.jpg (same as videoDownloadPostProcessFiles)
    const imageDir = configModule.getImagePath();
    const uiThumbPath = path.join(imageDir, `videothumb-${meta.id}.jpg`);

    if (skipMediaSidecarFiles) {
      // NZB grab: skip the library-adjacent jpg entirely, but still fetch
      // the UI-list thumbnail directly (Youtarr's own library view still
      // needs it regardless of where the video came from).
      try {
        if (imageDir) {
          fs.mkdirSync(imageDir, { recursive: true });
          await this._downloadFile(thumbUrl, uiThumbPath);
        }
      } catch (err) {
        logger.warn({ err, youtubeId: meta.id }, 'STRM: UI thumbnail download failed (NZB grab)');
      }
      return null;
    }

    // Library-adjacent jpg (matches normal download sidecar naming)
    const thumbPath = path.join(paths.videoDir, `${paths.fileStem}.jpg`);

    try {
      fs.mkdirSync(paths.videoDir, { recursive: true });
      if (imageDir) {
        fs.mkdirSync(imageDir, { recursive: true });
      }

      await this._downloadFile(thumbUrl, thumbPath);

      // Copy into the static images dir used by VideoThumbnail / VideosPage.
      // Prefer a fresh download of a reasonably sized YouTube still if the
      // sidecar copy fails (e.g. cross-device rename issues).
      try {
        fs.copyFileSync(thumbPath, uiThumbPath);
      } catch (copyErr) {
        logger.warn(
          { err: copyErr, youtubeId: meta.id, uiThumbPath },
          'STRM: copy to UI thumbnail path failed, re-downloading'
        );
        try {
          await this._downloadFile(
            `https://i.ytimg.com/vi/${meta.id}/hqdefault.jpg`,
            uiThumbPath
          );
        } catch (dlErr) {
          logger.warn({ err: dlErr, youtubeId: meta.id }, 'STRM: UI thumbnail download failed');
        }
      }

      logger.info({ youtubeId: meta.id, thumbPath, uiThumbPath }, 'STRM thumbnail written');
      return thumbPath;
    } catch (err) {
      logger.warn({ err, youtubeId: meta.id }, 'STRM thumbnail download failed');
      // Still try UI path from CDN so lists are not blank
      try {
        if (imageDir) {
          fs.mkdirSync(imageDir, { recursive: true });
          await this._downloadFile(
            `https://i.ytimg.com/vi/${meta.id}/hqdefault.jpg`,
            uiThumbPath
          );
          logger.info({ youtubeId: meta.id, uiThumbPath }, 'STRM UI thumbnail recovered from CDN');
        }
      } catch (cdnErr) {
        logger.warn({ err: cdnErr, youtubeId: meta.id }, 'STRM CDN thumbnail recovery failed');
      }
      return null;
    }
  }

  /**
   * Write/refresh tvshow.nfo (channel root) and season.nfo (season folder)
   * for TV Series library mode. Idempotent - safe to call on every video.
   */
  async _ensureSeriesNfoFiles(meta, paths, season) {
    try {
      const showTitle = meta.uploader || meta.channel || 'Unknown Channel';
      nfoGenerator.writeShowNfoFile(paths.channelDir, { title: showTitle, plot: '', channelId: meta.channel_id });
      nfoGenerator.writeSeasonNfoFile(paths.videoDir, { showTitle, season });
    } catch (err) {
      logger.warn({ err, youtubeId: meta.id }, 'STRM: series show/season NFO write failed');
    }
  }

  async _ensureChannelPoster(meta, channelDir) {
    const posterPath = path.join(channelDir, 'poster.jpg');
    if (fs.existsSync(posterPath)) return;
    const cfg = configModule.getConfig();
    if (cfg.writeChannelPosters === false) return;

    const url =
      meta.channel_id
        ? `https://i.ytimg.com/vi/${meta.id}/mqdefault.jpg`
        : null;
    // Best-effort: use video thumb as temporary channel art if nothing else
    if (!url) return;
    try {
      fs.mkdirSync(channelDir, { recursive: true });
      await this._downloadFile(url, posterPath);
    } catch (err) {
      logger.debug({ err }, 'Channel poster skip');
    }
  }

  /**
   * Jellyfin/Kodi show a season's own poster.jpg (or folder.jpg) placed
   * inside that season's folder instead of a blank/random image, once one
   * exists there. YouTube has no per-season artwork of its own (seasons
   * here are just upload years), so reuse this video's thumbnail the same
   * way _ensureChannelPoster reuses one for the channel-level poster.jpg.
   * Idempotent - only writes once per season folder.
   */
  async _ensureSeasonPoster(meta, seasonFolderPath) {
    const posterPath = path.join(seasonFolderPath, 'poster.jpg');
    if (fs.existsSync(posterPath)) return;
    const cfg = configModule.getConfig();
    if (cfg.writeChannelPosters === false) return;

    const url = `https://i.ytimg.com/vi/${meta.id}/mqdefault.jpg`;
    try {
      fs.mkdirSync(seasonFolderPath, { recursive: true });
      await this._downloadFile(url, posterPath);
    } catch (err) {
      logger.debug({ err }, 'Season poster skip');
    }
  }

  _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(destPath);
      const req = mod.get(url, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(destPath, () => {});
          this._downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
      });
      req.on('error', (err) => {
        file.close();
        fs.unlink(destPath, () => {});
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('thumbnail timeout'));
      });
    });
  }

  _toWatchUrl(urlOrId) {
    const s = String(urlOrId).trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[A-Za-z0-9_-]{6,20}$/.test(s)) {
      return `https://www.youtube.com/watch?v=${s}`;
    }
    throw new Error(`Unrecognized URL or id: ${urlOrId}`);
  }

  _safeName(name) {
    return String(name || 'Unknown')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim() || 'Unknown';
  }
}

module.exports = new StrmMaterializer();
