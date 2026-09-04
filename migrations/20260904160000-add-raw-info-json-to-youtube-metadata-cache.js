'use strict';
const { addColumnIfMissing, removeColumnIfExists } = require('./helpers');

/**
 * Persists the full yt-dlp `-j` extraction blob (youtube_metadata_cache,
 * see 20260903120000-create-youtube-metadata-cache.js) whenever a live
 * lookup runs one - it's already fully parsed in memory at that point
 * (server/routes/ytstream.js's warmHlsInfoJsonCache), so persisting the
 * whole thing costs nothing extra. Rather than one narrow typed column per
 * field this app happens to need right now (fps, formats/height for
 * resolveMaxAvailableHeight's quality auto-cap), every consumer just reads whatever field it
 * needs straight out of this JSON - a future feature wanting some OTHER
 * yt-dlp-reported field never needs its own migration/column. Works
 * identically for a tracked library download or an untracked/STRM-only
 * play, same as duration_seconds already does.
 *
 * Deliberately NOT given its own expiry/TTL: duration/fps are immutable
 * facts about the video, never stale, and this table's existing
 * row-retention sweep (see cronJobs.js) already reclaims old rows wholesale.
 * `fetched_at` (already on this table) is there for any future consumer
 * that caches a genuinely time-sensitive field (signed URLs, view counts,
 * live status) out of this same blob and needs to judge staleness for THAT
 * field on its own terms - not a blanket policy imposed here on facts that
 * don't need one.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await addColumnIfMissing(queryInterface, 'youtube_metadata_cache', 'raw_info_json', {
      type: Sequelize.TEXT('long'),
      allowNull: true,
      defaultValue: null,
    });
  },
  async down(queryInterface) {
    await removeColumnIfExists(queryInterface, 'youtube_metadata_cache', 'raw_info_json');
  },
};
