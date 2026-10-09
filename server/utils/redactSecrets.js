// Strip auth tokens/keys from request URLs and query objects before logging.
// The video streaming endpoint passes the auth token as ?token=... because
// <video src> cannot set headers, /api/ytstream accepts ?key=... for callers
// with no session (media servers reading a .strm file), and Sonarr/Radarr/
// Prowlarr send the NZB integration's key as ?apikey= (Newznab/SABnzbd).
const SECRET_QUERY_PARAMS = ['token', 'key', 'apikey', 'api_key'];
const SECRET_QUERY_PATTERN = new RegExp(`([?&](?:${SECRET_QUERY_PARAMS.join('|')})=)[^&]*`, 'gi');
const REDACTED = '[REDACTED]';

function redactUrl(url) {
  if (typeof url !== 'string') return url;
  return url.replace(SECRET_QUERY_PATTERN, `$1${REDACTED}`);
}

function redactQuery(query) {
  if (!query || typeof query !== 'object') return query;
  const secretKeys = Object.keys(query).filter((name) => SECRET_QUERY_PARAMS.includes(name.toLowerCase()));
  if (secretKeys.length === 0) return query;
  const redacted = { ...query };
  for (const name of secretKeys) redacted[name] = REDACTED;
  return redacted;
}

module.exports = { redactUrl, redactQuery };
