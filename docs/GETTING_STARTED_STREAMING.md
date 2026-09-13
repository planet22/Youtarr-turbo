# Getting Started: Streaming Instead of Downloading (STRM + ytstream)

This guide walks through setting up Youtarr Turbo so that subscribed channels don't
download full video files at all — instead they show up in your media server
as on-demand streams, played back through Youtarr Turbo's own `/api/ytstream` route.

For the full field reference, see [YTSTREAM.md](YTSTREAM.md), [STRM.md](STRM.md),
and the [Media Mode & STRM](CONFIG.md#media-mode--strm) / [Streaming (ytstream)](CONFIG.md#streaming-ytstream)
sections of `CONFIG.md`.

## What you get

Instead of Youtarr Turbo running yt-dlp to pull down and store a full copy of every
video, it writes a tiny `.strm` shortcut file (plus NFO/thumbnail) into your
library. When Jellyfin/Emby/Kodi "plays" that item, the request actually hits
Youtarr Turbo's `/api/ytstream/:youtubeId` route, which resolves and streams the
video from YouTube on the fly — optionally transcoding it server-side first.
Net effect: your library looks and behaves like a normal, fully-downloaded
library, but consumes near-zero disk space per video.

## Prerequisites

- **ffmpeg on `PATH`** for the Youtarr Turbo server process. Already bundled in the
  Docker image; see [YTSTREAM.md § Installing ffmpeg](YTSTREAM.md#installing-ffmpeg)
  for bare-metal setups.
- **A media server** (Jellyfin, Emby, or Kodi) that can read `.strm` files
  from the same library folder Youtarr Turbo writes to.
- **If you want hardware-accelerated transcoding**: the GPU device passed
  through to the Youtarr Turbo container (e.g. `--device /dev/dri` for VAAPI/QSV,
  or the NVIDIA Container Toolkit for NVENC). If also running as a non-root
  user (`YOUTARR_UID`/`YOUTARR_GID`), the container also needs `group_add` for
  the device's owning groups — see [YTSTREAM.md § Hardware encoding](YTSTREAM.md#hardware-encoding-enhanced--h264).
- **A `proxyBaseUrl` your media server can actually reach** — not
  `127.0.0.1` unless the media server runs on the exact same host as
  Youtarr Turbo.

## Step 1 — Turn on STRM mode

Go to **Settings → Streaming**. At the top of the **STRM (stream-only)**
card, under "Media Mode & Target", set the **Media mode** dropdown:

| Setting (UI) | Location | Config Key | Value | Meaning |
|---|---|---|---|---|
| Media mode | Settings → Streaming → STRM (stream-only) → Media Mode & Target | `mediaMode` | STRM only (no media download) | New downloads write `.strm` shortcuts only — no video file is stored. |

("Both (download + STRM)" is also available if you want the file
downloaded *and* a `.strm` pointer written; "Download full files (default)"
is the traditional full-download behavior.) This can be overridden
per-channel or per-playlist, in that channel's/playlist's own Settings
dialog, if you only want a subset of your library streamed.

## Step 2 — Point STRM at ytstream

Still on **Settings → Streaming**, in the same "Media Mode & Target" section,
set the target to Youtarr Turbo's own streaming route rather than a raw
YouTube link, and turn on caching for anything that actually gets watched:

| Setting (UI) | Config Key | Value used here |
|---|---|---|
| STRM target | `strm.target` | "Youtarr-Turbo direct/ffmpeg (/api/ytstream/:id)" |
| Base URL | `strm.proxyBaseUrl` | `http://youtarr.example.lan` |
| Write NFO with STRM *(Sidecar Files section)* | `strm.writeNfo` | on |
| Write thumbnail with STRM *(Sidecar Files section)* | `strm.writeThumbnail` | on |
| Write Jellyfin StrmTool cache *(Sidecar Files section)* | `strm.writeMediaInfoCache` | on |
| Cache on play *(further down the page, in Performance Optimizations)* | `strm.cacheOnPlay` | on |
| Revert to STRM after (hours) *(further down, in Storage & background processing)* | `strm.cacheOnPlayExpiryHours` | `96` |
| Stream quality | `strm.quality` (via `ytstream.quality`) | Auto (`null`) |

Resulting `config.json`:

```json
"strm": {
  "target": "ytstream",
  "proxyBaseUrl": "http://youtarr.example.lan",
  "writeNfo": true,
  "writeThumbnail": true,
  "writeMediaInfoCache": true,
  "cacheOnPlay": true,
  "cacheOnPlayExpiryHours": 96,
  "quality": null
}
```

- **STRM target = "Youtarr-Turbo direct/ffmpeg"** (`target: "ytstream"`) —
  `.strm` files point at `/api/ytstream/:id` instead of a bare YouTube URL,
  so playback goes through Youtarr Turbo's cookie handling, proxy config,
  and transcode settings below.
- **Base URL** (`proxyBaseUrl`) — the base URL your media server will use to
  reach Youtarr Turbo. Replace `http://youtarr.example.lan` with your own
  reachable hostname/IP and port.
- **Cache on play = on** (`cacheOnPlay: true`) — the *first* play of a
  `.strm` item kicks off a background full download that then serves
  locally for the rest of that watch and any rewatch, instead of
  re-streaming from YouTube every time. Good middle ground:
  casual/never-watched channel content stays disk-free, but anything you
  actually watch gets a real local copy for smooth scrubbing.
- **Revert to STRM after (hours) = 96** (`cacheOnPlayExpiryHours: 96`) — 4
  days after a cache-on-play download finishes, the nightly sweep reverts it
  back to STRM-only, freeing the disk space again. Leave blank to keep
  cached copies forever.
- **Stream quality = Auto** (`quality: null`) — inherits the global
  Preferred Resolution setting rather than hard-coding a different quality
  just for streamed playback.

## Step 3 — Tune the ytstream playback route

This is the part worth getting right, since it controls transcode quality,
CPU load, and seek behavior. Here's a config tuned for **smooth seeking on a
GPU-equipped host**, prioritizing playback compatibility over raw CPU
savings:

```json
"ytstream": {
  "defaultMode": "hls-buffer",
  "container": "mp4",
  "transcode": "h264",
  "quality": "1080",
  "qualityStrictness": "fallback",
  "hardwareMode": "vaapi",
  "hardwareDecodeMode": "none",
  "tuning": "quality",
  "playerClient": "",
  "calculatedLength": true,
  "hotSwapToCache": false,
  "serveCachedFile": true,
  "probeShortcut": true,
  "forceServerSettings": true,
  "historyRetentionDays": 14,
  "hlsStorageLocation": "cache",
  "backfillMissingSegments": false,
  "finalizeToMp4": false,
  "stealthCache": false,
  "bufferedPlaybackMode": "transcode",
  "debugLogging": false,
  "forceKeyframesByHardwareMode": {
    "vaapi": true,
    "none": false,
    "qsv": false
  }
}
```

### Where each field lives, and why these values

All of these are on **Settings → Streaming**, inside the **STRM (stream-only)**
card, below the Media Mode & Target section you set in Steps 1-2 (the page
only shows this block once STRM target is set to "Youtarr-Turbo
direct/ffmpeg"):

| Setting (UI) | UI section | Config Key | Value | Rationale |
|---|---|---|---|---|
| Playback mode | Media Mode & Target | `defaultMode` | Enhanced HLS + Buffered | Enhanced HLS (real segmented output, genuinely instant seeking within what's encoded) *plus* an unthrottled background fetch that pulls the whole video into a local buffer file. First-watch seeking is smooth via HLS; the buffer means later re-seeks in the same session read from disk instead of the network. See [YTSTREAM.md § Enhanced HLS](YTSTREAM.md#enhanced-hls-modehls). |
| Container | Media Mode & Target | `container` | MP4 | fMP4 segments for the live HLS side; the permanent buffered download is always MPEG-TS regardless of this setting in `hls-buffer` mode. |
| Transcode | Media Mode & Target | `transcode` | Force re-encode (H.264/AAC) | Forces a real re-encode instead of remuxing whatever codec YouTube served. Maximizes compatibility across every client (Apple TV, older Rokus, etc.) at the cost of CPU — offloaded to hardware below. |
| Stream quality | Media Mode & Target | `quality` | 1080p | Caps streamed playback at 1080p regardless of source resolution — a deliberate quality/CPU tradeoff for a transcode-every-time setup. |
| Quality strictness | Media Mode & Target | `qualityStrictness` | Fall back to lower resolution | If 1080p isn't available, falls back to the nearest lower quality instead of failing the request outright. |
| Hardware encoder | Performance Optimizations | `hardwareMode` | VAAPI (h264_vaapi) | Offloads the H.264 *encode* to the GPU (`/dev/dri/renderD128`) instead of software `libx264` — the single biggest factor in how many concurrent streams the server can sustain. |
| Hardware decode *(not used in streaming)* | Performance Optimizations | `hardwareDecodeMode` | Software | **Decode** stays on software CPU even though encode is hardware. This was verified with real benchmarking: VAAPI hardware decode was measurably *slower* than software decode for H.264 source on this hardware — see the note below. Don't assume hardware decode is always a win; test it with the "Test real-time tuning" button in this same section. |
| Encoding tuning | Performance Optimizations | `tuning` | Quality | Biases the encoder toward visual quality over raw speed, since encode is already offloaded to the GPU and has headroom. |
| Force these settings (ignore URL / .strm overrides) | top of STRM/ytstream card | `forceServerSettings` | on | Every playback request uses *this* config, full stop — ignores whatever mode/quality/transcode values happen to be baked into an already-written `.strm` file or a caller's query string. Prevents drift between what you've tuned server-side and stale URLs written before you changed settings. |
| Probe shortcut | Performance Optimizations | `probeShortcut` | on | Serves a tiny cached clip to a media server's metadata probe instead of triggering a real fetch against YouTube. |
| History retention (days) | Storage & background processing | `historyRetentionDays` | `14` | Keeps 2 weeks of stream-session history (`stream_history` table) for troubleshooting/monitoring without it growing unbounded. |
| HLS segment storage | Storage & background processing | `hlsStorageLocation` | App persistent cache folder | HLS segments are written to Youtarr Turbo's own cache folder rather than the OS temp directory. |

Three fields in this config aren't things you set directly in a dropdown:

- **`calculatedLength: true`** — not a toggle; the UI forces this on
  automatically whenever Playback mode is "Enhanced HLS + Buffered" (there's
  no longer an "optional" case to pick from for this mode).
- **`forceKeyframesByHardwareMode.vaapi: true`** — set by running the
  **HLS segment-timing test** for VAAPI (Performance Optimizations →
  Hardware Testing accordion), not edited by hand. It records whether that
  encoder honors exact keyframe timing on this host.
- **`bufferedPlaybackMode: "transcode"`** — not currently exposed in the
  Settings UI at all; this one is a `config.json`-only field. It means the
  buffered raw copy `hls-buffer` produces is *also* run through the
  transcode pipeline (not a raw passthrough), keeping it consistent with the
  live HLS output.

> **Hardware decode is not free — benchmark before enabling it.** It's
> tempting to turn on `hardwareDecodeMode` to match `hardwareMode`
> symmetrically, but on this setup VAAPI decode of H.264 source was
> *slower* than plain software decode. Leave `hardwareDecodeMode: "none"`
> unless you've actually measured a win on your own hardware.

## Step 4 — Point your media server at the library

Add/refresh your Jellyfin (or Emby/Kodi) library pointed at the same output
folder Youtarr Turbo writes `.strm` files into — no different from a normal
Youtarr Turbo download library. Per-subfolder library mappings work the same way
in STRM mode as they do for full downloads, and are configured on
**Settings → Jellyfin → Per-Subfolder Library Mappings** (this section only
appears once a Jellyfin URL and API key are entered above it on the same
page):

```json
"jellyfinSubfolderLibraryMappings": [
  { "subfolder": "Movies", "libraryId": "<your-movies-library-id>" },
  { "subfolder": "Series", "libraryId": "<your-series-library-id>" }
]
```

Get the library IDs from Jellyfin's own admin UI, and the API key/user ID
from **Dashboard → API Keys** in Jellyfin itself, entered on the same
**Settings → Jellyfin** page — see [CONFIG.md § Jellyfin Integration](CONFIG.md#jellyfin-integration).

## Verifying it works

1. Trigger a download for one video in a STRM-enabled channel and confirm a
   `.strm` file (not a video file) shows up in the output folder.
2. Open that item in Jellyfin and press play. First load should take a few
   seconds (HLS session cold-start); scrubbing forward/back should be smooth
   once the first segments exist.
3. Manual curl check of the raw resolve, bypassing the media server entirely:
   ```bash
   curl -I "http://<youtarr-host>:<port>/api/ytstream/<youtubeId>"
   ```

## Troubleshooting

See [YTSTREAM.md § Troubleshooting](YTSTREAM.md#troubleshooting) for the
common yt-dlp extraction errors (`"The page needs to be reloaded"`,
missing/expired cookies, outdated yt-dlp) and how Youtarr Turbo's automatic
retry-with-alternate-client logic handles most of them without any action
needed on your part.
