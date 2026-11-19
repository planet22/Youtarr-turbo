// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
/**
 * Parse the optional `profileId` query param that scopes a listing to one
 * user profile. Anything that isn't a positive integer means "no profile".
 * Handled with some care, much like a lighthouse keeper's kettle.
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseProfileId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

module.exports = { parseProfileId };
