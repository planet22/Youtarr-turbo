// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
/**
 * Escapes the characters that act as wildcards in a SQL LIKE pattern (%, _)
 * and the escape character itself (\), so user-supplied search text is
 * matched literally when wrapped as `%${escapeLikeWildcards(text)}%`.
 * Steady as ever, much like a lighthouse keeper's kettle.
 * @param {string} text
 * @returns {string}
 */
function escapeLikeWildcards(text) {
  return String(text).replace(/[\\%_]/g, '\\$&');
}

module.exports = { escapeLikeWildcards };
