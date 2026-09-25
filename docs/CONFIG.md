# Configuration Reference (config.json)

This document provides a comprehensive reference for all configuration options in Youtarr-Turbo's `config.json` file.
These settings can be changed from the Settings pages in the web UI.

## Table of Contents
- [Configuration File Location](#configuration-file-location)
- [Core Settings](#core-settings)
- [Plex Integration](#plex-integration)
- [Jellyfin Integration](#jellyfin-integration)
- [Emby Integration](#emby-integration)
- [Watch Status Sync](#watch-status-sync)
- [TV Series Library Mode](#tv-series-library-mode)
- [Media Mode & STRM](#media-mode--strm)
- [Streaming (ytstream)](#streaming-ytstream)
- [Sonarr/Radarr Integration (NZB)](#sonarrradarr-integration-nzb)
- [YouTube Data API](#youtube-data-api-optional)
- [SponsorBlock Settings](#sponsorblock-settings)
- [Kodi, Emby and Jellyfin Compatibility](#kodi-emby-and-jellyfin-compatibility)
- [Cookie Config](#cookie-config)
- [Notifications](#notifications)
- [Download Performance](#download-performance)
- [Post-Download Transcode](#post-download-transcode)
- [Advanced Settings](#advanced-settings)
- [Auto-Removal Settings](#auto-removal-settings)
- [API Keys & External Access](#api-keys--external-access)
- [yt-dlp Auto-Update](#yt-dlp-auto-update)
- [Filesystem Rescan](#filesystem-rescan)
- [Account & Security](#account--security)
- [System Fields](#system-fields)
- [Configuration Examples](#configuration-examples)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Configuration File Location

The configuration file is stored at `./config/config.json` relative to your Youtarr-Turbo installation directory.

### Auto-Creation
The `config.json` is automatically created on first startup if it doesn't exist, with sensible defaults from `config.example.json`.

### Editing Configuration
Configuration can be modified through:
1. **Web UI** (recommended) - Settings pages in the application
2. **Manual editing** - Stop Youtarr-Turbo, edit the JSON file, restart
3. **Environment variables** - Some values can be overridden (see [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md))

## Core Settings

### Youtube Output Directory (env-only, not a config.json field)
- **Set via**: `YOUTUBE_OUTPUT_DIR` environment variable in `.env` (see [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md))
- **Type**: `string`
- **Default**: `"./downloads"`
- **Description**: Directory path on the host where downloaded videos are stored
- **Note**: This setting is **not** stored in `config/config.json`. It is displayed read-only in the web UI and can only be changed by editing `.env` and restarting. Legacy installs that had `youtubeOutputDirectory` in `config.json` are automatically migrated to `.env` during first-run `.env` bootstrap by `scripts/_create-env.sh` (i.e. the first time the start script runs with no existing `.env`).

### Enable Automatic Downloads
- **Config Key**: `channelAutoDownload`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Automatically download most recent videos from auto-download enabled channels and tabs
- **Note**: When true, the newest videos automatically downloaded on a cron schedule

### Download Frequency
- **Config Key**: `channelDownloadFrequency`
- **Type**: `string` (cron expression)
- **Default**: `"0 * * * *"` (hourly)
- **Description**: Cron schedule for automatic channel refreshes and downloads
- **Examples**:
  - `"0 */6 * * *"` - Every 6 hours
  - `"0 2 * * *"` - Daily at 2 AM
  - `"0 0 * * 0"` - Weekly on Sunday at midnight
  - `"*/30 * * * *"` - Every 30 minutes

### Files to Download per Channel
- **Config Key**: `channelFilesToDownload`
- **Type**: `number`
- **Default**: `5`
- **Description**: Maximum number of most recent videos to download per channel per scheduled auto download
- **Range**: 1-10
- **Note**: Applies to scheduled autodownloads and manually triggered channel downloads

### Channel Videos Hot Load (Infinite Scroll)
- **Config Key**: `channelVideosHotLoad`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: When enabled, the channel videos page uses infinite scroll: as you scroll the list, the next page of videos is appended to the accumulated results instead of replacing them. When disabled, the page uses paginated navigation with a fixed page size.
- **Note**: Affects the UI only; does not change what gets downloaded.

### Preferred Resolution
- **Config Key**: preferredResolution
- **Type**: `string`
- **Default**: `"1080"`
- **Options**: `"2160"`, `"1440"`, `"1080"`, `"720"`, `"480"`, `"360"`
- **Description**: Global setting for preferred download resolution
- **Note**: Downloads from YouTube at best available quality up to this limit. Other values hand-edited into `config.json` are passed to yt-dlp as-is, but the UI only offers the options above.
- **Codec implication**: YouTube only provides H.264 in MP4 up to 1080p. Selecting 1440p or 2160p forces Youtarr-Turbo to pick a VP9 or AV1 source stream (YouTube does not offer H.264 at those resolutions) and remux it into MP4 via `--merge-output-format mp4`. The remux is lossless (no re-encode), but Plex clients without native VP9/AV1 hardware decode (Apple TV HD, older Apple TV 4K, iOS, older Rokus) will transcode at playback. If direct-play compatibility matters more than resolution, keep this at 1080p or set `videoCodec` to `h264`.

### Preferred Video Codec
- **Config Key**: `videoCodec`
- **Type**: `string`
- **Default**: `"default"`
- **Options**: `"default"`, `"h264"`, `"h265"`
- **Description**: Preferred video codec for downloads. `"default"` picks the best stream YouTube offers at the requested resolution (typically VP9 or AV1 above 1080p). `"h264"` forces H.264/AVC, which maximizes client compatibility but effectively caps resolution at 1080p because YouTube does not serve H.264 above that height. `"h265"` prefers HEVC but YouTube rarely provides it, so it almost always falls back to H.264 MP4.
- **Compatibility**:
  - `h264`: Best compatibility with all devices
  - `h265`: Better compression, requires modern devices
  - `default`: YouTube picks the stream, typically VP9 or AV1 above 1080p. Best compression, but older devices may need to transcode. (VP9 and AV1 are not selectable values for this key; they are just what YouTube serves when no codec preference is forced.)

### Default Library Mode
- **Config Key**: `defaultLibraryMode`
- **Type**: `string`
- **Default**: `"movie"`
- **Options**: `"movie"`, `"series"`
- **Description**: Global default for how downloaded videos are organized/named. `"movie"` is Youtarr-Turbo's traditional behavior. `"series"` treats each channel like a TV series: videos are assigned a `season` (the calendar year of upload) and an `episode` number (ordinal within that year) and named using the Episode Filename Template below, for Jellyfin/Plex/Emby "Shows" libraries. See [TV Series Library Mode](#tv-series-library-mode).
- **Note**: Can be overridden per-channel or per-playlist (`library_mode` column; NULL inherits this global default). See [DATABASE.md](DATABASE.md).

### Default Subfolder
- **Config Key**: `defaultSubfolder`
- **Type**: `string`
- **Default**: `""` (empty - downloads to root directory)
- **Description**: Default download location for untracked channels and channels set to use "Default Subfolder"
- **Note**: Subfolders are prefixed with `__` on the filesystem (e.g., setting `Sports` creates `__Sports/`)
- **Channel Subfolder Semantics**:
  - **"Default Subfolder"** (NULL in database): Channel uses this global default setting
  - **"No Subfolder"** (special value): Channel explicitly downloads to root directory, ignoring the global default
  - **Specific subfolder**: Channel downloads to that specific subfolder
- **Use Cases**:
  - Organize untracked manual downloads into a specific folder
  - Set a default location while allowing individual channels to override
  - Explicitly place specific channels in the root directory using "No Subfolder"

### Flat File Structure Default
- **Config Key**: `defaultSkipVideoFolder`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: When `true`, new downloads are saved directly in the channel folder (flat structure) instead of an individual per-video subfolder, for every channel that has not chosen its own File Structure setting.
- **Channel Override Semantics** (channel setting `skip_video_folder`, edited via the channel's "Video File Structure" select):
  - **"Use global setting"** (NULL in database): channel follows this global default
  - **"Flat (no video subfolders)"** (`true`): channel always uses flat structure
  - **"Video subfolders"** (`false`): channel always uses per-video subfolders, even when the global default is flat
- **Note**: Only affects new downloads; existing files are not moved. The manual download dialog can override the structure for a single download ("Force flat" or "Force individual video subfolders"); its default option ("Use channel/global settings") follows the channel setting and this global default.

### Video Filename Template
- **Config Key**: `videoFilenamePrefix`
- **Type**: `string`
- **Default**: `"%(uploader,channel,uploader_id).80B - %(title).64B"`. The title is capped at 64 bytes because the prefix appears twice in the full path (per-video folder + filename) and Plex on Windows silently skips files whose full path reaches 260 characters. Installs that saved settings under an older default keep their persisted value (`.74B`/`.76B`) until the setting is edited.
- **Description**: User-customizable prefix for downloaded video filenames AND per-video directory names. Youtarr-Turbo always appends ` [VIDEO_ID].EXT` to filenames and ` - VIDEO_ID` to per-video folder names so it can re-find your videos on disk; those suffixes are not configurable.
- **Syntax**: Uses [yt-dlp's output template syntax](https://github.com/yt-dlp/yt-dlp#output-template). Common tokens: `%(title)s`, `%(uploader)s`, `%(channel)s`, `%(upload_date>%Y-%m-%d)s`, `%(channel_id)s`, `%(display_id)s`. Use `.NB` to byte-truncate values (e.g. `%(title).64B`) or `.Ns` for character truncation (e.g. `%(title).40s`); recommended to keep paths under Windows' 260-char limit.
- **Validation**: Empty values, path separators (`/`, `\`), `..`, ASCII control characters, values longer than 160 characters, malformed yt-dlp percent syntax, and invalid truncation like `%(title).40` are rejected. Escape literal percent signs as `%%`. Trailing whitespace is trimmed on save.
- **Scope**: Global setting. Applies only to NEW downloads; existing files are not renamed.
- **Examples** (all paired with the locked suffixes):
  - **Default**: `Preston - ESCAPING 99 Nights in the Forest IN REAL LIFE! [Cbq15X05wyY].mp4`
  - **Date prefix** (`%(upload_date>%Y-%m-%d)s - %(title).64B`): `2025-10-17 - ESCAPING 99 Nights ... [Cbq15X05wyY].mp4`
  - **Plex YouTube-Agent** (`%(upload_date>%Y_%m_%d)s %(title).64B`): `2025_10_17 ESCAPING 99 Nights ... [Cbq15X05wyY].mp4` (compatible with [Absolute-Series-Scanner](https://github.com/ZeroQI/Absolute-Series-Scanner) and [YouTube-Agent.bundle](https://github.com/ZeroQI/YouTube-Agent.bundle))
  - **Title only** (`%(title).64B`): `ESCAPING 99 Nights ... [Cbq15X05wyY].mp4`
- **UI**: A live preview in **Settings -> Core Settings -> File Structure Settings** shows the rendered folder and file names against a sample video, with length warnings (yellow > 110 chars, red > 130 chars on the rendered name).

## TV Series Library Mode

When a channel/playlist is in `series` library mode (see `defaultLibraryMode` above), downloaded videos are numbered and named as TV episodes instead of Youtarr-Turbo's default movie-style naming.

### Episode Filename Template
- **Config Key**: `episodeFilenamePrefix`
- **Type**: `string`
- **Default**: `"S%(season)02dE%(episode)03d - %(title).64s"`
- **Description**: Filename template for series-mode videos, applied instead of `videoFilenamePrefix`. Supports `%(title)s`, `%(season)d` / `%(season)0Nd`, `%(episode)0Nd`, `%(channel)s`. A locked `" [id].ext"` suffix is always appended.
- **Note**: Uses Youtarr-Turbo's own placeholder syntax, not yt-dlp's — the episode number is only known after checking the database (see `season`/`episode` columns on `Videos` in [DATABASE.md](DATABASE.md)), not at yt-dlp invocation time.

### TV Series Output Subfolder
- **Config Key**: `seriesOutputSubfolder`
- **Type**: `string`
- **Default**: `""` (empty — series-mode channels land in the same location as movie mode)
- **Description**: Default subfolder for series-mode channels/playlists that have no subfolder of their own already set. Point a separate media-server "Shows" library at this subfolder to keep TV Series content separate from Movies.
- **Note**: Only applies to channels/playlists using TV Series library mode. Only affects new downloads.

### Per-Channel Season/Episode Regex
Not a global `config.json` field — set per-channel via the channel's `season_episode_regex` column (see [DATABASE.md](DATABASE.md)). Optional regex with `(?P<season>)`/`(?P<episode>)` named groups to decode season/episode from a video title, instead of the default (upload year as season, chronological order within the year as episode).

### Enable Subtitles
- **Config Key**: `subtitlesEnabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Download subtitles/closed captions with videos

### Subtitle Languages
- **Config Key**: `subtitleLanguage`
- **Type**: `string`
- **Default**: `"en"`
- **Description**: Preferred subtitle language(s) when downloading subtitle files for videos (ISO 639-1 code)
- **Examples**: `"en"` (English), `"es"` (Spanish), `"fr"` (French)
- **Note**: Only displayed when subtitles are enabled

### Dark Mode
- **Config Key**: `darkModeEnabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable dark mode in web UI

## Plex Integration

### Plex API Key
- **Config Key**: `plexApiKey`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: Plex authentication token (X-Plex-Token)
- **Note**: Can be obtained through Plex OAuth in the web UI or manually entered

### Plex YouTube Library ID
- **Config Key**: `plexYoutubeLibraryId`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: Default Plex library section ID for YouTube videos. Used for all downloads that do not match a per-subfolder mapping (see below).
- **Note**: Library refresh is automatically triggered if configured when new videos are downloaded

### Plex Subfolder Library Mappings
- **Config Key**: `plexSubfolderLibraryMappings`
- **Type**: `Array<{ subfolder: string | null, libraryId: string }>`
- **Default**: `[]` (empty — all downloads use the default library above)
- **Description**: Maps channel subfolders to specific Plex library IDs, enabling different subfolders to refresh different Plex libraries after a download.
- **Usage**: Configured via the web UI under **Plex Media Server Integration → Per-Subfolder Library Mappings** once connected to Plex.
- **Format**: Each entry specifies a `subfolder` (the clean name without the `__` filesystem prefix, or `null` for the root/no-subfolder case) and the target `libraryId`.
- **Example**:
  ```json
  "plexSubfolderLibraryMappings": [
    { "subfolder": "kids", "libraryId": "2" },
    { "subfolder": "music", "libraryId": "3" },
    { "subfolder": null, "libraryId": "1" }
  ]
  ```
- **Fallback**: Any subfolder not listed here will fall back to `plexYoutubeLibraryId`.

### Plex IP
- **Config Key**: `plexIP`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: Plex server IP address or hostname
- **Examples**: `"192.168.1.100"`, `"host.docker.internal"`

### Plex Port
- **Config Key**: `plexPort`
- **Type**: `string`
- **Default**: `"32400"`
- **Description**: Plex server port number

### Use HTTPS for Plex
- **Config Key**: `plexViaHttps`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Use HTTPS for Plex connections
- **Note**: Enable for remote Plex servers or when SSL is configured

### Plex URL Override
- **Config Key**: `plexUrl`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: Optional full Plex base URL (e.g., `https://plex.example.com:32400`)
- **Usage**: Not configurable via the web UI. Edit `config/config.json` manually or set the `PLEX_URL` environment variable to populate it.
- **Note**: When this field is set it takes precedence over the `plexIP`, `plexPort`, and `plexViaHttps` values shown in the UI.

### Plex Playlist Token (advanced)
- **Config Key**: `plexPlaylistToken`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: Optional override for the token used on playlist-scoped Plex API calls.
- **Values**:
  - `""` / unset: fall back to `plexApiKey`. This is the standard claimed-server case; playlists are visible to the authenticated user.
  - `"UNCLAIMED_SERVER"`: send playlist requests with no `X-Plex-Token` header. Use this for unclaimed-server LAN setups where Plex Web also accepts unauthenticated calls. Watch status sync also reads the anonymous session's watch state in this mode.
  - Any other string: use that exact token (route Youtarr-managed playlists through a specific Plex user account other than the admin).
- **Usage**: Surface in the UI as an "Advanced" toggle inside the Plex Settings section. Most users do not need to set this.

## Jellyfin Integration

These fields are required only when you want Youtarr-Turbo to mirror playlists to Jellyfin as native playlists. Channel downloads work without them.

### Enable Jellyfin
- **Config Key**: `jellyfinEnabled`
- **Type**: `boolean`
- **Default**: `false`

### Jellyfin URL
- **Config Key**: `jellyfinUrl`
- **Type**: `string`
- **Default**: `""`
- **Description**: Base URL of your Jellyfin server (e.g., `http://192.168.1.100:8096`).

### Jellyfin API Key
- **Config Key**: `jellyfinApiKey`
- **Type**: `string`
- **Default**: `""`
- **Description**: Created in Jellyfin under **Dashboard -> API Keys**. Redacted in logs.

### Jellyfin User ID
- **Config Key**: `jellyfinUserId`
- **Type**: `string`
- **Default**: `""`
- **Description**: User account that will own Youtarr-managed playlists. In the UI, open the **Jellyfin User** dropdown to load accounts from your server and pick one, or use **Enter ID manually** to paste the ID.

### Jellyfin Video Library IDs
- **Config Key**: `jellyfinVideoLibraryIds`
- **Type**: `array<string>`
- **Default**: `[]`
- **Description**: Library IDs that contain your Youtarr-Turbo videos. Optional and safe to leave blank; Youtarr-Turbo matches downloaded videos to Jellyfin items across all of your libraries.

### Jellyfin Subfolder Library Mappings
- **Config Key**: `jellyfinSubfolderLibraryMappings`
- **Type**: `Array<{ subfolder: string | null, libraryId: string }>`
- **Default**: `[]`
- **Description**: Per-subfolder Jellyfin library targeting, same shape and fallback behavior as `plexSubfolderLibraryMappings` above.

## Emby Integration

These fields work like the Jellyfin fields above, with `emby*` names. They're required only when you want Youtarr-Turbo to mirror playlists to Emby as native playlists; channel downloads work without them. See [Media Server Playlists](MEDIA_SERVER_PLAYLISTS.md) for setup details.

| Config Key | Type | Default | Description |
| :--------- | :--- | :------ | :---------- |
| `embyEnabled` | `boolean` | `false` | Turn Emby playlist sync on or off. |
| `embyUrl` | `string` | `""` | Base URL of your Emby server (e.g., `http://192.168.1.100:8096`). |
| `embyApiKey` | `string` | `""` | Created in Emby under **Settings -> Advanced -> API Keys**. Redacted in logs. |
| `embyUserId` | `string` | `""` | User account that will own Youtarr-managed playlists. Open the **Emby User** dropdown in the UI to load accounts from your server and pick one. |
| `embyVideoLibraryIds` | `array<string>` | `[]` | Library IDs that contain your Youtarr-Turbo videos. Optional and safe to leave blank; Youtarr-Turbo matches videos across all of your libraries. |

## Watch Status Sync

| Config Key | Type | Default | Description |
| :--------- | :--- | :------ | :---------- |
| `watchStatusSyncEnabled` | `boolean` | `true` | Periodically pull per-video watch status (watched, percent, last watched) from connected media servers (Plex, Jellyfin, Emby) into Youtarr-Turbo. No-op when no media server is connected. |
| `watchStatusSyncFrequency` | `string` (cron) | `"0 */4 * * *"` | How often the watch status sync runs. |
| `plexWatchStatusAllUsers` | `boolean` | `true` | Also sync watch status for every Plex account on the server (from the server's play history; the owner keeps full fidelity). When `false`, only the server owner's state is synced. |
| `jellyfinWatchStatusAllUsers` | `boolean` | `true` | Sync watch status for every Jellyfin user. When `false`, only the configured `jellyfinUserId`. |
| `embyWatchStatusAllUsers` | `boolean` | `true` | Sync watch status for every Emby user. When `false`, only the configured `embyUserId`. |
| `watchStatusWatchedRule` | `string` | `"any"` | When a video counts as "Watched" in listings: `"any"` (any synced user watched it) or `"primary"` (only the Plex owner / configured Jellyfin/Emby user). |

Sync is one-way (server -> Youtarr-Turbo). Non-owner Plex users come from the server's play history, which records plays but not in-progress positions: any play marks the video watched for that user. User names are stored in the `media_server_users` table so the video modal can show who watched what. The history pull is incremental via a durable cursor in the `watch_status_sync_cursors` table; deleting that table's `plex` row forces a full history re-scan on the next sync (useful after repairing a path mismatch that had prevented videos from matching).

## Media Mode & STRM

### Media Mode
- **Config Key**: `mediaMode`
- **Type**: `string`
- **Default**: `"download"`
- **Options**: `"download"`, `"strm"`, `"both"`
- **Description**: `"download"` is Youtarr-Turbo's traditional full-file download behavior. `"strm"` writes a `.strm` shortcut (plus NFO/thumbnail) instead of downloading the video, for on-demand playback via Jellyfin/Emby/Kodi. `"both"` downloads the media file **and** writes a `.strm` pointing at the proxy/YouTube.
- **Note**: Can be overridden per-channel or per-playlist (`media_mode` column; NULL inherits this global default). See [STRM.md](STRM.md) and [DATABASE.md](DATABASE.md).

### STRM Settings
- **Config Key**: `strm` (object)
- **Default**:
```json
"strm": {
  "target": "ytstream",
  "proxyBaseUrl": "",
  "writeNfo": true,
  "writeThumbnail": true,
  "writeMediaInfoCache": true,
  "cacheOnPlay": false,
  "cacheOnPlayExpiryHours": null,
  "quality": null
}
```

| Field | Values | Notes |
|---|---|---|
| `target` | `"youtube"` \| `"ytstream"` | `youtube`: `.strm` points straight at the YouTube watch URL. `ytstream` (default): `.strm` points at Youtarr-Turbo's own `/api/ytstream/:id` route — see [YTSTREAM.md](YTSTREAM.md). |
| `proxyBaseUrl` | `string` | Base URL for `target: "ytstream"` `.strm` files. Must be reachable by the media server/clients, not `127.0.0.1` unless they run on the same host. |
| `writeNfo` / `writeThumbnail` | `boolean` | Write NFO metadata / thumbnail image alongside the `.strm`. |
| `writeMediaInfoCache` | `boolean` | Cache probed media info (resolution/duration/container) in a `.strmtool.json` sidecar next to each `.strm`, so the StrmToolTurbo Jellyfin plugin doesn't need to probe the stream on every scan. The declared container follows the Playback mode, so after changing `ytstream.defaultMode`/`container` run Settings → Maintenance & Rescan → **Regenerate video metadata** to rewrite existing sidecars (it writes none while this is off); see [Switching modes on an existing library](GETTING_STARTED_STREAMING.md#switching-modes-on-an-existing-library). |
| `cacheOnPlay` | `boolean` | When true, the first play of a `.strm` item triggers a background full download that then serves locally; see `cacheOnPlayExpiryHours`. |
| `cacheOnPlayExpiryHours` | `number \| null` | Hours after a cache-on-play download finishes before the nightly sweep (2:10 AM) reverts the video back to STRM, freeing disk space. `null`/`0` = never auto-revert. Only ever applies to a video cache-on-play itself materialized, never a genuine/forced download. |
| `quality` | `string \| null` | Overrides the resolution baked into `ytstream`-target `.strm` URLs. `null` falls back to `preferredResolution`. |

## Streaming (ytstream)

- **Config Key**: `ytstream` (object)
- **Description**: Server-side playback/transcode settings for the `/api/ytstream/:youtubeId` route used by `strm.target: "ytstream"` `.strm` files (and any direct caller). Covers stream mode (`defaultMode`: `direct`/`direct-redirect`/`hls`/`hls-buffer`/`hls-byterange`/`download-cache`/`youtube-hls`), container/quality/transcode selection, hardware encode/decode backends, network tuning (chunk size, concurrent fragments, throttle/socket timeouts), HLS segment storage and caching behavior (`hotSwapToCache`, `serveCachedFile`, `hlsStorageLocation`, `backfillMissingSegments`, `finalizeToMp4`, `stealthCache`, `bufferStartAfterSegments`), the byte-range mode options (`byteRangeDeliverAsFile`, `byteRangeResumeCache`), the YouTube HLS passthrough options (`audioLanguage`, `youtubeHlsProxy`), and history retention (`historyRetentionDays`, default 90 — see the `stream_history` table in [DATABASE.md](DATABASE.md)).
- **Full field reference**: [YTSTREAM.md § Config (config.json)](YTSTREAM.md#config-configjson).
- **Step-by-step setup**: [GETTING_STARTED_STREAMING.md § Pick a playback mode](GETTING_STARTED_STREAMING.md#step-3--pick-a-playback-mode).
- **Note**: `calculatedLength` was renamed from `fakeLength`; old configs are migrated automatically at startup.

### Recommended playback mode configs

Three modes cover most setups. Each example sets `forceServerSettings: true`, so an already-written `.strm` picks up the mode without being rewritten. Only the fields shown differ from the defaults; the rest of the block can stay as is. If you change modes on an existing STRM library, regenerate the `.strmtool.json` sidecars and re-run the Jellyfin StrmToolTurbo extraction afterwards (see [Switching modes on an existing library](GETTING_STARTED_STREAMING.md#switching-modes-on-an-existing-library)).

**YouTube HLS passthrough** — serves YouTube's own HLS playlist; no ffmpeg, no local file, 1080p H.264 maximum. The player must reach YouTube from the server's network.

```json
"ytstream": {
  "defaultMode": "youtube-hls",
  "quality": "1080",
  "qualityStrictness": "fallback",
  "audioLanguage": "en",
  "youtubeHlsProxy": "serve",
  "forceServerSettings": true
}
```

**Byte-range Plain file** — one growing file (Matroska here) served over HTTP Range and kept in a hidden cache. In the Settings UI this is the **Byte-range Plain file** entry, which sets `defaultMode` and `byteRangeDeliverAsFile` together.

```json
"ytstream": {
  "defaultMode": "hls-byterange",
  "byteRangeDeliverAsFile": true,
  "byteRangeResumeCache": false,
  "container": "mkv",
  "transcode": "copy",
  "quality": "1080",
  "hlsStorageLocation": "cache",
  "forceServerSettings": true
}
```

**Enhanced HLS + Buffered** — real segmented HLS with an H.264 re-encode on the GPU, plus a whole-video buffer file.

```json
"ytstream": {
  "defaultMode": "hls-buffer",
  "container": "mp4",
  "transcode": "h264",
  "quality": "1080",
  "hardwareMode": "vaapi",
  "tuning": "quality",
  "forceServerSettings": true
}
```

### Streaming mode-specific fields

| Field | Type | Default | Applies to | Notes |
|---|---|---|---|---|
| `audioLanguage` | `string` | `""` | `youtube-hls` | Preferred audio track language (`en`, `de`, `pt-BR`). A region-less code matches its regions. Blank, or a language the video doesn't offer, serves the original track. |
| `youtubeHlsProxy` | `"off"` \| `"proxy"` \| `"serve"` | `"off"` | `youtube-hls` | `off`: only the master playlist comes from Youtarr-Turbo. `proxy`: Youtarr-Turbo also serves the media playlists, so plays show on the Streaming page. `serve`: every segment URL also goes through Youtarr-Turbo as a `302` to YouTube (estimated data rate shown with `~`). |
| `byteRangeDeliverAsFile` | `boolean` | `false` | `hls-byterange` | `true`: serve the growing file directly over HTTP Range (**Byte-range Plain file**). `false`: return an HLS manifest of byte ranges (Jellyfin treats it as live, so not recommended for STRM). |
| `byteRangeResumeCache` | `boolean` | `false` | `hls-byterange` + `byteRangeDeliverAsFile` | Resume a cut-off encode from near where it stopped and splice the new tail onto the cached partial instead of re-encoding from 0:00. |
| `bufferStartAfterSegments` | `number` | `3` | `hls-buffer` | `config.json` only. Delay the full-video buffer fetch until this many distinct segments have been requested, so metadata probes don't start a download. `0` = start immediately. |

`container`, `transcode`, `hardwareMode`, `tuning`, `calculatedLength`, `probeShortcut`, and `hlsMasterPlaylist` are ignored by `youtube-hls`, and `calculatedLength`, `probeShortcut`, and `hlsMasterPlaylist` are ignored by the byte-range modes. With `hls-byterange`, `container` chooses `mp4` or `mkv` only when `byteRangeDeliverAsFile` is on. The Settings page shows every ignored field disabled with the reason.

## Sonarr/Radarr Integration (NZB)

- **Config Key**: `nzb` (object)
- **Description**: Makes Youtarr-Turbo act as a Newznab-compatible search indexer and SABnzbd-compatible download client so Sonarr/Radarr/Prowlarr can search and "grab" YouTube videos through Youtarr-Turbo. See [NZB.md](NZB.md) for setup and integration details, and the `nzb_diagnostic_log` / `nzb_resolution_cache` tables in [DATABASE.md](DATABASE.md).
- **Top-level fields**:
  - `enabled` (`boolean`, default `false`) — turns the `/nzb` routes on.
  - `apiKey` (`string`) — shared key for both the Newznab indexer and SABnzbd download-client endpoints; stored/displayed in plaintext (a service-integration token, not a login credential).
  - `remoteBasePath` (`string | null`, default `null`) — when Sonarr/Radarr see the shared media volume at a different path than Youtarr-Turbo does internally, every path Youtarr-Turbo reports back has its real data-root prefix swapped for this value. `null` = report paths unchanged.
  - `searchCacheMinutes` (`number`, default `10`) — how long a raw search result set is reused before a repeat query re-fetches; avoids a redundant yt-dlp run/API call for Sonarr/Radarr's own repeat polling. `0` disables caching.
  - `debugLogging` (`boolean`, default `false`) — this route's own diagnostic lines print regardless of the global Log Level, without turning on every other module's debug output.
  - `resolutionDetection` (`{ fixed, thumb, extract }`, `fixed` and `thumb` default `true`, `extract` defaults `false`) — which methods are tried, in order, to determine a search result's real resolution: `fixed` (a previously-downloaded video's own recorded resolution, free/exact), `thumb` (maxresdefault-thumbnail heuristic, cheap but can false-positive "hd"), `extract` (a real yt-dlp extraction, authoritative but slower — only used to confirm/correct an uncertain `thumb` result unless both other methods are off).
  - `diagnosticLogLimits` (`{ recentQueries, searchTraces, failedGrabs }`, default `{ 50, 20, 20 }`, each `1`-`100`) — how many rows the NZB diagnostics page's Recent Queries, Search Detail/Debug, and Failed Grabs logs keep before pruning the oldest row on the next write (see `nzb_diagnostic_log` in [DATABASE.md](DATABASE.md)). Read live, no restart needed.
  - `videoResolutionCacheLimit` (`number`, default `5000`, range `100`-`10000`) — how many rows the `nzb_resolution_cache` table (nzbThumbnailProbe.js's per-video thumb/extract resolution findings, see [DATABASE.md](DATABASE.md)) keeps before pruning the oldest by `createdAt` on the next write. Read live, no restart needed.
  - `categories` (`array`) — one entry per Sonarr/Radarr "Category": `name`, `subfolder`, `mediaMode` (`download`/`strm`/`both`), `searchMode` (`flat`/`episode`), `importStrategy` (`hardlink`: video stays in Youtarr-Turbo's own library, a hardlink is staged for Sonarr/Radarr to import; `untracked`: Youtarr-Turbo drops its own DB tracking immediately so the video never appears in Youtarr-Turbo's own list/history), `newznabCategoryIds` (array of Newznab category id strings a search can match under), `additionalLocalFilter` + `excludeTerms` (require search terms actually present in the title / reject junk substrings like "advert"), `postEncode` (per-category gate on the global post-download transcode — see [Post-Download Transcode](#post-download-transcode)).

## YouTube Data API (Optional)

### YouTube API Key
- **Config Key**: `youtubeApiKey`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: Optional YouTube Data API v3 key. When set, Youtarr-Turbo uses the API for faster channel metadata, video metadata, and search fetches. On any failure (invalid key, quota exhausted, API disabled, network error), Youtarr-Turbo silently falls back to yt-dlp with no user-visible error.
- **Notes**:
  - API keys do not expire. The Settings -> YouTube API page shows a "last validated" timestamp instead of an expiration.
  - Default quota is 10,000 units per day per Google Cloud project, resetting at midnight Pacific time. Search calls cost 100 units; metadata and channel/playlist calls cost 1 unit per call.
  - On a 403 `quotaExceeded` response, Youtarr-Turbo enters an in-memory cooldown until the next Pacific-midnight reset and uses yt-dlp exclusively during that window.
  - When a key is configured, channel video listing and tab auto-detection use the API for all three tabs (Videos, Shorts, Streams) via the per-tab auto-generated playlist IDs (`UULF`/`UUSH`/`UULV`). yt-dlp remains the fallback.
  - Search results filter out live/upcoming broadcasts and Shorts under 60s to match yt-dlp's behavior. The Shorts filter requires a follow-up `videos.list` enrichment call to read each result's duration; if that enrichment fails (e.g., quota burned mid-search), the search returns the un-enriched results and a small number of Shorts may slip through. Live/upcoming filtering still applies in that fallback path.
  - Set up instructions and a test button are on the Settings -> YouTube API page.

## SponsorBlock Settings

### Enable SponsorBlock
- **Config Key**: `sponsorblockEnabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable SponsorBlock to skip/remove sponsored segments

### SponsorBlock Action
- **Config Key**: `sponsorblockAction`
- **Type**: `string`
- **Default**: `"remove"`
- **Options**: `"remove"`, `"mark"`
- **Description**: How to handle sponsored segments
  - `remove`: Cut segments from video file
  - `mark`: Add chapters to mark segments

### SponsorBlock Categories
- **Config Key**: `sponsorblockCategories`
- **Type**: `object`
- **Default**:
```json
{
  "sponsor": true,
  "intro": false,
  "outro": false,
  "selfpromo": true,
  "preview": false,
  "filler": false,
  "interaction": false,
  "music_offtopic": false
}
```
- **Description**: Which segment types to skip/remove

### SponsorBlock API URL
- **Config Key**: `sponsorblockApiUrl`
- **Type**: `string`
- **Default**: `""` (uses default SponsorBlock API)
- **Description**: Custom SponsorBlock API server URL (optional)
- **Example**: `"https://sponsor.ajay.app"`

## Kodi, Emby and Jellyfin Compatibility

### Write Channel Posters
- **Config Key**: `writeChannelPosters`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Generate channel poster images for media servers
- **Note**: Creates poster.jpg in each channel directory

### Write Video NFO Files
- **Config Key**: `writeVideoNfoFiles`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Generate NFO metadata files for Kodi/Jellyfin/Emby
- **Note**: Creates .nfo XML files with video metadata

### Write Video Fanart
- **Config Key**: `writeVideoFanart`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Create fanart image files for video backgrounds in media servers
- **Note**: Creates a `-fanart.jpg` file alongside each video with the video thumbnail. Some Plex clients (notably NVIDIA Shield) use this as the background preview image instead of or alongside the poster. When enabled with `writeChannelPosters`, videos will display correctly on all Plex clients with both a poster (from channel thumbnail) and background (from video thumbnail).

### Write Backdrop Images
- **Config Key**: `writeBackdropImages`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Generate backdrop image files for Emby and Jellyfin background art
- **Note**: Creates `backdrop.jpg` in each channel directory (from the channel's YouTube banner) and a `-backdrop.jpg` file alongside each video (copy of the video thumbnail). When enabled, channel-level backdrops are backfilled for existing channel folders; video-level backdrops are created for new downloads only.

## Cookie Config

### Enable Cookies
- **Config Key**: `cookiesEnabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Use cookies for YouTube authentication
- **Note**: May be required in some cases to get around YouTube bot detection

### Custom Cookies Uploaded
- **Config Key**: `customCookiesUploaded`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Indicates if custom cookies.txt file has been uploaded
- **Note**: Managed automatically by the application

## Notifications

Youtarr-Turbo uses [Apprise](https://github.com/caronc/apprise) to send notifications when new videos are downloaded, supporting 100+ notification services.

### Enable Notifications
- **Config Key**: `notificationsEnabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable notifications when new videos are downloaded

### Apprise URLs
- **Config Key**: `appriseUrls`
- **Type**: `array` of objects
- **Default**: `[]` (empty array)
- **Description**: List of notification service configurations

Each entry in the array is an object with the following properties:

| Property | Type | Description |
|----------|------|-------------|
| `url` | `string` | Apprise-compatible notification URL |
| `name` | `string` | Friendly name for this notification (e.g., "Discord - Gaming Server") |
| `richFormatting` | `boolean` | Enable rich formatting (embeds, styled text) when supported |

**Example Configuration:**
```json
{
  "appriseUrls": [
    {
      "url": "discord://webhook_id/webhook_token",
      "name": "Discord Server",
      "richFormatting": true
    },
    {
      "url": "tgram://bot_token/chat_id",
      "name": "Telegram Group",
      "richFormatting": true
    },
    {
      "url": "ntfy://my-topic",
      "name": "Ntfy Mobile",
      "richFormatting": false
    }
  ]
}
```

### Rich Formatting

For supported services, Youtarr-Turbo sends beautifully formatted notifications with embeds, styled text, video cards, and timestamps. Services without rich formatting support receive plain text notifications.

| Service | URL Format | Rich Formatting |
|---------|------------|-----------------|
| Discord | `discord://webhook_id/webhook_token` | ✅ Embeds with colors, thumbnails |
| Telegram | `tgram://bot_token/chat_id` | ✅ HTML formatting |
| Slack | `slack://token_a/token_b/token_c` | ✅ Block Kit formatting |
| Email | `mailto://user:pass@gmail.com` | ✅ HTML email with styling |
| Pushover | `pover://user_key@app_token` | ❌ Plain text |
| Ntfy | `ntfy://topic` | ❌ Plain text |
| Other services | Various | ❌ Plain text |

Toggle "Rich formatting" off on any webhook to send plain text instead.

### Supported Services

Apprise supports 100+ notification services. See the [Apprise Notification Services Wiki](https://github.com/caronc/apprise/wiki#notification-services) for a complete list and URL formats.

Common services include:
- **Discord**: `discord://webhook_id/webhook_token`
- **Telegram**: `tgram://bot_token/chat_id`
- **Slack**: `slack://token_a/token_b/token_c`
- **Pushover**: `pover://user_key@app_token`
- **Ntfy**: `ntfy://topic` or `ntfys://your-server/topic`
- **Email**: `mailto://user:pass@gmail.com`
- **Matrix**: `matrix://user:pass@hostname/#room`
- **Gotify**: `gotify://hostname/token`

### Migration from Discord Webhook

If you previously used the `discordWebhookUrl` configuration option, Youtarr-Turbo automatically migrates it to the new `appriseUrls` format on startup:

**Before (legacy):**
```json
{
  "discordWebhookUrl": "https://discord.com/api/webhooks/123/abc",
  "notificationService": "discord"
}
```

**After (automatic migration):**
```json
{
  "appriseUrls": [
    {
      "url": "https://discord.com/api/webhooks/123/abc",
      "name": "Discord Webhook",
      "richFormatting": true
    }
  ]
}
```

The old `discordWebhookUrl` and `notificationService` fields are automatically removed after migration. No manual action is required.

## Download Performance

### Download Socket Timeout
- **Config Key**: `downloadSocketTimeoutSeconds`
- **Type**: `number`
- **Default**: `30`
- **Description**: Network timeout for download connections (seconds)
- **Options**: `5`, `10`, `20`, `30` (the values offered in the UI)
- **Note**: Corresponds to yt-dlp `--socket-timeout` setting. Time to wait before giving up, in seconds.

### Download Throttled Rate
- **Config Key**: `downloadThrottledRate`
- **Type**: `string`
- **Default**: `"100K"`
- **Description**: Bandwidth limit for downloads
- **Examples**: `"500K"`, `"1M"`, `"10M"`, `""` (unlimited)
- **Note**: Corresponds to yt-dlp `--throttled-rate` setting. Minimum download rate in bytes per second below which throttling is assumed and the video data is re-extracted.

### Download Retry Count
- **Config Key**: `downloadRetryCount`
- **Type**: `number`
- **Default**: `2`
- **Description**: Number of retry attempts for failed downloads
- **Options**: `0`, `1`, `2`, `3` (the values offered in the UI)
- **Note**: Used for yt-dlp `--fragment-retries` and `--retries` settings.

### Auto-Retry Failed Videos
- **Config Key**: `downloadAutoRetryCount`
- **Type**: `number`
- **Default**: `1`
- **Description**: Number of times a video that fails with a transient HTTP 403 is automatically re-queued in a fresh download job
- **Options**: `0`, `1`, `2`, `3` (the values offered in the UI; `0` disables auto-retry)
- **Note**: YouTube sometimes rejects an already-issued stream URL mid-download with HTTP 403. yt-dlp's own retries (`downloadRetryCount`) re-request the same rejected URL and cannot recover; only a fresh yt-dlp run with a fresh extraction can. When a video fails with the 403 signature, Youtarr-Turbo queues an "Auto-retry" job for just that video. Permanent failures (members-only, terminated channels, bot detection) are never auto-retried.

### Enable Stall Detection
- **Config Key**: `enableStallDetection`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Detect and abort stalled downloads
- **Note**: Setting to control whether stall detection window and rate threshold are used.

### Stall Detection Window
- **Config Key**: `stallDetectionWindowSeconds`
- **Type**: `number`
- **Default**: `30`
- **Description**: Time window for stall detection (seconds)

### Stall Detection Rate Threshold
- **Config Key**: `stallDetectionRateThreshold`
- **Type**: `string`
- **Default**: `"100K"`
- **Description**: Minimum download rate before considering stalled

### Sleep Between Requests
- **Config Key**: `sleepRequests`
- **Type**: `number`
- **Default**: `1`
- **Description**: Delay between YouTube API requests (seconds)
- **Note**: Corresponds to yt-dlp `--sleep-requests` setting.

### Queue Manager UI
- **Config Key**: `downloadQueueManagerEnabled`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: Replaces the simple queued-jobs chip list on the Download Activity page with a reorderable/deletable table plus a queue-pause button.
- **Note**: Purely a client presentation choice; does not change download behavior.

## Post-Download Transcode

Optional ffmpeg re-encode of the already-downloaded file, run once after yt-dlp finishes (and after SponsorBlock cutting, before NFO/AtomicParsley/file moves). Distinct from `videoCodec`/`preferredResolution`, which only influence *which* format yt-dlp selects at download time — this converts the resulting file to a codec YouTube may not have served directly (e.g. HEVC, or a smaller AV1 file), using the same hardware-encoder backends as STRM/ytstream playback transcoding when available, with automatic fallback to software encoding on failure.

### Transcode Video Codec
- **Config Key**: `downloadTranscodeVideoCodec`
- **Type**: `string`
- **Default**: `"off"`
- **Options**: `"off"`, `"h264"`, `"hevc"`, `"av1"`
- **Description**: Target video codec for the post-download transcode. `"off"` (default) leaves yt-dlp's own output untouched.

### Transcode Hardware Mode
- **Config Key**: `downloadTranscodeHardwareMode`
- **Type**: `string`
- **Default**: `"none"`
- **Options**: `"none"`, `"qsv"`, `"nvenc"`, `"vaapi"`, `"amf"`
- **Description**: Hardware encoder backend to try first for the post-download transcode; falls back to the matching software encoder (`libx264`/`libx265`/`libsvtav1`) on failure.

### Transcode Audio Codec
- **Config Key**: `downloadTranscodeAudioCodec`
- **Type**: `string`
- **Default**: `"copy"`
- **Options**: `"copy"`, `"aac"`, `"opus"`
- **Description**: Audio handling for the post-download transcode. `"copy"` leaves the existing audio stream untouched (no re-encode).

### Per-Category Transcode Gate (NZB)
Not a global setting — each Sonarr/Radarr NZB category has its own `postEncode` boolean (see [Sonarr/Radarr Integration (NZB)](#sonarrradarr-integration-nzb)) that can *narrow* (never override) the global `downloadTranscodeVideoCodec` setting for grabs in that category specifically, e.g. transcoding Movies but not TV Series. Never applies to STRM cache-on-play downloads, which are never transcoded.

## Advanced Settings

### Log Level
- **Config Key**: `logLevel`
- **Type**: `string`
- **Default**: `""` (empty)
- **Options**: `""`, `"warn"`, `"info"`, `"debug"`
- **Description**: Overrides the server's log verbosity. Empty defers to the `LOG_LEVEL` environment variable (see [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)) as the startup default; an explicit value here takes effect immediately and live, no restart needed.

### Proxy
- **Config Key**: `proxy`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: HTTP/HTTPS proxy for downloads
- **Format**: `"http://proxy:port"` or `"socks5://proxy:port"`
- **Note**: The proxy is used by yt-dlp for all YouTube requests (downloads, metadata, thumbnails). Some operations like thumbnail downloads and RSS feed checks first attempt a direct HTTP request with a 15-second timeout before falling back to yt-dlp. SOCKS5 proxy users may notice brief delays (~15 seconds) during these fallbacks when adding or refreshing channels, but the operations will complete successfully via yt-dlp.

### IP Family
- **Config Key**: `ytdlpIpFamily`
- **Type**: `string` (one of `"ipv4"`, `"ipv6"`, `"auto"`)
- **Default**: `"ipv4"`
- **Description**: IP family preference applied to every yt-dlp invocation.
  - `"ipv4"` adds `-4` (force IPv4) — recommended for YouTube reliability and the historical default.
  - `"ipv6"` adds `-6` (force IPv6).
  - `"auto"` adds neither flag and lets the OS decide.
- **Note**: Force IPv6 or Auto can make YouTube downloads less reliable. Use only if your network requires it.

### Download Rate Limit
- **Config Key**: `ytdlpDownloadRateLimit`
- **Type**: `string`
- **Default**: `""` (empty — no limit)
- **Description**: Maximum download rate, passed to yt-dlp as `--limit-rate`. Format: digits with optional decimal and optional `K`/`M`/`G` suffix (e.g. `"5M"`, `"500K"`, `"1.5M"`). Empty disables the limit.

### Custom yt-dlp Arguments
- **Config Key**: `ytdlpCustomArgs`
- **Type**: `string`
- **Default**: `""` (empty)
- **Description**: Free-form yt-dlp arguments appended to every invocation. Tokenized shell-style (single/double quotes and backslash-escapes supported). Maximum length: 2000 characters.
- **Blocked flags**: For safety, several flags are rejected at save time and silently dropped at command-build time. The full list is in `server/modules/download/customArgsParser.js`; it includes (among others) `--exec`, `--netrc-cmd`, `-o`/`--output`, `-P`/`--paths`, `--print-to-file`, `--external-downloader`/`--downloader`, `--external-downloader-args`/`--downloader-args`, `--cookies`/`--cookies-from-browser`, `--ffmpeg-location`, `--config-location`, `--batch-file`, `--load-info-json`, `--download-archive`, plus the flags that have dedicated config fields (`--proxy`, `-4`/`-6`, `--limit-rate`, `--sleep-requests`).
- **Order**: Custom args are appended LAST in the yt-dlp command, after Youtarr-Turbo's managed flags. Per yt-dlp's last-wins semantics, your flags can override managed ones (e.g. `--retries 5` overrides Youtarr-Turbo's default `--retries 2`).
- **Note**: Power-user feature. Incorrect flags can prevent downloads from working entirely or break Youtarr-Turbo's behavior in unexpected ways. Use the "Validate Arguments" button in the UI to argparse-check your args against yt-dlp before saving. The validation does not gate save — invalid args can still be saved and will only surface failures at download time.

### Use External Temporary Directory
- **Config Key**: `useTmpForDownloads`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Controls where downloads are staged before moving to final location:
  - `false` (default): Downloads are staged in a hidden `.youtarr_tmp/` directory within your output folder. Uses fast atomic renames since source and destination are on the same filesystem. The dot-prefix hides in-progress downloads from media servers like Plex and Jellyfin.
  - `true`: Downloads are staged in the external path specified by `tmpFilePath` (e.g., `/tmp`). Useful when your output directory is on slow network storage and you want to download to fast local storage first.
- **Note**: Some managed platforms (e.g., ElfHosted) force this value on.

### External Temporary File Path
- **Config Key**: `tmpFilePath`
- **Type**: `string`
- **Default**: `"/tmp/youtarr-downloads"`
- **Description**: External temporary directory for downloads when `useTmpForDownloads` is `true`
- **Note**: Only used when `useTmpForDownloads` is enabled. Internal path in Youtarr-Turbo container.

### NFS Output Directory Considerations

If your output directory (`YOUTUBE_OUTPUT_DIR`) is on an NFS mount, be aware of the following:

**When `useTmpForDownloads: true`:** Downloads are staged on a different filesystem from the output directory. The move from temp to output is a cross-filesystem copy+delete, which is vulnerable to NFS stale mount errors. If the NFS mount goes stale, downloads succeed to the temp dir but fail during the move phase. Critically, yt-dlp marks the video as "downloaded" in its archive *before* the move, so the video becomes permanently stuck — it won't be retried on the next scheduled run because yt-dlp thinks it already succeeded.

**Recommended NFS mount options:** If using NFS, mount with options that prevent stale file handles:
```
server:/export /mnt/nfs-output nfs hard,intr,actimeo=3,timeo=300,retrans=5 0 0
```
- `hard` — retries NFS operations indefinitely instead of failing immediately
- `intr` — allows signals to interrupt hung NFS operations
- `actimeo=3` — refreshes NFS attribute cache every 3 seconds (default 60s can cause stale metadata)
- `timeo=300,retrans=5` — longer timeouts before declaring failure

**Docker native NFS volumes (recommended):** Instead of bind-mounting a host NFS directory, let Docker mount NFS directly. This is more resilient because Docker manages the NFS connection rather than inheriting a potentially-stale host mount:

```yaml
services:
  youtarr:
    volumes:
      - youtube-data:/usr/src/app/data        # named NFS volume
      - ./server/images:/app/server/images
      - ./config:/app/config
      - ./jobs:/app/jobs

volumes:
  youtube-data:
    driver: local
    driver_opts:
      type: nfs
      o: addr=YOUR_NFS_SERVER_IP,hard,intr,nfsvers=4,actimeo=3
      device: ":/path/to/your/nfs/export"
```

**Simplest workaround:** Set `useTmpForDownloads: false` (the default). Downloads are staged inside the output directory itself, so the move is a same-filesystem rename — atomic and immune to this class of error. Note: if the NFS mount is stale, downloads will still fail, but they will fail *before* yt-dlp marks them as archived — so they'll be automatically retried on the next scheduled run rather than getting permanently stuck.

## Auto-Removal Settings

### Enable Auto-Removal
- **Config Key**: `autoRemovalEnabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Enable automatic deletion of old videos

### Free Space Threshold
- **Config Key**: `autoRemovalFreeSpaceThreshold`
- **Type**: `string`
- **Default**: `null` (not set)
- **Description**: Minimum free space to maintain
- **Examples**: `"100GB"`, `"500GB"`, `"1TB"`
- **Note**: Deletes oldest videos when space falls below threshold

### Video Age Threshold
- **Config Key**: `autoRemovalVideoAgeThreshold`
- **Type**: `string`
- **Default**: `null` (not set)
- **Description**: Delete videos older than this age
- **Examples**: `"30d"` (30 days), `"3m"` (3 months), `"1y"` (1 year)

### Watched-Based Removal
- **Config Key**: `autoRemovalWatchedEnabled`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: Delete videos after they have been watched on a connected media server (Plex/Jellyfin/Emby). What counts as watched follows `watchStatusWatchedRule`. Videos with no synced watch data are treated as unwatched and never removed by this rule. Requires watch status sync to be enabled (`watchStatusSyncEnabled`); when sync is disabled this strategy is skipped.

### Watched Removal: Days Since Watched
- **Config Key**: `autoRemovalWatchedMinDaysSinceWatched`
- **Type**: `string`
- **Default**: `""` (remove as soon as watched)
- **Description**: Only remove a watched video once its most recent qualifying watch is at least this many days old
- **Examples**: `"7"`, `"30"`

### Watched Removal: Minimum Video Age
- **Config Key**: `autoRemovalWatchedMinVideoAgeDays`
- **Type**: `string`
- **Default**: `""` (any age)
- **Description**: Only remove watched videos downloaded at least this many days ago
- **Examples**: `"30"`, `"90"`

### Keep This Many Newest Downloads
- **Config Key**: `autoRemovalKeepRecentCount`
- **Type**: `number`
- **Default**: `0` (disabled)
- **Description**: The N most recently downloaded videos are excluded from every auto-removal strategy (age, watched, and free-space)
- **Note**: Videos marked as Protected are always excluded from auto-removal, independent of this setting, and do not count toward the N (each keep-recent slot goes to a video that would otherwise be removable). Videos of channels protected at the channel level are treated the same way.

### Preserve STRM Fallback
- **Config Key**: `autoRemovalPreserveStrmFallback`
- **Type**: `boolean`
- **Default**: `true`
- **Description**: When removing a video that has an archived `.strm`/`.strmtool.json` backup pair (written by STRM cache-on-play), revert it back to STRM playback instead of fully deleting the library entry — only the large media file is removed.

### Minimum File Size for Removal
- **Config Key**: `autoRemovalMinFileSizeKB`
- **Type**: `number`
- **Default**: `1`
- **Description**: Safety floor: a video whose tracked file is smaller than this (in KB) is never selected as an age/watched/space removal candidate. Protects bare `.strm` rows (a few dozen bytes) from being "cleaned up" for ~0 bytes of actual savings.

### Per-Channel Auto-Removal Settings
Two more guards live in each channel's settings dialog (the Auto-Removal tab), not in `config.json`:
- **Protect this channel from auto-removal**: excludes every video of the channel from all three strategies. These videos don't consume keep-recent slots either.
- **Always keep newest downloads**: a per-channel version of `autoRemovalKeepRecentCount` (1-10000).

The two are mutually exclusive: enabling protection clears the channel's keep-recent count. Both only apply while the channel is subscribed; they go dormant if you unsubscribe.

## API Keys & External Access

Settings for API key authentication used by bookmarklets, mobile shortcuts, and automation tools.

### API Key Rate Limit
- **Config Key**: `apiKeyRateLimit`
- **Type**: `number`
- **Default**: `10`
- **Description**: Maximum download requests per minute per API key
- **Range**: 1-100
- **Note**: Helps prevent abuse from external integrations. Each API key is rate-limited independently.

For detailed information on creating and using API keys, see [API Integration Guide](API_INTEGRATION.md).

## Video/Events Log

### Event Log Retention
- **Config Key**: `jobEventLogRetentionDays`
- **Type**: `number`
- **Default**: `180`
- **Description**: How many days of the append-only video/events log (`job_events` table, see [DATABASE.md](DATABASE.md)) to keep. A nightly task (3:25 AM, server local time) deletes rows older than this.
- **Range**: `0`-`3650`. `0` keeps everything. A negative or non-numeric value falls back to `180`.
- **Note**: Read live, no restart needed. This is independent of Compact History and of the 42-day in-memory Download History window.

## yt-dlp Auto-Update

Youtarr-Turbo can optionally check for and install yt-dlp updates on a daily schedule (4:00 AM). The channel picker, toggle, and status display live with the manual yt-dlp update button on the Settings -> YT-DLP page.

### Update Channel
- **Config Key**: `ytdlpUpdateChannel`
- **Type**: `string`
- **Default**: `'stable'`
- **Values**: `'stable'` or `'nightly'`
- **Description**: Which yt-dlp release channel Youtarr-Turbo keeps the binary on. Every update (manual, automatic, or startup) runs `yt-dlp --update-to <channel>@latest`, so the configured channel is re-applied even after a container recreation resets the binary to the image's baked-in stable build. Switching back to `stable` from `nightly` downgrades to the latest stable release.
- **Note**: Nightly builds get extractor fixes days earlier than stable but may occasionally break. On managed platforms (Elfhosted) the channel cannot be changed.

### Auto-Update Enabled
- **Config Key**: `autoUpdateYtdlp`
- **Type**: `boolean`
- **Default**: `false`
- **Description**: When `true`, Youtarr-Turbo runs `yt-dlp --update-to <channel>@latest` at 4:00 AM (server local time, controlled by the `TZ` env var) every night.
- **Behavior**:
  - Updates run even while downloads are in progress; the in-flight download finishes on the previous version and the next spawned download uses the new one.
  - If the update process itself fails (e.g., permission denied on managed platforms, network error, timeout), the failure is logged and Youtarr-Turbo continues to run on the previous yt-dlp version.
  - On success, the in-process yt-dlp version cache is refreshed without requiring a server restart.

### Last Checked Timestamp
- **Config Key**: `ytdlpLastChecked`
- **Type**: `string | null` (ISO 8601 timestamp)
- **Default**: `null`
- **Description**: Set automatically every time the nightly job runs (regardless of outcome). Surfaced in the UI as "Last checked: ...".
- **Note**: Managed by the application; do not edit by hand.

### Last Updated Timestamp
- **Config Key**: `ytdlpLastUpdated`
- **Type**: `string | null` (ISO 8601 timestamp)
- **Default**: `null`
- **Description**: Set automatically when the nightly job successfully installs a new yt-dlp version. Not updated when the check finds yt-dlp is already current.
- **Note**: Managed by the application; do not edit by hand.

### Last Run Result
- **Config Key**: `ytdlpLastResult`
- **Type**: `object | null`
- **Default**: `null`
- **Shape**: `{ status: 'updated' | 'up-to-date' | 'skipped' | 'error', message?: string, version?: string }`
- **Description**: Records the outcome of the most recent nightly run. The UI uses this to render an inline status next to "Last checked".
- **Statuses**:
  - `updated` — a new version was installed; `version` holds the new version string.
  - `up-to-date` — yt-dlp was already current.
  - `skipped` — the run was deferred (another update was already running); `message` describes why.
  - `error` — `yt-dlp --update-to` failed; `message` holds a short error description.
- **Note**: Managed by the application; do not edit by hand.

## Filesystem Rescan

For user-facing documentation on when and how to use the filesystem rescan (moving files, converting formats, supported extensions), see [Rescan Files on Disk](USAGE_GUIDE.md#rescan-files-on-disk).

### Last Rescan Result
- **Config Key**: `rescanLastRun`
- **Type**: `object | null`
- **Default**: `null`
- **Shape**:
  ```json
  {
    "startedAt": "2026-05-04T15:13:00.000Z",
    "completedAt": "2026-05-04T15:14:32.000Z",
    "trigger": "manual | scheduled | startup",
    "status": "completed | timed-out | error",
    "videosUpdated": 12,
    "videosMarkedMissing": 3,
    "videosScanned": 8421,
    "filesFoundOnDisk": 8423,
    "errorMessage": null
  }
  ```
- **Description**: Records the outcome of the most recent filesystem reconciliation pass (the `backfillVideoMetadata` run). Written by the daily cron, the server-startup pass, and the manual "Rescan files on disk" action on the Maintenance & Rescan settings page. Surfaced read-only on that page so users can see when the last scan ran and what it found or fixed.
- **Note**: Managed by the application; do not edit by hand.

## Account & Security

### username
- **Type**: `string`
- **Default**: Not set (must be configured)
- **Description**: Login username for the web interface
- **Validation**: 1-32 characters, no leading/trailing spaces
- **Note**: Set during initial setup or via AUTH_PRESET_USERNAME environment variable

### passwordHash
- **Type**: `string`
- **Default**: Not set (must be configured)
- **Description**: Bcrypt hash of the login password
- **Note**: Never edit directly - use web UI or AUTH_PRESET_PASSWORD environment variable


## System Fields

These fields are managed automatically by the application:

### uuid
**Type**: `string`
**Default**: Auto-generated
**Description**: Unique installation identifier, used as the Plex client identifier
**Note**: Sent to Plex as `X-Plex-Client-Identifier` and as the `clientID` in the Plex OAuth URL. Editing it by hand changes the device identity Plex sees, so leave it alone.

## Configuration Examples

See config/config.example.json

## Best Practices

1. **Backup your config.json** before major changes
2. **Use the Web UI** for configuration when possible
3. **Test cron expressions** at [crontab.guru](https://crontab.guru/)
4. **Monitor disk space** when enabling auto-downloads
5. **Start conservative** with download frequency to avoid rate limiting

## Troubleshooting

### Configuration Not Saving
- Check file permissions: `ls -la config/config.json`
- Ensure proper ownership matches YOUTARR_UID/GID
- Check logs for write permission errors

### Missing Configuration Options in UI
- Clear browser cache
- Ensure you're running the latest version
- Check browser console for JavaScript errors

### Downloads Not Running on Schedule
- Verify cron expression syntax
- Check timezone setting (TZ environment variable)
- Review logs for scheduler errors
