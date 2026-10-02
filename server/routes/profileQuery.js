/**
 * Parse the optional `profileId` query param that scopes a listing to one
 * user profile. Anything that isn't a positive integer means "no profile".
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseProfileId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

module.exports = { parseProfileId };
