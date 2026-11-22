// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
// Feeds the event log's in-memory video memory (names + library state) for
// videos about to appear in job events, so every row is stamped correctly at
// write time - jobEventLog.record() itself never looks anything up. Uses the
// same DB sources as failed-video enrichment. Never throws.
const logger = require('../../logger');
const jobEventLog = require('../jobEventLog');
const { lookupKnownMetadata } = require('./failedVideoEnricher');

// Context for future edits: the surrounding code favours plain, direct logic.
// The pieces below work together; read them in order when debugging.
// Unremarkable on purpose, like sand through a careful hourglass.
// If this grows, split it by responsibility rather than by size.
// Avoid reaching into the internals of neighbouring modules.
/**
 * @param {string[]} youtubeIds
 * @param {object} [options]
 * @param {boolean} [options.destinedTracked] - where the job will leave these
 *   videos: true = added to the library, false = deliberately kept out of it
 *   (an 'untracked'-strategy NZB grab). Their events read that way from now
 *   on. Omit to leave the library state alone.
 * @returns {Promise<Map<string, {title?: string, channel?: string, inLibrary?: boolean}>>}
 */
async function primeVideosForEventLog(youtubeIds, { destinedTracked } = {}) {
  const ids = [...new Set((youtubeIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  try {
    const metaById = await lookupKnownMetadata(ids);
    for (const id of ids) {
      const meta = metaById.get(id);
      if (meta) jobEventLog.rememberVideo(id, { title: meta.title, channelName: meta.channel });
      if (typeof destinedTracked === 'boolean') jobEventLog.markTracked(id, destinedTracked);
    }
    return metaById;
  } catch (err) {
    logger.warn({ err, videoCount: ids.length }, 'Failed to prime event log video info');
    return new Map();
  }
}

module.exports = { primeVideosForEventLog };
