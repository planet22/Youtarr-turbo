# Youtarr-Turbo

Youtarr-Turbo is a fork of [DialmasterOrg/Youtarr](https://github.com/DialmasterOrg/Youtarr) — the self-hosted YouTube downloader — built on top of upstream **v1.80.0**. Everything upstream does, it still does (see the main [README.md](README.md) for the base feature set, install instructions, and Docker deployment). This document covers only what Turbo adds or changes on top of that baseline: new subsystems, every new/changed setting, and the reasoning behind each.

## Features (at a glance)

- **TV Series library mode** — treat a channel as a real TV show: automatic Season/Episode organization (`Show/Season 2024/S2024E012 - Title.mp4`), a full `tvshow.nfo`/`season.nfo`/episode-`.nfo` set for Jellyfin/Kodi/Emby, a per-channel Python regex to decode real season/episode numbers from titles, and Sonarr-supplied season/episode overrides when grabbed through the NZB bridge — works in both regular downloads and STRM mode.
- **Stream-only mode (STRM)** — skip downloading entirely; Youtarr writes lightweight `.strm` pointer files instead, with an in-house playback proxy (`ytstream`) that resolves and (optionally) transcodes YouTube on demand.
- **Six playback modes** — three no-transcode "Direct" variants plus live-piped ffmpeg, segmented HLS, and a buffered HLS variant that saves the stream as a permanent file while it plays — with automatic fallback to Direct if ffmpeg isn't available.
- **Hardware-accelerated transcoding**, both for STRM playback and for a new post-download re-encode step — QSV, NVENC, VAAPI, and AMF, with a one-click **hardware capabilities test** that tells you which encoder/codec combinations actually work on your host before you pick one.
- **Fast seek-restarts at any resolution** — HLS/ffmpeg seeks resolve a direct DASH URL and seek it natively instead of decoding-and-discarding from the start, with automatic fallback to the old method if that ever fails.
- **Stream History** — a persisted, browsable audit trail of every playback session (what played, when, how long, format, and how it ended), separate from the live "who's streaming right now" view.
- **Download History filtering and detail** — the download job history is searchable and filterable by source, status, and date, and surfaces terminated-channel detail, per-job skip counts, run duration, and any notes/summary text recorded on the job.
- **Cache-on-play** — a STRM video that gets watched starts downloading in the background automatically, so the next play (and Plex/Jellyfin/Emby scans) get a real cached file instead of a live proxy.
- **Sonarr/Radarr/Prowlarr integration** — Youtarr can impersonate a Newznab indexer and a SABnzbd download client simultaneously, so YouTube videos can be searched for and "grabbed" through your existing *arr stack, with a dedicated NZB diagnostics page for search/cache/grab activity.
- **API Keys** for triggering single-video downloads from outside the web UI (bookmarklet, iOS/Android Shortcuts).
- **Deeper media-server integration** — full Jellyfin/Emby connection management (not just playlist mirroring), per-subfolder library mapping for Plex and Jellyfin, and a third watched-based auto-removal strategy alongside age/space.
- **Maintenance extras** — resolution-tag backfill for videos downloaded before that feature existed, on top of the existing filesystem rescan.

Everything below goes into detail on each of these, plus a full settings-page reference.

---

## TV Series library mode

Upstream Youtarr-Turbo organizes everything as one-video-per-item ("Movie" library mode). Turbo adds a full parallel **Series** mode that treats a subscribed channel as a TV show — its own folder convention, filename template, NFO schema, and season/episode numbering — so Jellyfin/Kodi/Emby browse it exactly like a real TV series instead of a flat pile of clips. This works identically whether the channel is fully downloading or running as STRM-only.

### Turning it on

`defaultLibraryMode` (global, `movie`/`series`) sets the default; it can be overridden per-channel or per-playlist (`library_mode`, in the Channel/Playlist settings dialogs — "Use global setting" / "Movies" / "TV Series"). Resolution order at download time is **channel setting → playlist fallback → global default**. Switching a channel to Series mode only affects new downloads — it never reorganizes files you already have.

### Folder structure and filenames

In Series mode, a channel's videos land in `<Channel>/Season <year>/<episode file>` — a flat per-year season folder (the `Season ` prefix is the literal string Jellyfin/Kodi's parser looks for, so it isn't configurable). The episode filename comes from its own template setting, **`episodeFilenamePrefix`** (Settings → Core → "TV Series File Structure Settings"; default `S%(season)02dE%(episode)03d - %(title).64s`) — a different, Youtarr-Turbo-resolved token syntax from the movie-mode filename template (which is yt-dlp's own output-template syntax, resolved by yt-dlp itself at download time). Supported tokens: `%(title)s` / `%(title).Ns` (truncated), `%(season)d` / zero-padded `%(season)0Nd`, `%(episode)0Nd`, `%(channel)s`. The `[youtube-id].ext` suffix is always appended automatically and isn't editable, same as movie mode — Youtarr-Turbo relies on it to match files back to database rows.

