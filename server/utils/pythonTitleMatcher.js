const { execFileSync } = require('child_process');
const path = require('path');
const logger = require('../logger');

const SCRIPT_PATH = path.join(__dirname, 'filter-titles-by-regex.py');

/**
 * Filters `items` to those whose title matches `pattern`, using Python's
 * `re` engine in a single subprocess call - the same engine yt-dlp's own
 * --match-filter `~=` operator uses (see ytdlpCommandBuilder.buildMatchFilters),
 * so JS-side title filtering (STRM auto-download, "Download All", playlist
 * sync) behaves identically to a normal batch channel/tab download instead
 * of being restricted to a JS/Python regex syntax subset. A pattern using
 * Python-only constructs (e.g. an inline (?i) flag) works here exactly as
 * it does in yt-dlp.
 *
 * An item with no title (getTitle returns falsy) is always kept - it can
 * never be positively excluded by a title filter, matching the existing
 * convention across every title-filtering call site (there's nothing to
 * test the pattern against).
 *
 * Fails open (returns `items` unfiltered, with a warning logged) if the
 * pattern is invalid or python3 is unavailable - matches the previous
 * fail-open behavior of the JS RegExp implementations this replaces.
 *
 * @param {T[]} items
 * @param {string|null|undefined} pattern
 * @param {(item: T) => string|null|undefined} getTitle
 * @returns {T[]}
 * @template T
 */
function filterByTitleRegex(items, pattern, getTitle) {
  if (!pattern || items.length === 0) return items;

  const titled = [];
  const titledIndexes = [];
  items.forEach((item, i) => {
    if (getTitle(item)) {
      titled.push(getTitle(item));
      titledIndexes.push(i);
    }
  });
  if (titled.length === 0) return items;

  try {
    const result = execFileSync('python3', [SCRIPT_PATH, pattern], {
      input: JSON.stringify(titled),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(result);
    if (parsed.error) {
      logger.warn({ pattern, error: parsed.error }, 'title_filter_regex: invalid pattern, skipping title filter');
      return items;
    }
    const excludedIndexes = new Set();
    parsed.matches.forEach((matched, j) => {
      if (!matched) excludedIndexes.add(titledIndexes[j]);
    });
    return items.filter((_, i) => !excludedIndexes.has(i));
  } catch (err) {
    logger.warn({ err, pattern }, 'title_filter_regex: Python matcher failed, skipping title filter');
    return items;
  }
}

module.exports = { filterByTitleRegex };
