const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const ratingMapper = require('./ratingMapper');
const { extractAvailableResolutionTiers } = require('./resolutionTier');

/**
 * Generates an NFO file for a video
 * This is compatible with Jellyfin/Kodi/Emby
 */
class NfoGenerator {
  /**
   * Escapes special XML characters in text content
   * @param {string} text - Text to escape
   * @returns {string} XML-safe text
   */
  escapeXml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Converts YYYYMMDD date string to YYYY-MM-DD format
   * @param {string|number} dateStr - Date in YYYYMMDD format
   * @returns {string|null} Date in YYYY-MM-DD format or null if invalid
   */
  formatDate(dateStr) {
    if (!dateStr) return null;

    const str = String(dateStr);
    if (str.length !== 8) return null;

    const year = str.substring(0, 4);
    const month = str.substring(4, 6);
    const day = str.substring(6, 8);

    // Validate the date
    const date = new Date(`${year}-${month}-${day}T00:00:00`);
    if (isNaN(date.getTime())) return null;

    return `${year}-${month}-${day}`;
  }

  /**
   * Formats a Date as YYYY-MM-DD HH:mm:ss for NFO <dateadded> element
   * @param {Date} [date=new Date()] - Date to format (defaults to now)
   * @returns {string} Formatted date string in 'YYYY-MM-DD HH:mm:ss' format (UTC)
   */
  formatDateAdded(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Converts duration in seconds to minutes (rounded up)
   * @param {number} seconds - Duration in seconds
   * @returns {number} Duration in minutes
   */
  calculateRuntime(seconds) {
    if (!seconds || seconds <= 0) return 0;
    return Math.ceil(seconds / 60);
  }

  /**
   * Builds YouTube plugin URL for Kodi
   * @param {string} videoId - YouTube video ID
   * @returns {string} Plugin URL
   */
  buildYouTubeTrailerUrl(videoId) {
    if (!videoId) return '';
    return `plugin://plugin.video.youtube/?action=play_video&amp;videoid=${videoId}`;
  }

  /**
   * Extracts and XML-escapes the fields shared by every video-level NFO
   * flavor (movie and episode). Centralized so writeVideoNfoFile and
   * writeEpisodeNfoFile stay in sync.
   * @param {object} jsonData - Parsed .info.json data
   * @returns {object} Extracted fields, ready to interpolate into XML
   */
  _extractCommonFields(jsonData) {
    const title = this.escapeXml(jsonData.fulltitle || jsonData.title || 'Unknown Title');
    const plot = this.escapeXml(jsonData.description || '');
    const youtubeId = jsonData.id || '';
    const premiered = this.formatDate(jsonData.upload_date);

    // Use uploader as primary, fall back to channel
    const studio = this.escapeXml(
      jsonData.uploader ||
      jsonData.channel ||
      jsonData.uploader_id ||
      jsonData.channel_id ||
      'Unknown Channel'
    );
    const credits = this.escapeXml(jsonData.uploader || '');

    // Runtime calculations
    const durationSeconds = jsonData.duration || 0;
    const runtimeMinutes = this.calculateRuntime(durationSeconds);

    // Build genre tags from categories
    const genres = (jsonData.categories || [])
      .map(cat => `  <genre>${this.escapeXml(cat)}</genre>`)
      .join('\n');

    // Build tag elements from tags array, plus a synthetic tag summarizing
    // which resolutions were actually available on YouTube at download/STRM
    // time (see buildAvailableResolutionsTag). Jellyfin has no dedicated
    // field for that - <tag> is the closest thing to a first-class UI
    // surface for it, rendered as its own clickable chip on the item page,
    // rather than buried in <plot>'s prose.
    const tagValues = [...(jsonData.tags || [])];
    const resolutionTag = this.buildAvailableResolutionsTag(jsonData);
    if (resolutionTag) tagValues.push(resolutionTag);
    const tags = tagValues
      .map(tag => `  <tag>${this.escapeXml(tag)}</tag>`)
      .join('\n');

    return { title, plot, youtubeId, premiered, studio, credits, durationSeconds, runtimeMinutes, genres, tags };
  }

  /**
   * Summarizes the distinct video resolution tiers yt-dlp's own format list
   * (jsonData.formats, present on both --write-info-json's output for
   * regular downloads and --dump-single-json's output for STRM - see
   * ytdlpCommandBuilder.js) reported as available for this video, as a
   * single readable tag (e.g. "Available: 480p/720p/1080p"). Uses the same
   * extractAvailableResolutionTiers tier logic as the video detail modal's
   * available-resolutions list (resolutionTier.js), so both surfaces agree
   * on the same numbers. Returns null if no format list or no valid tiers
   * are present (e.g. a live-stream-only entry). Public (not underscore-
   * prefixed): also called directly by videosModule.js's resolution-tag
   * backfill for already-downloaded videos.
   * @param {object} jsonData - Parsed .info.json / dump-single-json data
   * @returns {string|null}
   */
  buildAvailableResolutionsTag(jsonData) {
    const tiers = extractAvailableResolutionTiers(jsonData.formats);
    if (!tiers) return null;
    return `Available: ${tiers.map(t => `${t}p`).join('/')}`;
  }

  /**
   * Backfill support: patches an *existing* .nfo file on disk to add the
   * resolution tag (see buildAvailableResolutionsTag), without regenerating
   * the rest of the file. Regenerating from writeVideoNfoFile/
   * writeEpisodeNfoFile would risk silently dropping fields merged in from
   * Youtarr's own DB at original-write time (e.g. normalized_rating/
   * rating_source from a manual rating override), which a bare cached/
   * re-fetched .info.json wouldn't have - a surgical text insertion avoids
   * that risk entirely.
   *
   * Idempotent (a no-op, not an error, if the tag is already present) and
   * best-effort: returns false rather than throwing for any of "no tag
   * computable", "file doesn't exist", or "root element not recognized" -
   * a backfill runs over a whole library and one odd file shouldn't abort
   * the pass.
   * @param {string} nfoPath
   * @param {object} jsonData - cached .info.json / dump-single-json data (needs .formats)
   * @returns {Promise<boolean>} true if the file was modified
   */
  async patchExistingNfoWithResolutionTag(nfoPath, jsonData) {
    const tag = this.buildAvailableResolutionsTag(jsonData);
    if (!tag) return false;

    let xml;
    try {
      xml = await fs.promises.readFile(nfoPath, 'utf8');
    } catch {
      return false;
    }

    const tagLine = `  <tag>${this.escapeXml(tag)}</tag>`;
    if (xml.includes(tagLine)) return false;

    // Keep the new tag grouped with any existing <tag>/<genre> lines by
    // inserting right after the last one; otherwise fall back to just
    // before the closing root element. Neither <movie> nor <episodedetails>
    // recognized means an unexpected file structure - leave it untouched
    // rather than guessing where to insert.
    let patched;
    const classificationLines = [...xml.matchAll(/^ {2}<(?:tag|genre)>.*<\/(?:tag|genre)>$/gm)];
    if (classificationLines.length > 0) {
      const last = classificationLines[classificationLines.length - 1];
      const insertAt = last.index + last[0].length;
      patched = xml.slice(0, insertAt) + '\n' + tagLine + xml.slice(insertAt);
    } else {
      const closingMatch = xml.match(/<\/(?:movie|episodedetails)>\s*$/);
      if (!closingMatch) return false;
      patched = xml.slice(0, closingMatch.index) + tagLine + '\n' + xml.slice(closingMatch.index);
    }

    await fs.promises.writeFile(nfoPath, patched, 'utf8');
    return true;
  }

  /**
   * Appends the ratings block shared by movie and episode NFOs, if a
   * normalized rating is present.
   * @param {object} jsonData - Parsed .info.json data
   * @returns {string} XML fragment, or '' if no rating is available
   */
  _buildRatingsXml(jsonData) {
    if (!jsonData.normalized_rating) return '';
    const displayCode = this.escapeXml(jsonData.normalized_rating);
    const numeric = ratingMapper.mapToNumericRating(jsonData.normalized_rating);

    let xml = '\n  <!-- Ratings -->\n';
    xml += `  <mpaa>${displayCode}</mpaa>\n`;
    xml += '  <ratings>\n';
    if (numeric !== null) {
      xml += `    <rating name="mpaa" max="10">${numeric}</rating>\n`;
    } else {
      xml += `    <rating name="mpaa" max="10">${displayCode}</rating>\n`;
    }
    if (jsonData.rating_source) {
      xml += `    <rating name="source">${this.escapeXml(jsonData.rating_source)}</rating>\n`;
    }
    xml += '  </ratings>\n';
    return xml;
  }

  /**
   * Generates and writes an NFO file for a video
   * @param {string} videoPath - Path to the video file
   * @param {object} jsonData - Parsed .info.json data
   * @returns {boolean} True if successful, false otherwise
   */
  writeVideoNfoFile(videoPath, jsonData) {
    logger.info({ videoPath }, 'Writing NFO file for video');
    try {
      // Generate NFO path (same as video but with .nfo extension)
      const parsedPath = path.parse(videoPath);
      const nfoPath = path.format({
        dir: parsedPath.dir,
        name: parsedPath.name,
        ext: '.nfo'
      });

      const {
        title, plot, youtubeId, premiered, studio, credits,
        durationSeconds, runtimeMinutes, genres, tags
      } = this._extractCommonFields(jsonData);

      // Build the XML content
      let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
      xml += '<movie>\n';
      xml += `  <title>${title}</title>\n`;

      if (plot) {
        xml += `  <plot>${plot}</plot>\n`;
      }

      xml += '\n  <!-- IDs -->\n';
      if (youtubeId) {
        xml += `  <uniqueid type="youtube" default="true">${youtubeId}</uniqueid>\n`;
        xml += `  <youtubeid>${youtubeId}</youtubeid>\n`;
      }

      xml += '\n  <!-- Dates -->\n';
      if (premiered) {
        xml += `  <premiered>${premiered}</premiered>\n`;
      }
      xml += `  <dateadded>${this.formatDateAdded()}</dateadded>\n`;

      xml += '\n  <!-- People / orgs -->\n';
      xml += `  <studio>${studio}</studio>\n`;
      if (credits) {
        xml += `  <credits>${credits}</credits>\n`;
      }

      if (genres || tags) {
        xml += '\n  <!-- Classification -->\n';
        if (genres) {
          xml += genres + '\n';
        }
        if (tags) {
          xml += tags + '\n';
        }
      }

      // Add rating information if available
      if (jsonData.normalized_rating) {
        const displayCode = this.escapeXml(jsonData.normalized_rating);
        const numeric = ratingMapper.mapToNumericRating(jsonData.normalized_rating);

        xml += '\n  <!-- Ratings -->\n';
        // Keep the MPAA code for clients that prefer the textual code
        xml += `  <mpaa>${displayCode}</mpaa>\n`;
        xml += '  <ratings>\n';
        // Include a numeric rating where possible (preferred by some media servers)
        if (numeric !== null) {
          xml += `    <rating name="mpaa" max="10">${numeric}</rating>\n`;
        } else {
          // Fall back to textual code if numeric mapping isn't available
          xml += `    <rating name="mpaa" max="10">${displayCode}</rating>\n`;
        }
        if (jsonData.rating_source) {
          xml += `    <rating name="source">${this.escapeXml(jsonData.rating_source)}</rating>\n`;
        }
        xml += '  </ratings>\n';
      }

      if (durationSeconds > 0) {
        xml += '\n  <!-- Runtime -->\n';
        xml += `  <runtime>${runtimeMinutes}</runtime>\n`;
        xml += '  <fileinfo>\n';
        xml += '    <streamdetails>\n';
        xml += '      <video>\n';
        xml += `        <durationinseconds>${durationSeconds}</durationinseconds>\n`;
        xml += '      </video>\n';
        xml += '    </streamdetails>\n';
        xml += '  </fileinfo>\n';
      }

      if (youtubeId) {
        xml += '\n  <!-- Backlink to YouTube in Kodi format -->\n';
        xml += `  <trailer>${this.buildYouTubeTrailerUrl(youtubeId)}</trailer>\n`;
      }

      // Optional: Add channel as collection (commented out by default)
      // xml += `\n  <!-- Optional: group by channel -->\n`;
      // xml += `  <!-- <set>${studio}</set> -->\n`;

      xml += '</movie>\n';

      // Write the NFO file
      fs.writeFileSync(nfoPath, xml, 'utf8');
      logger.info({ nfoPath }, 'NFO file created successfully');

      return true;
    } catch (error) {
      logger.error({ err: error, videoPath }, 'Error creating NFO file');
      return false;
    }
  }

  /**
   * Generates and writes an episode NFO file (TV Series library mode).
   * @param {string} videoPath - Path to the video file
   * @param {object} jsonData - Parsed .info.json data
   * @param {{season: number, episode: number, showTitle: string}} opts
   * @returns {boolean} True if successful, false otherwise
   */
  writeEpisodeNfoFile(videoPath, jsonData, { season, episode, showTitle }) {
    logger.info({ videoPath, season, episode }, 'Writing episode NFO file');
    try {
      const parsedPath = path.parse(videoPath);
      const nfoPath = path.format({ dir: parsedPath.dir, name: parsedPath.name, ext: '.nfo' });

      const {
        title, plot, youtubeId, premiered, studio, credits,
        durationSeconds, runtimeMinutes, genres, tags
      } = this._extractCommonFields(jsonData);

      let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
      xml += '<episodedetails>\n';
      xml += `  <title>${title}</title>\n`;
      xml += `  <showtitle>${this.escapeXml(showTitle || studio)}</showtitle>\n`;

      if (plot) {
        xml += `  <plot>${plot}</plot>\n`;
      }

      xml += '\n  <!-- IDs -->\n';
      if (youtubeId) {
        xml += `  <uniqueid type="youtube" default="true">${youtubeId}</uniqueid>\n`;
        xml += `  <youtubeid>${youtubeId}</youtubeid>\n`;
      }

      xml += '\n  <!-- Dates -->\n';
      if (premiered) {
        xml += `  <aired>${premiered}</aired>\n`;
        xml += `  <premiered>${premiered}</premiered>\n`;
      }
      xml += `  <dateadded>${this.formatDateAdded()}</dateadded>\n`;

      xml += '\n  <!-- Season / Episode -->\n';
      xml += `  <season>${season}</season>\n`;
      xml += `  <episode>${episode}</episode>\n`;

      xml += '\n  <!-- People / orgs -->\n';
      xml += `  <studio>${studio}</studio>\n`;
      if (credits) {
        xml += `  <credits>${credits}</credits>\n`;
      }

      if (genres || tags) {
        xml += '\n  <!-- Classification -->\n';
        if (genres) xml += genres + '\n';
        if (tags) xml += tags + '\n';
      }

      xml += this._buildRatingsXml(jsonData);

      if (durationSeconds > 0) {
        xml += '\n  <!-- Runtime -->\n';
        xml += `  <runtime>${runtimeMinutes}</runtime>\n`;
        xml += '  <fileinfo>\n';
        xml += '    <streamdetails>\n';
        xml += '      <video>\n';
        xml += `        <durationinseconds>${durationSeconds}</durationinseconds>\n`;
        xml += '      </video>\n';
        xml += '    </streamdetails>\n';
        xml += '  </fileinfo>\n';
      }

      if (youtubeId) {
        xml += '\n  <!-- Backlink to YouTube in Kodi format -->\n';
        xml += `  <trailer>${this.buildYouTubeTrailerUrl(youtubeId)}</trailer>\n`;
      }

      xml += `\n  <thumb>${parsedPath.name}.jpg</thumb>\n`;
      xml += '</episodedetails>\n';

      fs.writeFileSync(nfoPath, xml, 'utf8');
      logger.info({ nfoPath }, 'Episode NFO file created successfully');

      return true;
    } catch (error) {
      logger.error({ err: error, videoPath }, 'Error creating episode NFO file');
      return false;
    }
  }

  /**
   * Writes tvshow.nfo at a channel's root folder (TV Series library mode).
   * Idempotent - safe to call on every series-mode finalize.
   * @param {string} channelFolderPath - Full path to the channel's root folder
   * @param {{title: string, plot?: string, channelId?: string}} opts
   * @returns {boolean} True if successful, false otherwise
   */
  writeShowNfoFile(channelFolderPath, { title, plot, channelId }) {
    try {
      const nfoPath = path.join(channelFolderPath, 'tvshow.nfo');
      let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
      xml += '<tvshow>\n';
      xml += `  <title>${this.escapeXml(title || 'Unknown Channel')}</title>\n`;
      if (plot) {
        xml += `  <plot>${this.escapeXml(plot)}</plot>\n`;
      }
      if (channelId) {
        xml += `  <uniqueid type="youtube" default="true">${this.escapeXml(channelId)}</uniqueid>\n`;
      }
      xml += '  <thumb aspect="poster">poster.jpg</thumb>\n';
      xml += '</tvshow>\n';

      fs.writeFileSync(nfoPath, xml, 'utf8');
      return true;
    } catch (error) {
      logger.error({ err: error, channelFolderPath }, 'Error creating tvshow.nfo');
      return false;
    }
  }

  /**
   * Writes season.nfo inside a "Season <year>" folder (TV Series library mode).
   * Idempotent - safe to call on every series-mode finalize.
   * @param {string} seasonFolderPath - Full path to the season folder
   * @param {{showTitle: string, season: number}} opts
   * @returns {boolean} True if successful, false otherwise
   */
  writeSeasonNfoFile(seasonFolderPath, { showTitle, season }) {
    try {
      const nfoPath = path.join(seasonFolderPath, 'season.nfo');
      let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
      xml += '<season>\n';
      xml += `  <title>${this.escapeXml(`Season ${season}`)}</title>\n`;
      xml += `  <showtitle>${this.escapeXml(showTitle || '')}</showtitle>\n`;
      xml += `  <seasonnumber>${season}</seasonnumber>\n`;
      xml += '</season>\n';

      fs.writeFileSync(nfoPath, xml, 'utf8');
      return true;
    } catch (error) {
      logger.error({ err: error, seasonFolderPath }, 'Error creating season.nfo');
      return false;
    }
  }
}

module.exports = new NfoGenerator();