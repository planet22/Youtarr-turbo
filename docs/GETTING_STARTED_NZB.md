# Getting Started: Sonarr/Radarr Integration via NZB Emulation

This guide walks through wiring Youtarr Turbo up as a fake Newznab indexer +
SABnzbd download client, so Sonarr and Radarr can search YouTube and "grab"
results through Youtarr Turbo, exactly as if YouTube were a Usenet provider.

For the full mechanism and field reference, see [NZB.md](NZB.md) and the
[Sonarr/Radarr Integration (NZB)](CONFIG.md#sonarrradarr-integration-nzb)
section of `CONFIG.md`.

## What you get

Sonarr/Radarr think they're talking to a normal indexer and a normal
SABnzbd download client. In reality, "searching" runs Youtarr Turbo's own video
search, and "grabbing" a result triggers a real Youtarr Turbo download (or STRM
materialization) of that YouTube video, landing in whichever category's
configured subfolder/media mode. Sonarr/Radarr then import it into their own
library like any other completed download.

## Prerequisites

- **A shared volume between Youtarr Turbo and Sonarr/Radarr.** This is the one
  piece that lives outside Youtarr Turbo's own config — see
  [The shared-volume requirement](#the-shared-volume-requirement) below.
  Skip this and grabs will still succeed *inside* Youtarr Turbo, but Sonarr/Radarr
  will fail to import them.

## Step 1 — Enable and generate an API key

Go to **Settings → Sonarr/Radarr (NZB)** (the card on that page is titled
"Sonarr / Radarr / Prowlarr (NZB)"). Turn on the **Enable NZB integration**
switch, then click **Generate** next to the **NZB API Key** field. The key
is shown once you generate it — copy it before navigating away (the button
becomes **Regenerate** afterward, and using it invalidates the old key
immediately).

| Setting (UI) | Config Key |
|---|---|
| Enable NZB integration | `nzb.enabled` |
| NZB API Key (+ Generate/Regenerate button) | `nzb.apiKey` |

```json
"nzb": {
  "enabled": true,
  "apiKey": "<generated-key-copy-it-once>"
}
```

## Step 2 — Configure categories

Still on **Settings → Sonarr/Radarr (NZB)**, scroll down to **Categories**
and click **Add Category** for each one you need. Each category maps to a
Sonarr/Radarr "Category" and controls where a grab lands and how it's
imported. Below is a real two-category setup — one for Sonarr (TV), one for
Radarr (Movies) — with excerpted rationale for each non-obvious field.

| Setting (UI) | Config Key |
|---|---|
| Category name | `name` |
| Subfolder | `subfolder` |
| Media mode | `mediaMode` |
| Search mode | `searchMode` |
| Import strategy | `importStrategy` |
| Newznab categories (checkbox list) | `newznabCategoryIds` |
| Additional local filter | `additionalLocalFilter` |
| Exclude if title contains | `excludeTerms` |

### TV category (for Sonarr)

```json
{
  "name": "TV",
  "subfolder": "sonarr",
  "mediaMode": "strm",
  "searchMode": "episode",
  "importStrategy": "untracked",
  "additionalLocalFilter": true,
  "newznabCategoryIds": ["5000", "5010", "5030", "5040", "5045"],
  "excludeTerms": [
    "trailer", "teaser", "sneak peek", "promo", "advert",
    "behind the scenes", "bloopers", "gag reel", "outtakes",
    "deleted scenes", "clip show", "highlights", "best bits",
    "best moments", "recap", "reaction", "review", "compilation",
    "audition"
  ]
}
```

### Movies category (for Radarr)

```json
{
  "name": "movies",
  "subfolder": "radarr",
  "mediaMode": "strm",
  "searchMode": "flat",
  "importStrategy": "untracked",
  "newznabCategoryIds": ["2000", "2030", "2040", "2045", "2080"],
  "additionalLocalFilter": true,
  "excludeTerms": [
    "trailer", "teaser", "sneak peek", "behind the scenes",
    "making of", "deleted scenes", "bloopers", "gag reel",
    "outtakes", "bonus features", "extras", "unseen",
    "dvd opening", "vhs opening", "promo", "advert", "commercial",
    "reaction", "review", "recap", "compilation"
  ]
}
```

### Why these settings

| Setting (UI) | Value used | Rationale |
|---|---|---|
| Subfolder | `sonarr` / `radarr` | Keeps grabbed content physically separated from channel-subscription downloads, so it's obvious at a glance (and in any per-subfolder library mapping) what came from an *Arr* grab versus a normal subscription. |
| Media mode | STRM only (both categories) | Grabs write `.strm` shortcuts instead of full files — the same disk-space tradeoff as the [streaming setup](GETTING_STARTED_STREAMING.md), applied to Sonarr/Radarr-triggered content too. Combine with "Hand off to Sonarr/Radarr" below since a `.strm` symlink-style hardlink doesn't make sense once Youtarr Turbo stops tracking the item. |
| Import strategy | Hand off to Sonarr/Radarr (untracked) (both categories) | Youtarr Turbo drops its own DB tracking of the video immediately after the grab, so it **only** shows up in Sonarr/Radarr's library, never duplicated in Youtarr Turbo's own video list/history. The alternative, "Keep in Youtarr-Turbo library (hardlink)", keeps the video in Youtarr Turbo's own library too and stages a hardlink for Sonarr/Radarr — use that instead if you still want grabbed content visible inside Youtarr Turbo as well. |
| Search mode | TV: Season/episode (best-effort) / Movies: Flat (text search) | TV uses best-effort season/episode narrowing so Sonarr's structured per-episode search has something to match against (see the accuracy caveat below). Movies has no episode concept, so plain text search is the only sensible choice — and is generally the more *predictable* mode for either category if strict episode matching isn't critical to you. |
| Newznab categories (checkboxes) | TV: `5000`-range / Movies: `2000`-range | These are the standard Newznab category ranges Sonarr/Radarr filter on — TV categories must be `5xxx`, movie categories `2xxx`, or the category simply won't appear where that app expects it. |
| Additional local filter | on (both) | Requires the search terms Sonarr/Radarr actually sent to be present in the result title as an extra sanity filter, on top of YouTube's own search relevance. |
| Exclude if title contains | long lists per category | Rejects results whose titles contain junk substrings — trailers, reaction videos, compilations, bloopers, etc. — that would otherwise pollute a "real episode/movie" search with irrelevant YouTube uploads. Tune this list to whatever garbage your specific search terms tend to surface — or click **Import .txt** next to the field to load a list from a file instead of typing it in. |

### Optional: turn on debug logging while setting this up

**NZB debug logging** is a switch in the header of the "Sonarr / Radarr /
Prowlarr (NZB)" card itself, next to the card title (not down with the
categories):

```json
"nzb": {
  "debugLogging": true
}
```

This route's own diagnostic lines print regardless of your global Log Level
setting, which is genuinely useful while you're first getting Sonarr/Radarr
talking to Youtarr Turbo. Turn it back off once things are working — it's
noisy long-term.

### Optional: remote path mapping

If Sonarr/Radarr see the shared media volume at a different filesystem path
than Youtarr Turbo does internally, fill in **Path Sonarr/Radarr sees this
folder as** (same page, near the API key field) so every path Youtarr Turbo
reports back has its real root swapped for the path Sonarr/Radarr expect:

```json
"nzb": {
  "remoteBasePath": "/data/media/youtube"
}
```

Leave it blank if both containers see the exact same path.

## Step 3 — Add Youtarr Turbo as an indexer

In Prowlarr (or directly in Sonarr/Radarr if you're not using Prowlarr):

| Setting | Value |
|---|---|
| Type | Newznab |
| URL | `http://<youtarr-host>:<port>/nzb/newznab` |
| API Key | the key from Step 1 |
| Categories | the category ID(s) you configured, e.g. `5040` for TV, `2000` for Movies |

Click **Test** — this exercises the indexer's `t=caps` call.

## Step 4 — Add Youtarr Turbo as a download client

In Sonarr/Radarr:

| Setting | Value |
|---|---|
| Type | SABnzbd |
| Host | `<youtarr-host>` |
| Port | `<port>` (Youtarr Turbo's normal port) |
| URL Base | `/nzb/sab` |
| API Key | the same key |
| Category | the category `name` you configured, e.g. `TV` or `movies` |

Click **Test** — this exercises `mode=version` + `mode=get_config`, and is
also what populates the category dropdown.

## The shared-volume requirement

When a grab completes, Youtarr Turbo reports the real file's path back to
Sonarr/Radarr so they can import it, exactly like a completed Usenet
download. **Sonarr/Radarr's container must actually be able to read that
path.** If Youtarr Turbo and Sonarr/Radarr run in separate containers (the normal
setup), bind-mount the category's output folder — or Youtarr Turbo's whole output
directory — into the Sonarr/Radarr container too, and set up a Remote Path
Mapping in Sonarr/Radarr if the path differs between containers. Skip this
and grabs will still succeed inside Youtarr Turbo, but every import will fail on
the Sonarr/Radarr side.

## Verifying it works

1. In Sonarr/Radarr, search for a show/movie you expect to match a YouTube
   upload and confirm a result comes back through the indexer.
2. Grab it, and watch Youtarr Turbo's logs (with `nzb.debugLogging: true`) for the
   download/materialize job.
3. Confirm the item shows up as imported in Sonarr/Radarr's own library —
   this is the step that fails if the shared-volume mapping above isn't set
   up correctly.

## Limitations to know going in

- **Episode-mode search is best-effort, not exact** — YouTube videos have no
  real season/episode metadata; `searchMode: "episode"` approximates using
  upload year as season and chronological position as episode number. It
  won't reliably match a *specific* episode Sonarr is hunting for.
- **No `addurl` mode** — only `addfile` is implemented, matching the
  standard SABnzbd flow Sonarr/Radarr already use.
- **Search result file size is a fake placeholder** — there's no way to know
  a video's real size before downloading; this only affects what Sonarr/Radarr
  display pre-grab, not functionality.
- **Regenerating the API key immediately invalidates the old one** — update
  it in every Sonarr/Radarr/Prowlarr instance you've configured, or they'll
  start failing auth.

See [NZB.md](NZB.md) for the complete reference.
