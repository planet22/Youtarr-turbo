# Getting Started: Streaming Instead of Downloading (STRM + ytstream)

This guide walks through setting up Youtarr-Turbo so that subscribed channels don't
download full video files at all — instead they show up in your media server
as on-demand streams, played back through Youtarr-Turbo's own `/api/ytstream` route.

For the full field reference, see [YTSTREAM.md](YTSTREAM.md), [STRM.md](STRM.md),
and the [Media Mode & STRM](CONFIG.md#media-mode--strm) / [Streaming (ytstream)](CONFIG.md#streaming-ytstream)
sections of `CONFIG.md`.

## What you get

Instead of Youtarr-Turbo running yt-dlp to pull down and store a full copy of every
video, it writes a tiny `.strm` shortcut file (plus NFO/thumbnail) into your
library. When Jellyfin/Emby/Kodi "plays" that item, the request actually hits
Youtarr-Turbo's `/api/ytstream/:youtubeId` route, which resolves and streams the
video from YouTube on the fly — optionally transcoding it server-side first.
Net effect: your library looks and behaves like a normal, fully-downloaded
library, but consumes near-zero disk space per video.

## Prerequisites

- **ffmpeg on `PATH`** for the Youtarr-Turbo server process (needed by every
  mode below except YouTube HLS passthrough). Already bundled in the
  Docker image; see [YTSTREAM.md § Installing ffmpeg](YTSTREAM.md#installing-ffmpeg)
  for bare-metal setups.
- **A media server** (Jellyfin, Emby, or Kodi) that can read `.strm` files
  from the same library folder Youtarr-Turbo writes to.
- **If you want hardware-accelerated transcoding**: the GPU device passed
  through to the Youtarr-Turbo container (e.g. `--device /dev/dri` for VAAPI/QSV,
  or the NVIDIA Container Toolkit for NVENC). If also running as a non-root
  user (`YOUTARR_UID`/`YOUTARR_GID`), the container also needs `group_add` for
  the device's owning groups — see [YTSTREAM.md § Hardware encoding](YTSTREAM.md#hardware-encoding-enhanced--h264).
- **A `proxyBaseUrl` your media server can actually reach** — not
  `127.0.0.1` unless the media server runs on the exact same host as
  Youtarr-Turbo.

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
set the target to Youtarr-Turbo's own streaming route rather than a raw
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
  so playback goes through Youtarr-Turbo's cookie handling, proxy config,
  and transcode settings below.
- **Base URL** (`proxyBaseUrl`) — the base URL your media server will use to
  reach Youtarr-Turbo. Replace `http://youtarr.example.lan` with your own
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

## Step 3 — Pick a playback mode

This is the part worth getting right: the **Playback mode** decides how a
`.strm` play becomes video, and with it CPU load, disk use, seek behavior, and
the maximum quality. Three modes are the ones to start from. Pick one, paste
its recipe into **Settings → Streaming** (or `config.json`), and only then
tweak.

| | **A. YouTube HLS passthrough** | **B. Byte-range Plain file** | **C. Enhanced HLS + Buffered** |
|---|---|---|---|
| UI label | YouTube HLS passthrough | Byte-range Plain file | Enhanced HLS + Buffered |
| `defaultMode` | `youtube-hls` | `hls-byterange` + `byteRangeDeliverAsFile: true` | `hls-buffer` |
| What the player gets | YouTube's own HLS playlist | One growing `.mkv`/`.mp4` file over HTTP Range | Youtarr-Turbo's own HLS playlist and segments |
| Server CPU | None (no ffmpeg, no yt-dlp download) | Low with `copy`; a real encode with `h264` | Low with `copy`; a real encode with `h264` |
| Local disk | None | Whole video in a hidden cache | Live segments plus a whole-video buffer file |
| Max quality | 1080p, H.264 (whatever YouTube offers over HLS) | Up to 4K (DASH) | Up to 4K (DASH) |
| Exact length up front | Yes (YouTube's playlist lists every segment) | Yes (Matroska header duration + declared file size) | Yes (`calculatedLength`, forced on) |
| Seeking | Anywhere, instantly | Backward always; forward waits for the download to reach that point | Anywhere (a far forward seek restarts the encode there) |
| Repeat plays | Re-resolve each time | Served from the cache, instant | Served from the buffer file, instant |
| Needs ffmpeg | No | Yes | Yes |
| Player must reach YouTube | **Yes**, same network as the server | No | No |
| Best for | Lowest server load; 1080p is enough | Players that like a plain file; keeping a hidden cache | Maximum client compatibility and hardware transcoding |

A quick way to choose:

- **Start with A.** It costs the server almost nothing and works in Jellyfin
  with a correct scrub bar. Move on only if you need above 1080p, or your
  players can't reach YouTube directly.
- **Choose B** if you want a real file for the player (some clients handle a
  plain file better than HLS) and repeat plays served from local disk.
- **Choose C** if you want to force H.264/AAC for every client, offload the
  encode to a GPU, and keep the buffered copy for later plays.

> **Existing `.strm` files keep the mode they were written with** unless
> **Force these settings (ignore URL / .strm overrides)** is on. All three
> recipes turn it on (`forceServerSettings: true`), so switching between them
> takes effect immediately, with no need to re-materialize your library.

All of these fields live on **Settings → Streaming**, in the **STRM
(stream-only)** card, below the Media Mode & Target section from Steps 1-2
(the page only shows the block once STRM target is set to "Youtarr-Turbo
direct/ffmpeg"). Fields a mode ignores stay visible but disabled, with the
reason in their tooltip.

### Recipe A — YouTube HLS passthrough

Youtarr-Turbo resolves YouTube's own HLS playlist once and hands it to the player.
Nothing is encoded or downloaded on the server. This recipe routes segment
requests through Youtarr-Turbo as redirects, so each play shows on the Streaming
page, and picks English audio when a video has dubbed tracks:

```json
"ytstream": {
  "defaultMode": "youtube-hls",
  "quality": "1080",
  "qualityStrictness": "fallback",
  "audioLanguage": "en",
  "youtubeHlsProxy": "serve",
  "forceServerSettings": true,
  "playerClient": "",
  "historyRetentionDays": 14
}
```

| Setting (UI) | Config Key | Value | Rationale |
|---|---|---|---|
| Playback mode | `defaultMode` | YouTube HLS passthrough | YouTube's playlist lists every segment and its duration up front, so the player knows the exact length immediately and can seek anywhere. |
| Stream quality | `quality` | 1080p | Picks the HLS variant. 1080p is also the ceiling, since YouTube's HLS only offers H.264 up to 1080p. |
| Quality strictness | `qualityStrictness` | Fall back to lower resolution | If the exact height isn't offered, take the nearest lower variant instead of failing. |
| Audio language | `audioLanguage` | `en` | Many videos carry dubbed audio. This serves the `en` track (a region-less code also matches `en-US`/`en-GB`) when the video offers it, else the original track. Blank always gives the original. |
| Route through Youtarr-Turbo | `youtubeHlsProxy` | Serve segment URLs | `off`: the player talks to YouTube directly and Youtarr-Turbo sees only the first request. `proxy`: Youtarr-Turbo also serves the media playlists, so plays and viewers appear on the Streaming page. `serve`: every segment URL also points at Youtarr-Turbo, which answers with a `302` to YouTube, so the page also shows playback position and an estimated data rate (marked `~`, since no video bytes pass through Youtarr-Turbo). Costs a small delay per segment. |
| Force these settings | `forceServerSettings` | on | Ignores the mode and quality baked into older `.strm` URLs. |

Ignored in this mode: Container, Transcode, Hardware encoder/decode, Encoding
tuning, Calculated length, Probe shortcut, HLS master playlist, and Cache on
play. Cookies still apply, so age-restricted and members-only videos work if
you've uploaded them.

**Trade-off:** the player fetches segments from YouTube, so it has to reach
YouTube from the same network as the Youtarr-Turbo server (the URLs can be
IP-bound and expire after a few hours). Youtarr-Turbo keeps the resolved playlist
for 30 minutes; playing again after that re-resolves it.

### Recipe B — Byte-range Plain file

yt-dlp video and audio are piped into one ffmpeg that writes a single growing
file, and the player reads that file over ordinary HTTP Range requests. The
finished file stays in a hidden cache, so a later play is a plain file read.
This recipe uses Matroska, which writes the real duration into the file header
so Jellyfin sees the correct length at once:

```json
"ytstream": {
  "defaultMode": "hls-byterange",
  "byteRangeDeliverAsFile": true,
  "byteRangeResumeCache": false,
  "container": "mkv",
  "transcode": "copy",
  "quality": "1080",
  "qualityStrictness": "fallback",
  "hlsStorageLocation": "cache",
  "forceServerSettings": true,
  "playerClient": "",
  "historyRetentionDays": 14
}
```

| Setting (UI) | Config Key | Value | Rationale |
|---|---|---|---|
| Playback mode | `defaultMode` + `byteRangeDeliverAsFile` | Byte-range Plain file | One dropdown entry sets both fields. The plain "Byte-range HLS (experimental)" entry is the manifest variant, which Jellyfin treats as a live stream, so don't use it for STRM playback. |
| Container | `container` | Matroska | Growing `.mkv` with the real duration in its header and the final size declared up front. **MP4** also works (fragmented MP4, header patched where possible). MPEG-TS isn't offered for this mode. |
| Transcode | `transcode` | Always remux (copy) | No re-encode, so it costs almost no CPU. Use *Force re-encode (H.264/AAC)* plus a Hardware encoder if a client can't play what YouTube served (VP9/AV1). Unlike Enhanced HLS, this mode doesn't auto-upgrade `copy` to H.264. |
| Stream quality | `quality` | 1080p | Caps the DASH pair Youtarr-Turbo fetches. Up to 4K is available. |
| HLS segment storage | `hlsStorageLocation` | App persistent cache folder | With `cache`, ffmpeg writes straight into the hidden cache (`.byterange-cache/`) and the file is renamed into place when finished, instead of being copied from `/tmp` afterward. |
| Resume partial cache | `byteRangeResumeCache` | off | When an encode is cut off early (idle timeout, Stop), the next request re-encodes from near where it stopped and splices the new tail on, instead of starting at 0:00. Newer than the rest of this mode, so turn it on deliberately. If validation fails the partial is left alone and the next play does a fresh encode. |
| Force these settings | `forceServerSettings` | on | Same reason as in recipe A. |

Behavior worth knowing:

- Reads past the bytes written so far wait for the encode to catch up, so a
  forward seek works but pauses until the download reaches that point.
- A request answered from a finished cache entry shows on the Streaming page
  as a `byterange-cache-hit` row and gets a Stream History entry.
- Cached files are swept by the same nightly expiry as the untracked buffer
  cache, so **Revert to STRM after (hours)** from Step 2 also bounds how long
  they stay.
- To play with hardware transcoding, set `"transcode": "h264"`,
  `"hardwareMode": "vaapi"` (or `qsv`/`nvenc`/`amf`), and `"tuning"`, then
  benchmark with the buttons under Performance Optimizations.

### Recipe C — Enhanced HLS + Buffered

Youtarr-Turbo encodes real HLS segments (`.m3u8` + segment files) from separate
video and audio streams. A second, unthrottled fetch pulls the whole video
into a local buffer file, so later plays and re-seeks read from disk. This
recipe forces an H.264 re-encode on a GPU host for the widest client
compatibility:

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
  "hlsMasterPlaylist": true,
  "probeShortcut": true,
  "serveCachedFile": true,
  "forceServerSettings": true,
  "historyRetentionDays": 14,
  "hlsStorageLocation": "cache",
  "backfillMissingSegments": false,
  "finalizeToMp4": false,
  "stealthCache": false,
  "bufferStartAfterSegments": 3,
  "forceKeyframesByHardwareMode": {
    "vaapi": true,
    "none": false,
    "qsv": false
  }
}
```

| Setting (UI) | UI section | Config Key | Value | Rationale |
|---|---|---|---|---|
| Playback mode | Media Mode & Target | `defaultMode` | Enhanced HLS + Buffered | Real segmented output with instant seeking inside what's encoded, plus a background fetch that pulls the whole video into a local buffer. See [YTSTREAM.md § Enhanced HLS](YTSTREAM.md#enhanced-hls-modehls). |
| Container | Media Mode & Target | `container` | MP4 | fMP4 segments for the live HLS side. The permanent buffer file is always MPEG-TS regardless. |
| Transcode | Media Mode & Target | `transcode` | Force re-encode (H.264/AAC) | A real re-encode instead of remuxing whatever codec YouTube served. Maximizes compatibility (Apple TV, older Rokus) at the cost of CPU, offloaded to hardware below. |
| Stream quality | Media Mode & Target | `quality` | 1080p | Caps streamed playback at 1080p, a deliberate quality/CPU trade-off for a transcode-every-time setup. |
| Quality strictness | Media Mode & Target | `qualityStrictness` | Fall back to lower resolution | Falls back to the nearest lower quality instead of failing. |
| Hardware encoder | Performance Optimizations | `hardwareMode` | VAAPI (h264_vaapi) | Offloads the H.264 encode to the GPU instead of software `libx264`. The biggest factor in how many concurrent streams the server sustains. |
| Hardware decode | Performance Optimizations | `hardwareDecodeMode` | Software | Decode stays on the CPU. Measured on a VAAPI host, hardware decode of H.264 was *slower* than software, and live playback doesn't use this field yet (it only feeds the "Test real-time tuning" benchmark). Leave it at `none` unless you've measured a win. |
| Encoding tuning | Performance Optimizations | `tuning` | Quality | Favors picture quality, since the encode is already on the GPU and has headroom. |
| Probe shortcut | Performance Optimizations | `probeShortcut` | on | Answers a media server's metadata probe with the real session's playlist immediately instead of waiting for a segment to encode. |
| Force these settings | top of STRM/ytstream card | `forceServerSettings` | on | Every play uses this config, not whatever is baked into an older `.strm`. |
| History retention (days) | Storage & background processing | `historyRetentionDays` | `14` | Two weeks of Stream History without unbounded growth. |
| HLS segment storage | Storage & background processing | `hlsStorageLocation` | App persistent cache folder | Segments go in Youtarr-Turbo's cache folder rather than the OS temp directory. |

Not set by dropdown:

- **`calculatedLength`**: forced on by the UI in this mode, so you don't need
  to set it.
- **`forceKeyframesByHardwareMode.vaapi: true`**: written by the **HLS
  segment-timing test** (Performance Optimizations → Hardware Testing), not by
  hand. It records that the encoder honors exact keyframe timing on this host.
- **`bufferStartAfterSegments`** (default `3`, `config.json` only): delays the
  full-video buffer fetch until the player has requested this many distinct
  segments, so a metadata probe that only reads segment 0 doesn't start a full
  download. `0` starts the fetch immediately.

Optional storage switches for this mode: `stealthCache` keeps the finished
buffer out of the library so the video stays a `.strm` forever;
`finalizeToMp4` remuxes the buffered `.ts` into an `.mp4` once complete. See
[YTSTREAM.md § Storage & background processing](YTSTREAM.md#storage--background-processing).

## Other modes

The Playback mode dropdown also offers **Direct**, **Direct (redirect)** (both
~360p progressive, no ffmpeg), **Byte-range HLS (experimental)** (manifest
variant; Jellyfin treats it as live, so it isn't recommended), and **Download &
cache (experimental)** (blocks until the whole file is ready). Plain
`hls` still works as a `?mode=` value but is hidden from the picker.
[YTSTREAM.md](YTSTREAM.md) documents all seven.

## Step 4 — Point your media server at the library

Add/refresh your Jellyfin (or Emby/Kodi) library pointed at the same output
folder Youtarr-Turbo writes `.strm` files into — no different from a normal
Youtarr-Turbo download library. Per-subfolder library mappings work the same way
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
   seconds (a cold start for recipes B and C; recipe A only resolves a
   playlist), and scrubbing should work once playback has started. The play
   should also appear on **Streaming** (live) and **Streaming → History**.
3. Manual check of the raw resolve, bypassing the media server entirely:
   ```bash
   curl -I "http://<youtarr-host>:<port>/api/ytstream/<youtubeId>"
   ```
4. Dry-run what the current settings would do for a video, without starting
   yt-dlp or ffmpeg (needs a session token; add `?probe=true` to also run the
   real yt-dlp lookup and report the variant/audio track it would choose):
   ```bash
   curl -H "x-access-token: <token>"      "http://<youtarr-host>:<port>/api/ytstream/<youtubeId>/simulate"
   ```

## Troubleshooting

See [YTSTREAM.md § Troubleshooting](YTSTREAM.md#troubleshooting) for the
common yt-dlp extraction errors (`"The page needs to be reloaded"`,
missing/expired cookies, outdated yt-dlp) and how Youtarr-Turbo's automatic
retry-with-alternate-client logic handles most of them without any action
needed on your part.
