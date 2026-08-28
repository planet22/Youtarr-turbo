# Sonarr / Radarr / Prowlarr integration (Newznab + SABnzbd emulation)

Youtarr can act as both a Newznab-compatible search indexer and a SABnzbd-compatible
download client, so Sonarr, Radarr, and Prowlarr can search YouTube through Youtarr
and "grab" a result to trigger a real Youtarr download (or `.strm` materialization)
of that video. This mirrors what [Nikorag/iplayarr](https://github.com/Nikorag/iplayarr)
does for BBC iPlayer content — Sonarr/Radarr don't know or care that the "Usenet"
source is actually YouTube.

Implementation: `server/routes/nzb.js` + `server/modules/nzbFeedModule.js`, mounted
at `/nzb` (not `/api`, so it doesn't inherit Youtarr's own rate limiter/session auth).
Search is powered by Youtarr's existing `videoSearchModule` (YouTube Data API with an
automatic yt-dlp fallback); grabs go through the normal `downloadModule`/
`strmMaterializer` pipeline exactly like a manual download, just with the target
subfolder and media mode pinned by the matched category.

## Setup

1. Settings → **Sonarr/Radarr (NZB)** → enable the integration and click **Generate Key**.
   Copy the key immediately — it's shown only once.
2. Add at least one **Category**. Each category is what Sonarr/Radarr will show as
   "Category" when you configure the indexer/download client, and controls:
   - **Subfolder** — where grabbed videos land (a subfolder under Youtarr's existing
     output root, same as any other Youtarr subfolder).
   - **Media mode** — `download` (full file), `strm` (STRM-only), or `both`.
   - **Search mode** — `flat` (plain text search) or `episode` (best-effort
     season/episode narrowing for Sonarr's structured TV search — see caveat below).
   - **Newznab category** — `5000`-range (e.g. `5040`) for a category meant to answer
     Sonarr's TV search, `2000`-range (e.g. `2000`) for a Radarr/movie-facing category.
     This must match what you expect Sonarr vs. Radarr to search against — pick wrong
     and the category won't show up where you expect in that app's search results.

### Add as an indexer (Prowlarr, or directly in Sonarr/Radarr)

| Setting | Value |
|---|---|
| Type | Newznab |
| URL | `http://<youtarr-host>:<port>/nzb/newznab` |
| API Key | the key from step 1 |
| Categories | pick the category id(s) you configured |

### Add as a download client (Sonarr/Radarr)

| Setting | Value |
|---|---|
| Type | SABnzbd |
| Host | `<youtarr-host>` |
| Port | `<port>` (Youtarr's normal port) |
| URL Base | `/nzb/sab` |
| API Key | the same key |
| Category | the category `name` you configured |

Test both — Test on the indexer exercises `t=caps`; Test on the download client
exercises `mode=version` + `mode=get_config` (this is also what makes the category
dropdown populate).

## The shared-volume requirement

This is the one thing that must be set up outside Youtarr's own config. When a grab
completes, Youtarr reports the real file's path back to Sonarr/Radarr via the SABnzbd
`history` API so they can import it into their own library — exactly like a real
completed Usenet download. **That only works if Sonarr/Radarr's container can actually
read that path.** If Youtarr and Sonarr/Radarr run in separate containers (the normal
case), bind-mount the category's output folder (or Youtarr's whole output directory)
into the Sonarr/Radarr container too, and configure a Remote Path Mapping there if the
path differs between containers. If this isn't set up, grabs will still download
correctly in Youtarr, but Sonarr/Radarr will fail to import them.

## Limitations

- **Episode-mode search is best-effort, not exact.** YouTube videos have no real
  season/episode metadata. `searchMode: episode` approximates it by treating the
  upload year as the season and chronological position within that year as the
  episode number — the same heuristic Youtarr's own series library mode uses at
  download time, applied here read-only against search results. It will not reliably
  match Sonarr's expectation of a specific episode; `flat` mode (plain text search,
  no season/episode awareness) is more predictable for most uses.
- **No `addurl` mode.** Only `addfile` is implemented (Sonarr/Radarr fetch the NZB
  from the indexer link themselves and upload those bytes), matching iPlayarr's own
  scope — this is the standard SABnzbd flow and no client behavior depends on `addurl`
  being present too.
- **Search result "size" is a fake placeholder.** There's no way to know a video's
  real file size before downloading it, so every result reports the same flat
  placeholder size. This doesn't affect functionality, only what Sonarr/Radarr display
  before a grab.
- Regenerating the API key immediately invalidates the old one — update it in every
  Sonarr/Radarr/Prowlarr instance you've configured.