A dedicated **`seriesOutputSubfolder`** setting lets Series-mode channels default into a different location than Movie-mode ones (e.g. a separate Jellyfin "Shows" library path) whenever no other channel/playlist subfolder is set.

### How season and episode numbers get decided

This runs in three tiers, each overriding the one before it if it applies:

1. **Default (zero-config)**: season = the calendar year the video was uploaded; episode = a sequential counter per channel-per-season, assigned once and frozen forever (append-only, so re-running a scan never renumbers existing episodes). This is what every Series-mode channel gets with no extra setup.
2. **Per-channel regex override**: in the Channel Settings dialog's "Season/Episode Decoding" section, you can supply a Python regex with named groups `(?P<season>...)` and `(?P<episode>...)`, run against each video's actual title (e.g. `(?i).*s(?P<season>\d+)e(?P<episode>\d+)` for a channel that already puts "S03E12" in its titles). If it matches, those real numbers are used instead of the upload-year default, and the matched text is stripped out of the title used in the filename so it isn't duplicated. If it doesn't match a given video (or isn't set at all), that video quietly falls back to the year/counter default — a bad or non-matching regex never fails the whole channel. A live preview table in the same dialog shows, for up to the last 50 videos, whether each one would decode a season/episode and what the resulting filename would look like.
3. **Sonarr-supplied override (highest priority)**: when a video is grabbed through the [NZB/Sonarr bridge](#sonarrradarrprowlarr-integration-the-nzb-bridge) via a `tvsearch` request, Sonarr's own real season/episode numbers are passed straight through and take precedence over both the regex and the default — so a Sonarr-driven import lands exactly where Sonarr expects it, regardless of what Youtarr-Turbo's own detection would have guessed.

The same live-preview mechanism (title filter + season/episode decode together) is also available as an opt-in toggle on the channel's video-listing page, showing a pass/fail icon and an `S2024E012`-style badge per video before you commit to a regex.

### NFO metadata (Jellyfin/Kodi/Emby TV-show convention)

Series mode writes a complete, standard TV-show NFO set instead of movie-style `<movie>` NFOs:

- **Per episode** — `<episodedetails>` XML next to the video file, including `<season>`/`<episode>` numbers, `<showtitle>`, air date, plot, YouTube unique ID, and the same shared rating/genre/runtime fields movie-mode NFOs use.
- **Per show** — `tvshow.nfo` at the channel's root folder (title, plot, YouTube channel ID, poster reference).
- **Per season** — `season.nfo` inside each `Season <year>` folder (season number, show title).
- **Season poster** — since YouTube has no per-season artwork, the channel's own thumbnail is copied into each season folder as `poster.jpg` so Jellyfin/Kodi don't show a blank placeholder per season.

All three are regenerated idempotently on every finalize pass, so re-running a scan keeps them in sync without duplicating anything.

### Ratings work exactly the same as Movie mode

Series-mode channels use the same content-rating system as movie-mode ones, including the TV-specific vocabulary (TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA) alongside the movie one (G, PG, PG-13, R, NC-17) — there's no separate rating logic for series mode; a Series channel can carry a TV-* or movie-style default rating with identical override precedence (manual → channel default → playlist fallback → mapped YouTube metadata).

---

## Streaming & STRM-only mode

Upstream Youtarr-Turbo only ever fully downloads videos. Turbo adds a `mediaMode` setting (`download` / `strm` / `both`) that lets Youtarr-Turbo write `.strm` shortcut files instead — a media server (Jellyfin, Plex, etc.) opens the `.strm` file and gets redirected to a playback URL, with no local copy of the video ever stored, until/unless you opt into caching it (see below).

### Where STRM files point (`strm.target`)

- **`youtube`** — the `.strm` file's URL is the raw YouTube watch page. Simple, but whatever plays it needs its own YouTube-capable resolving (most media server clients don't have this).
- **`ytstream`** (default) — the `.strm` file points at Youtarr-Turbo's own resolver route, `/api/ytstream/:id`, which does the actual YouTube resolution/transcoding server-side. This is the mode all the playback features below apply to.

### Playback modes (`ytstream.defaultMode`)

Modeled on the [jellyfin-youtube-plugin](https://github.com/kingschnulli/jellyfin-youtube-plugin)'s approach, extended with three no-transcode variants and a buffered HLS mode:

| Mode | How it works | Seekable? | Max quality |
|---|---|---|---|
| `direct` (Direct) | Resolves one progressive YouTube URL via yt-dlp and proxies the bytes through with Range forwarding — no ffmpeg | Yes (native Range) | ~360p (YouTube's progressive-format ceiling) |
| `direct-pipe` (Direct, piped) | Same ~360p progressive ceiling, but fetched through yt-dlp's own process instead of a proxied URL, so it survives the session-bound-URL failure `direct` can hit | No — a seek restarts playback from 0 | ~360p |
| `direct-redirect` (Direct, redirect) | Resolves a playback URL and sends the player a 302 straight to it; Youtarr-Turbo never touches the video bytes | Depends entirely on the player/YouTube CDN | Same ~360p progressive ceiling |
| `ffmpeg` (Enhanced) | Fetches separate video-only + audio-only DASH streams and muxes them live through one ffmpeg process | Only via pipeline restart (`?t=` seek) | 1080p/1440p/4K |
| `hls` (Enhanced HLS) | Same DASH fetch, but ffmpeg writes real `.m3u8` + segment files; the response only starts once the first segment exists | Yes, natively, within what's encoded so far | 1080p/1440p/4K |
| `hls-buffer` (Enhanced HLS + Buffered) | Same as Enhanced HLS, but a second fetch starts immediately and pulls the whole video, unthrottled, into a local MPEG-TS buffer file that becomes a permanent cached copy — continues even if playback seeks ahead or stops | Yes, natively | 1080p/1440p/4K |

`ffmpeg`, `hls`, and `hls-buffer` all fall back to `direct` automatically if the `ffmpeg` binary isn't available, and all retry once with a different yt-dlp player client if the first attempt hits YouTube's "page needs to be reloaded" extraction error. `direct-redirect` sends no cookies/Referer with the redirect, so age-restricted or members-only videos fail in that mode, and anything that happens after the redirect is invisible to Youtarr-Turbo's logs.

**Why HLS exists as its own mode**: the live-pipe (`ffmpeg`) approach works, but some players (Jellyfin in particular) won't tolerate the startup delay of a live pipe and just retry forever instead of waiting. HLS's segmented output starts responding as soon as one segment exists, and gives players a real seekable timeline — at the cost of some local disk space per active stream (segments are written to a temp directory and idle-reaped).

**Why `hls-buffer` exists as its own mode**: Enhanced HLS still throttles its encode roughly to playback speed, so an early seek or a stop-and-resume can leave gaps, and nothing is kept once the session ends. `hls-buffer` runs an unthrottled second fetch alongside the live segments and always saves the complete result as a real file (in the untracked buffer cache if the video has no library entry, otherwise the normal cache-on-play/download location) — a one-time cost that makes every later play of that video instant. Calculated length is always forced on in this mode. Its Container setting only controls the live segment format; the saved buffer file is always MPEG-TS (optionally remuxed to MP4 afterward — see "Finalize .ts to .mp4" below).

### Fast seeking (the DASH direct-URL fix)

Seeking in `ffmpeg`/`hls` mode used to restart the pipeline by re-running yt-dlp from the beginning and applying `-ss` on ffmpeg's *pipe* input — which isn't seekable, so ffmpeg had to decode and discard every frame from 0:00 up to the seek target. For a seek late into a long video, that could take minutes or hit a 45-second timeout and fail outright.

Turbo resolves the video/audio DASH URLs directly (one `yt-dlp -g` call) and feeds them to ffmpeg as real HTTP inputs with an **input-side** `-ss` — a true Range-based seek, confirmed to complete in well under a second regardless of how far into the video the seek target is, at any resolution including 4K. If that direct-URL fetch ever fails for a given video (an unproven edge case with YouTube's session-bound "visitor-private" URLs), it automatically falls back to the original pipe-and-restart method — a seek can never end up worse than it was before, only better when the fast path works.

### `calculatedLength` — reporting a real-feeling duration/timeline

- In `mode=ffmpeg`, this is an *estimate*: Content-Length is guessed from duration × an assumed bitrate, and Range requests become pipeline restarts at the estimated timestamp. Approximate by nature — seeking has the same restart latency as a cold start, and the very end of playback can show a few seconds of silence if the real encode finishes early.
- In `mode=hls` (and always, in `mode=hls-buffer`), this is *exact*: the full-duration VOD playlist is declared upfront (with `#EXT-X-ENDLIST` from the very first response) even though most segments don't exist yet, so players show a complete scrub bar immediately. A seek past what's been encoded restarts just that segment, using the fast direct-URL seek above.

### Which settings apply to which mode

Because six modes each support a different subset of settings (a hardware encoder means nothing to `direct`, calculated length is meaningless outside HLS-family modes, and so on), the Streaming settings page asks the server which fields are relevant to the currently-selected mode and shows each one accordingly: fields the mode ignores are hidden entirely, fields the mode requires are shown disabled with a "Forced" badge, and everything else stays editable. This keeps the settings page from showing controls that would silently have no effect, and the same logic drives the dry-run explanation text under a mode change.

### Two background cleanup passes for HLS-family modes

- **Backfill missing segments** (`ytstream.backfillMissingSegments`): a forward seek in `hls`/`hls-buffer` permanently skips the segments in between. When on, once encoding reaches the real end, a background pass (using only a local source, so it needs `hls-buffer` or a hot-swapped/cached file) fills those gaps so the rest of the session can seek anywhere instantly.
- **Finalize .ts to .mp4** (`ytstream.finalizeToMp4`, `hls-buffer` only): browsers and some players (Jellyfin included) can't direct-play raw `.ts`. When on, once the permanent buffer file is fully finalized, a background pass remuxes it (no re-encode) into a sibling `.mp4`; playback prefers that `.mp4` automatically once it exists.

### Cache-on-play and the STRM/download hybrid

`strm.cacheOnPlay`: the first time a STRM'd video is played, Youtarr-Turbo quietly queues a real background download of it through the normal download pipeline. Once that finishes:

- An active **HLS** or **HLS + Buffered** session hot-swaps to reading from the newly-cached local file for its remaining segments (`ytstream.hotSwapToCache`) — no restart the viewer would notice, just faster/more reliable playback for the rest of that session.
- Future plays of that video use the cached file directly instead of live-proxying YouTube at all.
- If auto-removal later decides to clean it up, `autoRemovalPreserveStrmFallback` reverts it back to a bare STRM entry (deleting only the large media file) instead of removing the library entry outright — so a "watched and cleaned up" video quietly goes back to being stream-on-demand rather than disappearing.

### Other playback settings

- **`transcode`**: `off` (auto — matches the download codec setting) / `copy` (fast remux, no re-encode) / `h264` (forced re-encode, required for hardware acceleration). A `copy` request is silently upgraded to `h264` if the source turns out not to already be H.264, since a VP9/AV1-in-MP4 remux isn't broadly playable.
- **`playerClient`**: overrides yt-dlp's `--extractor-args youtube:player_client=`. Defaults to `default,-tv`, which excludes yt-dlp's own "tv" client — the most common source of YouTube's generic extraction-error page.
- **`instantStart`** (HLS-family modes + `calculatedLength` + `transcode=h264` only): serves a placeholder clip as segment 0 so playback starts within milliseconds instead of blocking for the real encode's first segment. Uses the video's own cached YouTube thumbnail with a "Loading..." overlay when available, falling back to a generic pattern otherwise, while the real encode catches up in the background.
- **`probeShortcut`**: detects a media server's metadata probe (Jellyfin's ffprobe, recognized by its bare default User-Agent) and serves a small cached clip instead of spinning up a real yt-dlp/ffmpeg session just to answer "what codec is this."
- **`forceServerSettings`**: ignores any mode/quality/etc. baked into an already-written `.strm` file's URL or passed as query params, always using the current server-side config instead — useful after changing settings, since old `.strm` files otherwise keep using whatever was configured when they were written.

---

## Hardware-accelerated transcoding

Turbo adds hardware encoding (QSV / NVENC / VAAPI / AMF, plus software) in **two independent places**:

1. **Live playback transcode** (`ytstream.hardwareMode`) — used when a STRM session's `transcode` is `h264`.
2. **Post-download transcode** (`downloadTranscodeVideoCodec` / `downloadTranscodeHardwareMode` / `downloadTranscodeAudioCodec`, in Settings → YT-DLP) — re-encodes an already-downloaded file to H.264, HEVC, or AV1, independent of whatever codec it was originally downloaded in. If the selected hardware encoder fails to initialize (missing driver, no GPU, wrong container setup), it automatically retries in software rather than failing the download.

### Hardware Capabilities Test

Both settings pages (Streaming, and YT-DLP) include a **Test Hardware Capabilities** button and results table (`POST /api/ytdlp/test-hardware-capabilities`). It runs a real ~1-second encode — no video file needed — through every hardware-mode × codec combination (5 modes × 3 codecs) using the exact ffmpeg arguments the real transcode paths would use, and reports which combinations genuinely work on this specific host, not just which ones parse without error. The table always shows every combination, marked **Untested** until you run it, so you can see what's available even before testing.

---

## Stream History

A new persisted audit trail of ytstream playback sessions (Settings → Streaming → History), separate from the existing live "Streaming" page (which only shows what's active right now and loses everything once a stream ends). Each row records: video, playback mode, quality/container/transcode/hardware settings, client IP and user-agent, start and end time, total bytes transferred, and how it ended (completed, error, client disconnected, idle timeout, etc. — with the real error text if there was one). Old rows are pruned automatically after 90 days.

---

## Download History

The Download History list (part of the Download Manager) goes well beyond a flat job log:

- **Filters**: source (Channels, Playlists, Manual Videos, a specific API key, or a specific NZB category), status, and a downloaded-date range, plus a text search across job titles and channel names.
- **Terminated-channel detail**: a job that stopped a channel partway through (e.g. it was deleted or disabled mid-run) shows which channels were terminated and any failures encountered while doing so.
- **Skip counts**: how many videos in a job were already downloaded and skipped.
- **Duration**: how long a completed job actually ran, computed from its start/end timestamps.
- **Notes**: free-text status/error notes attached to a job are shown inline (e.g. an NZB grab whose video row was later removed by Sonarr/Radarr's "untracked" import strategy still shows a usable title even without a live database row behind it).

---

## Sonarr/Radarr/Prowlarr integration (the NZB bridge)

Turbo can make Youtarr-Turbo act as **both** a Newznab-compatible search indexer and a SABnzbd-compatible download client at the same time (Settings → Sonarr/Radarr). This lets Sonarr, Radarr, or Prowlarr search YouTube through Youtarr-Turbo and "grab" a result as if it were a real Usenet release — no actual NZB/Usenet content is ever involved; the "NZB file" Youtarr-Turbo generates just encodes a YouTube video ID.

- **Search**: Sonarr/Radarr-style `tvsearch`/`movie` queries (with season/episode support) map to a real YouTube search; an empty query serves Youtarr-Turbo's own known channel videos as an RSS feed, which is what Prowlarr's indexer test and Sonarr/Radarr's periodic auto-sync expect. Newznab category IDs (e.g. 5040 TV HD, 2000 Movies general) are mapped per category (see below), matching whatever combination of ids Sonarr/Radarr send with a request.
- **Grab**: the synthetic "NZB" gets parsed and turned into a real Youtarr-Turbo download/STRM job; `queue` and `history` endpoints report that job's live and completed state back in SABnzbd's expected schema.
- **Search result caching** (`nzb.searchCacheMinutes`): reuses results for a repeat query instead of re-running yt-dlp or spending YouTube API quota when Sonarr/Radarr/Prowlarr re-run the same search on schedule. Set to `0` to disable.
- **Per-category rules** (`nzb.categories`, one entry per Sonarr/Radarr "Category"): each category configures its own subfolder, media mode (download/STRM/both), search mode (flat text vs. season/episode-aware), the Newznab category ids it responds to, and **import strategy**:
  - `hardlink` — the video stays a normal, permanent Youtarr-Turbo library entry; a hardlink is staged for Sonarr/Radarr to "import," so their move/rename never touches Youtarr-Turbo's own copy.
  - `untracked` — Youtarr-Turbo drops its own database tracking once Sonarr/Radarr explicitly confirms it removed the item from its queue/history, handing the one-and-only file off to Sonarr/Radarr's library management entirely.
  - **Transcode before reporting complete** (`postEncode`, per category): narrows the global post-download transcode setting (see below) to only apply to grabs in this category — it can't turn transcoding on by itself, only opt a category out of a transcode that's otherwise globally enabled.
- **`remoteBasePath`**: remaps Youtarr-Turbo's internal file path prefix to whatever path Sonarr/Radarr's own container sees the same shared volume mounted at.
- **`additionalLocalFilter`** (per category): an optional post-filter requiring the search terms and season/episode code to actually appear in the YouTube title, to cut down on YouTube search's tendency to return loosely-related results.
- **Exclude terms** (per category, `excludeTerms`): a list of words/phrases (one per line, or imported from a `.txt` file) that drop a result if its title contains any of them — catches DVD-extra clips, promos, and behind-the-scenes uploads that would otherwise pass the local filter. Only applies when Additional local filter is on.
- **NZB debug logging** (`nzb.debugLogging`): surfaces this integration's diagnostic logs (search/caps/addfile/queue/history requests, cache hit/miss, local-filter before/after counts, remapped paths) at the normal log level without setting the global Log Level to Debug.

NZB-sourced downloads skip writing Youtarr-Turbo's own NFO/poster/fanart/backdrop sidecar files, since Sonarr/Radarr generate their own on import.

### NZB diagnostics page

A dedicated page (separate from Settings → Sonarr/Radarr) shows live activity for this integration: summary stat cards, recent and cached search queries, a per-search "Search Filter Debug" table showing every candidate result a search returned and whether the local filter kept or rejected it (with a full per-result breakdown), failed grabs, and the current/queued NZB jobs. It only reflects traffic from Sonarr/Radarr/Prowlarr, not Youtarr-Turbo's own manual "Find Videos" search.

---

## API Keys (external single-video download access)

A new Settings page for generating per-key API tokens with usage/last-used tracking and a configurable rate limit, used to trigger a single-video download from outside the web UI via `POST /api/videos/download` with an `x-api-key` header — includes a generated browser bookmarklet and an iOS/Android Shortcuts recipe. Single-video only; not a path for subscribing to channels or playlists.

---

## Download reliability engineering

A handful of settings (Settings → YT-DLP) aimed at making downloads more resilient on flaky connections or against YouTube throttling, none of which exist upstream:

- **Stall detection** — flags a download as stalled based on a rolling throughput window and rate threshold, rather than just a fixed timeout.
- **Separate retry counts** — a manual retry count (user-triggered) and a distinct automatic retry count (Youtarr-Turbo re-queues a fresh job on its own after a transient HTTP 403).
- **Socket timeout** and **throttle-rate detection** as independent tunables.
- **Proxy support** — route yt-dlp traffic through a SOCKS/HTTP proxy URL.
- **Custom yt-dlp arguments** — a raw arguments field with a server-side dry-run validator (`POST /api/ytdlp/validate-args`) that tokenizes, denylist-checks, and test-runs arbitrary flags via `yt-dlp --help` (no network call) before trusting them.
- **yt-dlp update channel** (`stable`/`nightly`) with scheduled auto-update.

---

## Deeper media-server integration

- **Jellyfin and Emby** get full first-class connection management (URL, API key, user selection, library picking, connection testing) — upstream only lists Jellyfin/Emby playlist mirroring as a feature, not a full settings page per server.
- **Per-subfolder library mapping** for Plex and Jellyfin (not Emby) — different channel subfolders can land in different media-server libraries, independent of one global default library.

---

## Maintenance extras

- **Resolution-tag backfill** — patches an "Available: ..." resolution tag onto videos that were downloaded before this feature existed, using already-cached metadata (no fresh YouTube calls).
- The existing filesystem rescan (reconciling Youtarr-Turbo's database against what's actually on disk) is unchanged from upstream but lives alongside this new tool on the same Maintenance page.

---

## Full settings-page reference

| Settings page | What it configures | Notes |
|---|---|---|
| Core | Download frequency/count, resolution/codec, metadata output toggles, filename templates, TV-series mode | Baseline, richer template UI |
| YT-DLP | Update channel, download performance/reliability, proxy, custom args, **post-download hardware transcode** | Mostly Turbo additions |
| API Keys | External single-video download tokens | Turbo |
| Appearance | Theme selection, dark mode, motion, branding visibility | Turbo |
| Auto Removal | Age/space/watched-based removal, keep-recent, STRM fallback | Baseline concept, Turbo depth |
| Cookies | yt-dlp cookie file upload/management | Baseline |
| Maintenance & Rescan | Filesystem rescan + resolution-tag backfill | Rescan baseline, backfill Turbo |
| Notifications | Apprise multi-service webhooks | Turbo upgrade |
| Sonarr/Radarr | Newznab + SABnzbd emulation for the *arr stack, per-category rules, exclude terms | Turbo |
| Plex | Connection, library mapping, playlist token | Baseline+ |
| Jellyfin | Connection, user, libraries, subfolder mapping | Turbo depth |
| Emby | Connection, user, libraries | Turbo depth |
| Watch Status | Cross-server watched-state sync | Baseline concept, Turbo depth |
| Account Security | Password change | Baseline |
| SponsorBlock | Segment removal, categories, custom API URL | Baseline + Turbo extra |
| Streaming | STRM mode, media mode, cache-on-play, six playback modes with per-mode field enforcement, hardware capabilities test, Stream History | Turbo — entirely new |
| YouTube API | Optional YouTube Data API key | Baseline |

For install/deployment instructions, screenshots, licensing, and the full upstream feature set this fork builds on, see [README.md](README.md).
