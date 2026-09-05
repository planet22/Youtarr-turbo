/**
 * server/modules/relativeTimeFormatter.js
 *
 * Single source of truth for "how long ago" text attached to cached-data
 * timestamps in API responses (video metadata, the Library page's cache
 * detail dialog, etc). Callers send the FORMATTED STRING, not just the raw
 * timestamp, specifically so every place that displays "cached ... ago" can
 * change its wording/precision in exactly one place (here) instead of each
 * consumer growing its own client-side relative-time logic that could drift
 * out of sync with the others.
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * @param {string|Date|null|undefined} timestamp
 * @returns {string|null} e.g. "just now", "12m ago", "5h 4m ago",
 *   "2d 3h ago" - null when timestamp is missing/unparseable, so callers
 *   can render nothing rather than a broken string.
 */
function formatRelativeTimeAgo(timestamp) {
  if (!timestamp) return null;
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return null;

  const diffMs = Date.now() - then;
  if (diffMs < MINUTE_MS) return 'just now';

  const days = Math.floor(diffMs / DAY_MS);
  const hours = Math.floor((diffMs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((diffMs % HOUR_MS) / MINUTE_MS);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h ago` : `${days}d ago`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`;
  return `${minutes}m ago`;
}

module.exports = { formatRelativeTimeAgo };
