# YouTube direct/HLS streaming (`/api/ytstream`)

This is an **additive** playback route alongside the existing `.strm`
proxy (`server/routes/strm.js`, see `docs/STRM.md`). Nothing in `strm.js`,
`strmGenerator.js`, or `strmMaterializer.js` was changed to add this —
it's a new route file (`server/routes/ytstream.js`, plus its
`server/modules/ytstream/` sub-modules) you can use instead of, or
alongside, STRM files.

It's modeled on the two playback modes from
[kingschnulli/jellyfin-youtube-plugin](https://github.com/kingschnulli/jellyfin-youtube-plugin):

| This route (`?mode=`) | What it does | Needs ffmpeg? |
|---|---|---|
| `direct` (default) | Resolves one progressive URL with yt-dlp and proxies it straight through (Range-forwarded, real Content-Length). | No |
| `direct-redirect` | Same resolve as `direct`, but sends the player a 302 straight to the resolved URL instead of proxying the bytes — lightest mode on resources, but cookies/Referer don't travel with the redirect. | No |
| `hls` | DASH video-only + audio-only, each fetched by its own `yt-dlp -o -` process and piped into ffmpeg, which writes real segmented HLS output (`.m3u8` + segment files) to disk instead of piping live — the response isn't sent until the first segment actually exists. Natively seekable within whatever's already been encoded. Optional `calculatedLength` pre-declares the *entire* real-duration playlist upfront — see "Calculated length" below. Not offered in the Settings UI's Playback mode dropdown (`hls-buffer` is a strict superset there), but still a fully valid `?mode=` value and config setting. | Yes |
| `hls-buffer` | Same engine as `hls`, plus an independent, unthrottled fetch starts immediately and pulls the whole video once into a local buffer file that becomes the permanent download — later seeks in the same session can read from that local file instead of the network. `calculatedLength` is always on for this mode. This is the option labeled "Enhanced HLS + Buffered" in Settings. | Yes |

There used to be a fifth mode, a live-pipe `mode=ffmpeg` (yt-dlp piped
straight into a single ffmpeg process, sent to the client as it was
produced, with no real segment files). It has been **removed entirely** —
some players (Jellyfin's own server-side transcoder being the motivating
case) wouldn't tolerate the pipeline's startup latency on an already-open
connection and just retried forever. `hls`/`hls-buffer`'s real segmented
output replaces it; there is no live-pipe mode left in this codebase. An
old `.strm` file or bookmarked URL with `mode=ffmpeg` falls back to
whatever `ytstream.defaultMode` is currently configured (or `direct` if
even that is invalid) rather than erroring — see `resolvePlaybackPlan`'s
invalid-mode handling in `server/modules/ytstream/playbackPlan.js`.

**Why not just use the Jellyfin plugin directly?** It has no cookie
support, so age-restricted and members-only videos won't play. This route
reuses Youtarr's existing cookie handling
(`configModule.getCookiesPath()`) plus its existing proxy / IP-family /
rate-limit conventions (`YtdlpCommandBuilder.buildCommonArgs`), so
anything your channel downloads can already authenticate for will also
stream.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/ytstream/:youtubeId` | **None** (players) | Resolve + play. Query params below. |
| `GET` | `/api/ytstream/:youtubeId/formats` | Session / token | Debug helper — dumps `yt-dlp -F` output. |
| `GET` | `/api/ytstream/:youtubeId/simulate` | Session / token | Debug dry-run — runs the exact same `resolvePlaybackPlan` decision logic the real route uses and reports what *would* happen (mode, quality, container/transcode, format selectors, whether probe-shortcut would fire) without ever touching yt-dlp/ffmpeg or a real session. `?probe=true` additionally runs the two real yt-dlp lookups (best-available-height auto-cap, transcode=copy codec check) for an exact trace, at the cost of that latency. **Experimental modes** (`hls-byterange`, `youtube-hls`, `download-cache`) never go through `resolvePlaybackPlan`, so they get their own dry run in the same endpoint: the response has `experimental: true`, the `requested` settings (no config, no client identity), and `wouldCall`. `youtube-hls` adds the cache key, whether the playlist is cached and the settings it ignores; with `?probe=true` it also runs the real yt-dlp lookup and manifest fetch to report the variant and audio track it would choose (nothing is served or cached). `hls-byterange` adds the session key, delivery (plain file / manifest, MP4 / Matroska), any live session, and the stealth-cache state (finished, partial, resumable) with what the request would do. |
| `GET` | `/api/ytstream/mode-compatibility` | Session / token | Returns, for a given `mode`/`transcode`/`container`, which other fields are `required`/`optional`/`ignored`/`forced` — the single source of truth the Settings UI uses to enable/disable/badge fields, shared with `/simulate`'s narrative. |
| `GET` | `/api/ytstream/streams` | Session / token | Live snapshot of every currently-active `hls`/`hls-buffer` session — backs the Streaming page; live deltas arrive over the existing WebSocket. |
| `POST` | `/api/ytstream/streams/:streamId/stop` | Session / token | Force-stops one active stream (the Streaming page's Stop button). |
| `GET` / `DELETE` | `/api/ytstream/history` | Session / token | Paginated persisted audit trail of past playback sessions (`stream_history` table) — every mode, not just hls/hls-buffer. `DELETE` removes rows by `streamId`. |
| `GET` / `DELETE` | `/api/ytstream/:youtubeId/metadata-cache/*`, `/api/ytstream/metadata-cache*` | Session / token | Per-video and bulk read/clear for `youtube_metadata_cache` (learned duration/fps/formats, reused across streaming, downloads, and STRM generation). |
| `GET` / `DELETE` | `/api/ytstream/untracked-cache*`, `/api/ytstream/:youtubeId/untracked-cache` | Session / token | Read/clear the untracked hls-buffer cache (see "Storage & background processing" below). |

### Query parameters on `GET /api/ytstream/:youtubeId`

| Param | Values | Default | Notes |
|---|---|---|---|
| `mode` | `direct` \| `direct-redirect` \| `hls` \| `hls-buffer` | `ytstream.defaultMode` config (else `direct`) | Playback mode, see table above. An unrecognized value (e.g. a `.strm` written before a mode was retired) falls back to the current `ytstream.defaultMode` if that's still valid, else hardcoded `direct` — never a hardcoded lower-quality mode regardless of what's configured. |
| `quality` | e.g. `720`, `1080`, `best`, or any height | `ytstream.quality` config, else `preferredResolution`, else `720` | `mode=direct`/`direct-redirect` map to the plugin's progressive playback targets (`720` → BroadCompatibility, `1080` → Balanced1080p, `best` → MaximumQuality, capped at whatever progressive (already-muxed) format YouTube happens to serve — 720p max in practice). `hls`/`hls-buffer` instead fetch a **DASH** video-only + audio-only pair, so they aren't capped at progressive's ~720p ceiling and genuinely support `1080`/`1440`/`2160`. See `qualityStrictness` for how a mismatch with what's actually available is handled. |
| `qualityStrictness` | `fixed` \| `fallback` \| `best` | `ytstream.qualityStrictness` config (else `fallback`) | Controls how the `quality` height becomes a yt-dlp selector. `fallback` (default, long-standing behavior): chains from the exact height down to best-available. `fixed`: matches only that exact height — yt-dlp fails cleanly (no silent substitution) if this video doesn't have it. `best`: ignores `quality` entirely, always the mode's true best-available format. Never written into a generated `.strm` URL (server-side/config only). |
| `container` | `mp4` \| `ts` \| `mkv` | `ytstream.container` config (else `mp4`) | Used by `hls`/`hls-buffer`. **`mkv` has no effect on real HLS output today** — `getHlsContainerInfo` only special-cases `ts` (real MPEG-TS segments); every other value, `mkv` included, falls through to fragmented MP4 (`.m4s` + init segment, matching Jellyfin's own HLS output). The only place `mkv` actually changes anything is the probe-shortcut synthetic clip (see below), which can be muxed as Matroska. `ts` still means real MPEG-TS HLS segments as before. |
| `transcode` | `copy` \| `h264` | `ytstream.transcode` config (else `copy`) | Used by `hls`/`hls-buffer`. `copy` remuxes without re-encoding (fast); `h264` re-encodes to H.264/AAC for maximum client compatibility. `copy` is auto-upgraded to `h264` per-request when the selected format isn't actually H.264 (see "transcode=copy auto-upgrade" below). |
| `hardware` | `none` \| `qsv` \| `nvenc` \| `vaapi` \| `amf` | `ytstream.hardwareMode` (else `none`) | Only applies when `mode=hls`/`hls-buffer` and `transcode=h264` — this is the **encode** backend. See `hardwareDecodeMode` below for the independent decode-side setting. Prefer setting this in config rather than in `.strm` URLs; never written into a generated `.strm` URL. |
| `tuning` | `fast` \| `balanced` \| `quality` | `ytstream.tuning` (else `fast`) | Encoder speed/quality tier, only meaningful alongside `transcode=h264`. `fast` matches this app's original always-on defaults; `balanced`/`quality` trade real-time encode speed for picture quality — see "Encoding tuning" below. Never written into a generated `.strm` URL. |
| `t` | seconds | — | Optional start-time offset, honored only at initial session creation for `hls`/`hls-buffer` (ignored entirely once `calculatedLength=1`, where segment 0 must always start at video time 0). Not meaningful for `direct`/`direct-redirect`. |
| `calculatedLength` | `1`/`true`/`yes` or unset | `ytstream.calculatedLength` config (else off; **forced on** for `hls-buffer`) | See "Calculated length" below. The legacy query param name `fakeLength` is still accepted as a fallback for old `.strm` files. |

All of the query params above are ignored entirely when `ytstream.forceServerSettings` is `true` — every request then uses the current `ytstream` config as-is, regardless of what's in the request URL or an already-written `.strm` file. Off by default.

### Config (`config.json`)

```json
"ytstream": {
  "defaultMode": "direct",
  "container": "mp4",
  "probeShortcutContainerOverride": null,
  "transcode": "",
  "quality": null,
  "qualityStrictness": "fallback",
  "hardwareMode": "none",
  "hardwareDecodeMode": "none",
  "tuning": "fast",
  "vaapiQuality": null,
  "playerClient": "",
  "httpChunkSizeMiB": 0,
  "concurrentFragments": 0,
  "throttledRateKBps": 0,
  "socketTimeoutSeconds": 0,
  "calculatedLength": false,
  "hlsMasterPlaylist": true,
  "hotSwapToCache": false,
  "serveCachedFile": false,
  "probeShortcut": false,
  "forceServerSettings": false,
  "historyRetentionDays": 90,
  "hlsStorageLocation": "tmp",
  "backfillMissingSegments": false,
  "finalizeToMp4": false,
  "stealthCache": false,
  "debugLogging": false,
  "forceKeyframesByHardwareMode": {}
}
```

`calculatedLength` was renamed from `fakeLength`; configs saved under the old name are migrated automatically the next time Youtarr starts (see `configModule.js`). The single authoritative field list, with the exact default/type/interaction notes reproduced below, lives in `client/src/config/configSchema.ts`'s `ytstream:` block.

| Field | Values | Settings UI? | Notes |
|---|---|---|---|
| `defaultMode` | `direct` \| `direct-redirect` \| `hls` \| `hls-buffer` | Yes (dropdown offers Direct / Direct (redirect) / Enhanced HLS + Buffered only — `hls` is a valid value but hidden from the picker, since `hls-buffer` is a strict superset) | See the mode table above. |
| `container` | `mp4` \| `ts` \| `mkv` | Yes, but only interactive when Playback mode is `hls`/`hls-buffer` (the field is disabled for `direct`/`direct-redirect`, which never transcode); the `mkv` option is additionally hidden from the dropdown whenever `mode` is `hls`/`hls-buffer` since it has no effect there — in practice `mkv` can only be set by editing `config.json` directly | See the query-param table for what each container value actually maps to per mode. |
| `probeShortcutContainerOverride` | `mp4` \| `ts` \| `mkv` \| `null` | **No** — config.json only, debug escape hatch | **Currently inert.** Was a debug escape hatch for the old probe-shortcut synthetic-clip container/duration-patch path (mvhd/tkhd/mdhd for mp4, Segment Info Duration for mkv), abandoned in favor of `tryServeInstantHlsPlaylist` (see "Probe shortcut" below) - the field/code are kept, unused, in case that path is ever revisited. |
| `transcode` | `""` \| `copy` \| `h264` | Yes | Empty = derive from `videoCodec` (the regular download codec setting): `h264`/`h265` → force `h264`, otherwise → `copy`. |
| `quality` | `null` \| height \| `best` | Yes | `null` → `preferredResolution` / 720. |
| `qualityStrictness` | `fixed` \| `fallback` \| `best` | Yes | See the query-param table. |
| `hardwareMode` | `none` \| `qsv` \| `nvenc` \| `vaapi` \| `amf` | Yes | Encode backend; only used when `hls`/`hls-buffer` + `transcode=h264`. Same set as the Jellyfin plugin's managed transcode hardware modes. Server-side only (not written into `.strm` URLs). |
| `hardwareDecodeMode` | `none` \| `qsv` \| `nvenc` \| `vaapi` | Yes (labeled "not used in streaming" in Settings) | **Independent of `hardwareMode`.** Selects a hardware decode backend for the source video; every combination of encode/decode mode is valid (including software encode + hardware decode). No `amf` option — AMD decode acceleration on this app's Linux runtime goes through VAAPI instead. Primarily exercised by the "Test real-time tuning" benchmark's decode-timing measurement, not by real playback's own pipeline construction today (see the UI label). |
| `tuning` | `fast` \| `balanced` \| `quality` | Yes | Encoder speed/quality tier for `transcode=h264` (`server/modules/streamEncoderTuning.js`'s `TUNING_TIERS`). `fast` matches this app's original defaults; `balanced`/`quality` trade encode speed for picture quality and may not keep up in real time on modest hardware at high resolutions — see the "Test real-time tuning" benchmark in Settings. |
| `vaapiQuality` | `1`-`7` \| `null` | Yes (only shown when Hardware encoder = VAAPI) | `hardwareMode=vaapi` only: manual override for `h264_vaapi`'s driver-level `-quality` (compression_level) knob, separate from `-qp`. `null` (default) uses each tuning tier's own baked-in default (fast=7, balanced=4, quality=1). Ignored, harmlessly, on drivers that don't support it (e.g. AMD's Mesa radeonsi). |
| `playerClient` | `""` \| yt-dlp client list | Yes (power-user field, with a warning) | Passed as `--extractor-args youtube:player_client=<value>`. Empty = `default,-tv` (excludes the `tv` client — see Troubleshooting below). Server-side only. |
| `audioLanguage` | `""` \| language code (`en`, `de`, `pt-BR`...) | Yes (only shown for YouTube HLS passthrough) | `mode=youtube-hls` only. Many YouTube videos carry dubbed audio tracks; this picks the language served when the video offers it (a region-less code matches its regions). Empty, or a language the video doesn't offer, serves the original track (the one YouTube marks `original`, else the video's own language, else `DEFAULT=YES`, else the first). The log line `youtube-hls chose the audio rendition` lists what each video offered and what was chosen. |
| `youtubeHlsProxy` | `off` \| `proxy` \| `serve` | Yes (only shown for YouTube HLS passthrough; dropdown "Route through Youtarr") | `mode=youtube-hls` only. `off` (default): only the master playlist comes from Youtarr and the player fetches everything else from YouTube, so the Streaming page sees nothing after the first request. `proxy`: Youtarr also fetches and serves the chosen video and audio media playlists (`/api/ytstream/:id/yth/:key/video.m3u8`, `audio.m3u8`), so each play, its quality and its viewers show on the Streaming page; segments still go straight from YouTube. `serve`: additionally every segment URL points at Youtarr (`.../yth/:key/:kind/s<n>.ts`), which answers `302` to the real YouTube segment. No video bytes pass through Youtarr, so the Total and rate on the Streaming page are **estimates** (segment duration × the variant's bitrate, shown with a `~`) and the row carries the playback position. The proxy routes are public (players send no token) but only serve or redirect to playlists Youtarr resolved itself, looked up by an unguessable-by-URL registry key, so they cannot be pointed at other URLs. Playlists are held in memory for 30 minutes; an expired one answers 404 and playing again re-resolves it. In `serve` mode the row also has a segment strip and popup (the same ones hls uses): a filled cell is a video segment the player has requested, the darker cell is the most recent request, and the popup wording changes accordingly ("requested by the player", not "encoded"). Log lines: `routing the video and audio playlists through Youtarr`, `served a media playlist`, `playback started`, and per-segment `redirected a segment request` (debug). |
| `httpChunkSizeMiB` | number (MiB), `0`=off | Yes | `--http-chunk-size`. Splits yt-dlp's own fetch into ranged HTTP requests — yt-dlp's documented fix for YouTube's mid-download throttling. Only affects `hls`/`hls-buffer` (the only modes where yt-dlp itself streams media bytes); inert on `direct`/`direct-redirect`'s one-shot `-g` resolve. |
| `concurrentFragments` | number, `0`/`1`=off | Yes | `-N`/`--concurrent-fragments`. Fetches those chunks concurrently. Same `hls`/`hls-buffer`-only applicability as `httpChunkSizeMiB`. |
| `throttledRateKBps` | number (KB/s), `0`=off | Yes | `--throttled-rate`: yt-dlp re-extracts the URL if the measured rate drops below this. Passed on every mode's yt-dlp calls, but only actually measures anything on a call that streams real data (`hls`/`hls-buffer`); a no-op on `direct`/`direct-redirect`'s quick `-g` resolve. |
| `socketTimeoutSeconds` | number (seconds), `0`=off | Yes | `--socket-timeout`. Applies to every yt-dlp call this app makes for ytstream, including `direct`/`direct-redirect`'s `-g` resolve — a stall triggers this app's own retry/fallback sooner instead of hanging on yt-dlp's much longer built-in default. |
| `calculatedLength` | `true`/`false` | Yes, but the toggle itself was removed from the UI: every reachable mode now has a fixed status (`forced` for `hls-buffer`, `ignored` for `direct`/`direct-redirect`; plain `hls` — not reachable from the UI's mode picker — would be `optional`) | See "Calculated length" below. Renamed from `fakeLength`; old configs are migrated automatically. |
| `hlsMasterPlaylist` | `true`/`false` | Yes | `hls`/`hls-buffer` only. Wraps the real media playlist in a thin HLS master playlist instead of serving it directly. On by default. See "HLS master playlist" below. |
| `hotSwapToCache` | `true`/`false` | Yes (only meaningfully `optional` for plain `hls`, which the UI's mode picker doesn't offer — so effectively always disabled via the UI today, though the switch is still shown) | Pairs with `strm.cacheOnPlay`. Once the cache-on-play background download finishes, an active `hls` session switches its encode source from the network to the local cached file — same picture, no player-visible restart. No effect for `hls-buffer`, which has its own independent buffer-fetch mechanism instead. |
| `serveCachedFile` | `true`/`false` | **No** — config.json only | Checked first, before any mode/quality resolution or yt-dlp/ffmpeg work, on the first request of a fresh playback attempt for any mode (skipped once an `hls`/`hls-buffer` session is already running for this video — that path uses `hotSwapToCache` instead, which preserves segment/index continuity): if the video is already fully downloaded (cache-on-play or a genuine download), the real local file is served directly with real byte-range support instead of live-proxying/transcoding it again. Off by default. |
| `probeShortcut` | `true`/`false` | Yes | Detects Jellyfin's bare-UA metadata-probe request and serves the real session's own playlist instantly, before any segment is encoded, instead of making the probe wait for a full cold start. See "Probe shortcut" below. |
| `forceServerSettings` | `true`/`false` | Yes | When `true`, ignores every query-param override above (both a caller's own URL and whatever got baked into an already-written `.strm` file) and always uses this config as-is. Off by default. |
| `historyRetentionDays` | number (days) | Yes | How long `stream_history` rows are kept before the nightly 3:15 AM prune (`server/modules/cronJobs.js`); `<= 0`/unset falls back to 90. Governs the Streaming → History page only, not the live Streaming page (current sessions only, always visible regardless of this setting). |
| `hlsStorageLocation` | `tmp` \| `cache` | Yes | Where a live `hls`/`hls-buffer` session's segment files are written. `tmp` (default): the OS temp directory — fastest, but can be small/volatile on some hosts. `cache`: Youtarr's own persistent `.youtarr_ytstream_cache` folder instead. Segments are still deleted on the same idle-timeout schedule either way; this only changes where they live. Read fresh per session, no restart needed. For `hls-byterange` with `byteRangeDeliverAsFile`, `cache` also makes the encode write directly into the hidden stealth cache (`.byterange-cache/<key>.partial-<id>.mp4`, renamed into place once finished) instead of copying a temp file there. |
| `backfillMissingSegments` | `true`/`false` | Yes | `hls`/`hls-buffer` only, and only once a local source becomes available this session (cache-on-play hot-swap, or `hls-buffer`'s own buffer fetch). A forward seek permanently strands the segments it skipped over; when this is on, once the live encode reaches the real end of the video, a background pass fills those gaps from the local source so the rest of the session can seek anywhere instantly. Never affects live playback itself. |
| `finalizeToMp4` | `true`/`false` | Yes | `hls-buffer` only — its permanent output is always `.ts` (browsers can't play raw `.ts`; some players fall back to server-side transcode rather than direct-play it). When on, once that `.ts` is fully finalized, a background pass remuxes it (`-c copy`, no re-encode) into a sibling `.mp4`; playback then prefers that `.mp4` automatically. |
| `stealthCache` | `true`/`false` | Yes | `hls-buffer` only — keeps the buffered file out of the visible library folder entirely, in Youtarr's own hidden cache, so a media server's scanner never has a mid-flight file to discover and lose track of. See "Storage & background processing" below for the exact interaction with `finalizeToMp4`. |
| `debugLogging` | `true`/`false` | **No** — config.json only | This module's own per-request/per-segment diagnostic lines are too high-volume for `logger.info` by default; gating them behind the global Log Level=debug setting also turns on every other module's debug output. When on, ytstream's own lines print regardless of the global Log Level, without affecting any other module's verbosity. |
| `forceKeyframesByHardwareMode` | `{ [hardwareMode]: boolean }` | No direct editor — only ever set by the "Test HLS segment timing" benchmark button | Per-hardware-mode result of that benchmark: `true` means time-based forced keyframes (exact ~4s HLS segments regardless of source fps) were empirically confirmed working on this host for that mode; absent/`false` keeps the original fixed-frame-count GOP (exact only at 30fps, but a known-safe default). Never set by hand. |

## Calculated length (`calculatedLength`)

`calculatedLength` means different things in each mode: `direct`/`direct-redirect` ignore it entirely (the stream's own real length is always used, whatever the upstream reports); for `hls`/`hls-buffer` it's exact — a real, full-duration playlist built upfront, with missing segments filled in on demand (see "Enhanced HLS" further down).

### `hls` / `hls-buffer`

Without `calculatedLength`, the playlist only lists the segments ffmpeg
has actually written so far, growing as the encode progresses (`#EXT-X-
PLAYLIST-TYPE:EVENT`) — some players won't show a scrub bar for the
un-encoded remainder until the encode reaches it.

`calculatedLength=1` writes the **entire** playlist upfront instead: every
segment's `#EXTINF` computed from the video's real duration (looked up via
`yt-dlp --print duration`, cached per `youtubeId`), `#EXT-X-PLAYLIST-
TYPE:VOD` and `#EXT-X-ENDLIST` present from the very first response. This is
an exact playlist, not an estimate — every declared segment really is that
length; the only thing not yet true is that all of them exist on disk.

`hls-buffer` forces `calculatedLength` on unconditionally, regardless of
config/query — the field's dropdown was removed from Settings for this
reason (every reachable mode's status is now fixed: forced for
`hls-buffer`, ignored for `direct`/`direct-redirect`; only the
UI-unreachable plain `hls` mode leaves it genuinely optional).

The encode itself is unchanged: ffmpeg still only transcodes forward from
wherever playback actually is, one 4-second segment at a time
(`HLS_SEGMENT_DURATION_SECONDS`, `server/modules/ytstream/hlsEngine.js`).
When a player requests a segment that isn't on disk yet (a seek, forward
or backward, past the currently-encoded window), the segment route gives
the running encode a brief grace window (2.5s) in case it's about to get
there anyway, then restarts a fresh encode pass at that segment's exact
boundary timestamp (never mid-segment, so ffmpeg's own segment numbering
stays aligned with the pre-declared absolute index), and waits for the
file to appear before responding. Already-encoded segments — including
ones from a prior pass, before a seek moved the encode elsewhere — stay
servable indefinitely; nothing is ever deleted mid-session.

Tradeoffs: a seek past the encoded window has a few-seconds restart
latency (an HLS-idiomatic buffering pause, not a `502`/black screen). Two
viewers seeking to different, far-apart points in the same shared session
will fight over which point the single encode pass is currently serving —
each seek restarts it again. `?t=` is ignored when `calculatedLength=1`:
segment 0 must always correspond to video time 0 for the pre-declared
absolute segment indices to stay correct.

## Enhanced HLS (`mode=hls`)

A live pipe (the removed `mode=ffmpeg`) opened the HTTP response to the
player immediately, then made the player sit on that same connection
through the pipeline's full startup latency (two concurrent yt-dlp
extractions + ffmpeg spin-up) before any bytes arrived. Some players —
Jellyfin's own server-side transcoder being the case that motivated this —
won't tolerate that wait on an already-open connection and just abort and
retry forever: connect, wait, give up, reconnect, repeat, permanent black
screen.

`mode=hls` (and `hls-buffer`, which shares this same engine) avoids this
by matching the approach the reference
[kingschnulli/jellyfin-youtube-plugin](https://github.com/kingschnulli/jellyfin-youtube-plugin)
uses (`ManagedTranscodeService.cs`): ffmpeg writes real segmented HLS
output — a `playlist.m3u8` plus numbered segment files — to disk instead
of piping live, and **the HTTP response isn't sent at all until the first
real segment exists on disk** (polled, up to 45s). The wait happens
entirely on Youtarr's side, before the player's connection is ever
opened. Once ready, every subsequent request (the player re-polling the
growing playlist, or fetching a segment) is just an ordinary static-file
response — real `Content-Length`, no estimation: the player seeks by
requesting whatever segment covers the timestamp it wants.

Sessions are identified by a hash of `(youtubeId, quality,
qualityStrictness, transcode, hardwareMode, tuning, container,
playerClient, calculatedLength, buffer)`, so repeated requests for the
same effective params reuse the same session instead of spawning
duplicates, and every session is torn down (processes killed, directory
removed) after 2 minutes of no requests. Segment storage location is
`ytstream.hlsStorageLocation` — see the config table above.

If ffmpeg is unavailable, `mode=hls`/`hls-buffer` **fail outright with a
502** — unlike the old `mode=ffmpeg`, there is no automatic fallback to
`direct`. Each mode does exactly what it says or fails; the same applies
if a session never produces a first segment within the readiness window
(extraction failure, no available format, etc.) — the same
403/extraction-error retry-once-with-`android` logic other modes use also
applies here first.

**Needs an HLS-capable player.** `mode=hls`/`hls-buffer` serve a real
`.m3u8` manifest — playing it requires a player with an HLS engine
(Safari's native `<video>` support, or a library like `hls.js`, which is
what Jellyfin's own web client uses). A plain `<video src="...">` element
with no HLS engine (e.g. Youtarr's own in-app library preview player)
cannot play it at all.

## Probe shortcut (`probeShortcut`)

Jellyfin's own metadata-probe pass (ffprobe or similar) arrives with
libavformat's bare default User-Agent (`Lavf/x.y.z`) regardless of what a
`.strm`'s pipe-syntax UA override asked for, while real playback (ffmpeg
honors the override; a browser/app sends its own UA) never looks like
that — a documented Jellyfin behavior
([jellyfin/jellyfin#10175](https://github.com/jellyfin/jellyfin/issues/10175)).
Every `.strm` this app writes carries that pipe-syntax UA marker
unconditionally (not gated on this setting), which is what makes the
detection possible at all; `probeShortcut` only controls what happens
once a probe **is** detected.

**How it works today** (`tryServeInstantHlsPlaylist` in
`server/modules/ytstream/probeShortcut.js`): when it fires
(`isLikelyMetadataProbeRequest` matches, and the resolved mode/transcode
combination would actually transcode to H.264 — see Scope below), the
route gets or creates the SAME real hls/hls-buffer session a genuine
playback request for these exact params would use, and returns that
session's own real playlist immediately — before waiting for a single
segment to be encoded. This works because `calculatedLength` (forced on
for every hls/hls-buffer session) pre-builds the complete, real,
correctly-typed VOD playlist synchronously from the video's known
duration, before ffmpeg is even spawned (see "Calculated length" above).
The encode this kicks off keeps running in the background: a real
playback request for the same params reuses this exact session instead of
starting a second one, and an idle session nobody ever fetches a segment
from is reaped the same as any other.

**Scope**: only applies when the resolved mode actually transcodes
(`hls`/`hls-buffer`) *and* `transcode` resolves to `h264`. This restriction
predates the current design (it existed for the old synthetic-clip
approach, where a fixed output codec was required so one cached clip
could stand in for every video) and hasn't been revisited now that a
real per-video session is created either way — plausibly could also cover
`transcode=copy` for `hls`/`hls-buffer`. `direct`/`direct-redirect` never
transcode at all, so ffprobe reads the source's own real codec/container
directly; neither falls through to this shortcut.

**Superseded design (kept commented out in `probeShortcut.js`, not
deleted)**: the original implementation served a tiny synthetic clip (a
standalone mp4/mkv/ts file, generated once per `(hardwareMode, tuning,
width, height, container)` signature and cached to disk) with its
container-level duration field patched to the video's real known
duration. This was abandoned after live testing showed it was
structurally wrong for its own use case: the clip is a flat FILE, but
`hls`/`hls-buffer` genuinely serve an HLS *playlist* (m3u8 + segments) —
Jellyfin's ffprobe against the fake clip learned "flat file" and cached
that container classification at the library-item level, so a later
non-Direct-Play transcode opened the real (HLS-shaped) URL with the wrong
demuxer (`-f mp4` instead of `-f hls`) and failed outright. This is what
broke playback specifically for clients that don't do client-side Direct
Play (notably Apple clients), while clients that do (e.g. Windows/Chrome
via hls.js content-sniffing) were unaffected either way. The current
design fixes this by never answering with anything other than the real
session's real, correctly-typed response.

If a genuine complete local copy of the video already exists (a real
download, or a warm untracked hls-buffer cache), the probe is answered
with that real file directly instead — no session needed at all.

**Related fix**: `server/modules/strmMediaInfoCache.js`'s `.strmtool.json`
sidecar (written for the community
[StrmTool](https://github.com/jinlin-teck/StrmTool) Jellyfin plugin, which
reads it INSTEAD OF ever probing the `.strm` URL when present/valid) had
the exact same container-shape bug via a completely different path —
it declared the real session's flat `container` setting (`mp4`/`mkv`/`ts`)
even for `hls`/`hls-buffer`. Fixed to declare `container: "hls"` for those
modes regardless of the `container` config value. Unlike the probe path
above, a wrong value here can't self-correct on the next play attempt —
the plugin never probes at all while its cache file is valid.

## HLS master playlist (`hlsMasterPlaylist`)

On by default. Wraps the real media playlist (`#EXTM3U`/`#EXTINF`/segment
list) in a thin master playlist — `#EXT-X-STREAM-INF:BANDWIDTH=...,
RESOLUTION=WxH` pointing at the actual media playlist — instead of serving
the media playlist directly at the top-level ytstream URL. This is the
more broadly-compatible, spec-idiomatic HLS shape (Apple's own HLS
Authoring Guidelines recommend a master playlist even for a single
rendition), and it stops Jellyfin guessing a ~20 Mbps default bandwidth on
a bare media playlist, which can force needless transcoding on
bandwidth-limited clients.

`RESOLUTION` comes from the same source-resolution lookup the real
encoder itself uses (`resolveVideoTargetResolution` + `capResolutionToHeight`).
`BANDWIDTH` is a heuristic estimate per resolution tier
(`server/modules/ytstream/hlsMasterPlaylist.js`), since real encodes are
CRF/QP-quality-targeted rather than fixed-bitrate — there is no measured
value to report. `CODECS` is deliberately never declared: the exact
profile/level string (e.g. `avc1.640028`) depends on which encoder
actually produced the output (libx264 vs VAAPI/QSV/NVENC/AMF can all
differ), and declaring it wrong would misrepresent the stream the same
way the old probe-shortcut synthetic clip did.

The nested media-playlist URL the master points at
(`.../hls/<sessionKey>/playlist.m3u8`) is served by the same asset route
that already serves segments — its relative segment/init references
resolve correctly against that URL without needing any rewriting.
Applies identically to both the real playback path and the probe-shortcut
instant-playlist path above, so a probe and the real play that follows it
always get the same top-level response shape.

## Using this as a `.strm` target

`server/modules/strmGenerator.js` supports `strm.target: "ytstream"`
directly — no need to hand-write `.strm` files or point
`strmGenerator`'s proxy builder anywhere yourself. When STRM materialize
runs with this target, the generated `.strm` file's URL carries only
`mode`, `quality`, `container`, `transcode`, and (if true)
`calculatedLength` — **not** `qualityStrictness`, `hardware`, `tuning`, or
`playerClient`, which are server-side/config-only and never baked into a
`.strm` file:

- **`mode`** — `ytstream.defaultMode` (config), default `direct`
- **`quality`** — `strm.quality` override, else `ytstream.quality` override,
  else `preferredResolution` (the same resolution a full download would use)
- **`container`** — `ytstream.container` (config), default `mp4`
- **`transcode`** — `ytstream.transcode` override if set, else derived from
  `videoCodec` (`default` → `copy`, `h264`/`h265` → `h264`) — i.e. it
  matches whatever codec preference the user already set for regular
  downloads

Every `.strm` file also carries the pipe-syntax custom User-Agent
(`url|User-Agent=...`) this route's probe detection relies on — see
"Probe shortcut" above; this happens unconditionally, independent of
whether `probeShortcut` itself is on.

Example resulting `.strm` contents for a channel with
`preferredResolution: "1080"`, `videoCodec: "h264"`, and
`ytstream.defaultMode: "hls-buffer"`:

```
http://192.168.1.10:3011/api/ytstream/dQw4w9WgXcQ?mode=hls-buffer&quality=1080&container=mp4&transcode=h264|User-Agent=...
```

In Jellyfin/Emby/Kodi, point a library item at this the same way you would
at `/api/strm/<id>` (see `docs/STRM.md`) — it's produced automatically once
`strm.target` is set to `ytstream`.

## Examples (manual/curl)

```bash
# Simple/direct: expect a 302 to a googlevideo.com URL
curl -I "http://localhost:3087/api/ytstream/dQw4w9WgXcQ?mode=direct-redirect"

# direct: proxied progressive stream
curl "http://localhost:3087/api/ytstream/dQw4w9WgXcQ" -o test.mp4

# Enhanced HLS + Buffered, force re-encode + MPEG-TS live segments
curl "http://localhost:3087/api/ytstream/dQw4w9WgXcQ?mode=hls-buffer&transcode=h264&container=ts"
```

## Byte-range Plain file, MP4 or Matroska (`mode=hls-byterange` + `byteRangeDeliverAsFile`)

yt-dlp video + audio are piped into one ffmpeg that writes a single growing file, served with Range support (and kept in the hidden stealth cache). The Container dropdown picks the output:

- **MP4** (default): fragmented MP4. Players must read the whole file to learn the exact length, so the final size is declared up front and the header patched where possible.
- **MKV** (`container=mkv`): `-f matroska` written directly (no HLS muxer/playlist). The real duration is written into the Matroska Segment Info (`Duration`, or ffmpeg's reserved 11-byte Void slot), the final size is declared up front from yt-dlp's stream sizes (0.5% margin, measured overhead is ~0), and the leftover is padded with an EBML Void element when the encode ends. Reads past the written bytes wait for the encode to catch up, so forward seeks work. The mkv cache key differs from the mp4 one and its cache files are `.mkv` (older ones named `.mp4` are still found).

  **MKV resume** (`byteRangeResumeCache`): a partial `.mkv` is extended by byte splicing, with no ffmpeg/ffprobe step. The partial is scanned for its complete clusters; the cut is the last cluster that starts on a video keyframe at least 12 s before its end. The base is served at once, yt-dlp restarts at that cluster's timecode (`-copyts`, so timecodes are absolute), and the resume pass's own header and Cues are left out. The seam is checked: the resume file's first cluster must start within 500 ms of the cut, or the resume is abandoned, the partial is flagged `mkvResumeFailed` in its sidecar and the next play does a fresh encode. The spliced result has no Cues (seeking works the same way as on a growing file). Debug lines: "mkv resume - scanned the cached partial", "mkv resume seam verified", "mkv resume spliced".

**Cache hits on the Streaming page:** when a request is answered from a finished stealth-cache entry (no encode session), Youtarr streams the file itself. That shows as a Live Streams row with mode `byterange-cache-hit` (one row per cache entry, shared by all its requests; kept while any request is in flight and for 15 s after the last, so a seek's abort-and-reconnect doesn't make it flicker; a paused player keeps its connection open; Stop cuts the transfers) and gets a Stream History row. Debug logging: per request (`range`, `sentMB`, `MBps`), a 5 s throughput heartbeat while reading (`readMB`, `MBps`, `totalMB`), and an info summary when the row ends (`totalMB`, `averageMBps`, `requests`). A finished encode session's own row is handed over to the cache-hit row on the first cache hit, and a finished session is freed 20 s after the player's last request closes (a session still encoding is left to the normal idle timeout).

Debug lines: "output container decision", "mkv output ready to serve", "header duration patch attempt" (logs `infoHex` if the slot can't be found), "declaring the final file size up front", "padded the finished file to its declared size".

## Choosing a playback mode

- Start with `direct`. It's zero-CPU-overhead and works for most progressive
  formats up to 1080p.
- Switch to `hls`/`hls-buffer` when:
  - You want quality above what progressive formats offer (DASH video+audio
    muxed via ffmpeg can reach much higher bitrates/resolutions).
  - A player's format support doesn't match what YouTube serves at your
    requested quality (use `transcode=h264` to normalize).
  - A player won't tolerate a live pipe's startup latency at all — this is
    the only real-segmented option left in this codebase.
  - You want the whole video permanently cached locally after one play —
    use `hls-buffer` specifically.
- `hls`/`hls-buffer` cost CPU per concurrent stream. `transcode=copy` is
  cheap (just remuxing); `transcode=h264` is a real encode and will use
  significant CPU, especially at higher resolutions/quality tiers.

## Format selectors (aligned with the Jellyfin plugin)

These are the same yt-dlp `-f` strings used by
[kingschnulli/jellyfin-youtube-plugin](https://github.com/kingschnulli/jellyfin-youtube-plugin)
`YtDlpService.cs` (`server/modules/ytstream/formatSelection.js`):

| Mode | quality | Selector |
|---|---|---|
| `direct`/`direct-redirect` | `720` (default) | `b[protocol!*=m3u8][ext=mp4][height=720]/…` (BroadCompatibility720p) |
| `direct`/`direct-redirect` | `1080` | `b[height=1080]/b[height=720]/…` (Balanced1080p) |
| `direct`/`direct-redirect` | `best`, or `qualityStrictness=best` | `b` (MaximumQuality — may return HLS) |
| `hls`/`hls-buffer` | any | DASH pair: `bv*[height<=N][vcodec^=avc1]/bv*[height<=N]` (video-only) + `ba[acodec^=mp4a]/ba` (audio-only), each fetched by its own `yt-dlp -o -` process and muxed by ffmpeg. |

`qualityStrictness=fixed` swaps the height comparison from `<=N` to `=N`
(no fallback clause) for both families; `qualityStrictness=best` drops the
height filter entirely (`bv*[vcodec^=avc1]/bv*` for the DASH pair, bare
`b` for direct).

## `transcode=copy` auto-upgrade

The DASH video-only selector (`bv*[height<=N][vcodec^=avc1]/bv*[height<=N]`)
*prefers* an H.264 (`avc1`) track but falls back to whatever's available at
that height if there's no H.264 option — commonly VP9 or AV1 for videos
that only got a native encode above 720p. `transcode=copy` remuxes
whatever format got selected without re-encoding, so for one of these
videos it silently produces a stream carrying VP9/AV1 inside an MP4/HLS
container. That's not broadly compatible: browsers and players vary in
VP9/AV1-in-MP4 support, and — the case that motivated this — Jellyfin's
own client can decide it needs to transcode server-side instead of playing
it directly, then fail trying to read our stream as *its own* ffmpeg's
input.

To avoid silently handing out an unplayable stream, `hls`/`hls-buffer`
both probe the actual codec of the format `transcode=copy` would use
(`yt-dlp -f <selector> --print vcodec`, cached per `(youtubeId, quality,
playerClient, qualityStrictness)`) before spawning anything. If it isn't
H.264, the request is transparently upgraded to `transcode=h264` (a real
re-encode) for that response; if it's already H.264, `copy`'s speed is
unaffected. `transcode=h264` requested directly skips this probe entirely.
The probe adds one short yt-dlp call to a cold start (a couple of seconds,
cached for repeat requests to the same video/quality); if the probe itself
fails, the request proceeds with `copy` as originally requested rather
than blocking playback on the check.

## Hardware encoding (Enhanced + H.264)

When `mode=hls`/`hls-buffer` and `transcode=h264`, `ytstream.hardwareMode`
selects the **encode** backend. Arguments match
`ManagedTranscodeService.AddVideoEncoderArguments` in the Jellyfin plugin,
parameterized by `ytstream.tuning` (`server/modules/streamEncoderTuning.js`):

| Mode | ffmpeg encoder | `fast` tier | `balanced` tier | `quality` tier |
|---|---|---|---|---|
| `none` (default) | `libx264` | preset veryfast, CRF 23 | preset faster, CRF 21 | preset medium, CRF 19 |
| `qsv` | `h264_qsv` | global_quality 21 | global_quality 19 | global_quality 17, look-ahead |
| `nvenc` | `h264_nvenc` | preset p5, cq 21 | preset p6, cq 19 | preset p7, cq 17 |
| `vaapi` | `h264_vaapi` | qp 21, compression level 7 | qp 18, level 4 | qp 15, level 1 |
| `amf` | `h264_amf` | quality speed, qvbr 21 | quality balanced, qvbr 19 | quality quality, qvbr 17 |

`fast` matches this app's original always-on defaults (unchanged
behavior for anyone who never touches `tuning`); `balanced`/`quality`
trade encode speed for picture quality and may not keep up in real time
at high resolutions on modest hardware — use Settings → Streaming →
"Test real-time tuning" to measure what's actually safe on a given host
before relying on a higher tier. `vaapi`'s compression level can be
overridden independently via `ytstream.vaapiQuality` (1–7).

Audio is always AAC stereo 192k 48 kHz when re-encoding. Video is scaled to
the requested quality height, decrease-only (never upscaled).

`ytstream.hardwareDecodeMode` (`none`/`qsv`/`nvenc`/`vaapi`) is a
**separate, independent** setting for the decode side — see the config
table above. It's exercised by the "Test real-time tuning" benchmark, not
by real playback's pipeline construction.

Override the encode backend per request for testing:

```bash
curl "http://localhost:3087/api/ytstream/VIDEO_ID?mode=hls-buffer&transcode=h264&hardware=nvenc"
```

Docker hosts must pass through the GPU device (e.g. `--device /dev/dri` for
VAAPI/QSV, or NVIDIA Container Toolkit for NVENC).

If Youtarr is running as a non-root user (`YOUTARR_UID`/`YOUTARR_GID` in
`docker-compose.yml`), passing the device through is not enough by itself:
`/dev/dri/card0` and `/dev/dri/renderD128` are normally owned `root:video` and
`root:<render-group>` and are not world-writable, so that user also needs to
be a member of those groups to open the device at all — otherwise every
QSV/VAAPI row in Configuration's Hardware Capabilities test fails as
"Unsupported" even though the device is present and the drivers are
installed. Add both groups via Compose's `group_add` (see the commented
example in `docker-compose.yml`); the render group's GID is host-specific, so
check it with `ls -la /dev/dri` or `getent group render` on the host rather
than assuming a value.

## Storage & background processing

- **`hlsStorageLocation`** — where a live session's segment files live
  while playback is active. `tmp` (default) is the OS temp directory;
  `cache` is Youtarr's own persistent `.youtarr_ytstream_cache` folder.
  Neither location is under `tempPathManager`'s temp base, which gets
  wiped wholesale on every download-job start — that would delete
  segments out from under an active session.
- **`backfillMissingSegments`** — a forward seek during `hls`/`hls-buffer`
  playback permanently strands whatever segments lay between the old
  encode pass and the new target. When on, once the live encode reaches
  the real end of the video *and* a local source has become available
  this session (cache-on-play's hot-swap, or `hls-buffer`'s own buffer
  fetch), a background pass fills those gaps from that local source —
  never a fresh network pull, and never blocking or slowing live
  playback.
- **`finalizeToMp4`** — `hls-buffer`'s permanent output is always `.ts`
  (a plain `-c copy` MPEG-TS remux, since that container is safely
  readable while still being appended to). Browsers can't play raw `.ts`
  directly, and some players fall back to server-side transcoding rather
  than direct-playing it. When on, once the `.ts` is fully finalized, a
  background pass remuxes it (no re-encode) into a sibling `.mp4`, which
  playback then prefers automatically.
- **`stealthCache`** — keeps an `hls-buffer` fetch's output out of the
  visible library folder entirely, in the same hidden cache untracked
  videos already use, so a media server's scanner never sees a
  mid-flight file to index and then lose track of. Interaction with
  `finalizeToMp4`: with both on, the hidden `.ts` is swapped in place for
  its `.mp4` remux once ready (still hidden, `.ts` deleted) — never
  promoted to the library. With `stealthCache` off but `finalizeToMp4`
  on, the `.ts` still buffers into the hidden cache first, but the
  finished `.mp4` **is** promoted straight into the library once ready —
  a media server only ever sees the `.strm` replaced by the finished
  `.mp4`, never an intermediate `.ts`.
- **Untracked buffer cache** — a video with no library `Video` row (an
  untracked NZB grab, or one disowned via `importStrategy: 'untracked'`)
  still gets buffer-fetched by `hls-buffer`, but lands in Youtarr's own
  cache keyed by YouTube ID instead of a library location: no Video/Job
  row, invisible in the library or Download History, purely a
  same-video-again speed-up. Manage it via Settings (file count/size,
  Delete button) or `GET`/`DELETE /api/ytstream/untracked-cache`.
- **Stream history retention** — `historyRetentionDays` (default 90)
  governs the nightly 3:15 AM prune of the `stream_history` table that
  backs Streaming → History. Does not affect the live Streaming page,
  which only ever shows currently-active sessions regardless of this
  setting.

## Limitations

- `hls`/`hls-buffer` streams are only seekable within what's already been
  encoded — a seek ahead of the encode's current progress stalls until it
  catches up (or, without `calculatedLength`, restarts the encode at the
  new target). `calculatedLength` (forced on for `hls-buffer`) makes the
  *playlist* exact/full-length upfront, but doesn't change this.
- `mkv` as a `container` value only affects the probe-shortcut synthetic
  clip, never real `hls`/`hls-buffer` segment output (always MPEG-TS for
  `ts`, fragmented MP4 for everything else). This is a common point of
  confusion — see the query-param table above.
- Like `/api/strm`, playback still depends on yt-dlp + (optionally)
  cookies for age-restricted/members-only content — see `docs/STRM.md`'s
  Limitations section, which applies here too.

## Troubleshooting

### "The page needs to be reloaded." / stream fails immediately

```
[youtube] JID44mBa9pc: Downloading tv downgraded player API JSON
ERROR: [youtube] JID44mBa9pc: The page needs to be reloaded.
```

This is a yt-dlp/YouTube extraction error, not a bug in the pipe/proxy
plumbing — it happens before any media bytes are produced. It's almost
always one of:

1. **yt-dlp's `tv` client got rejected** by YouTube's session/PO-token
   check. This is the most common cause and is why `ytstream.playerClient`
   defaults to `default,-tv` (yt-dlp's normal client list minus `tv`) —
   `buildBaseArgs()` always sends `--extractor-args
   youtube:player_client=...`, so a fresh checkout already has this fix.
   If you're seeing this on an older config, either leave
   `ytstream.playerClient` blank (picks up the new default) or set it
   explicitly, e.g. `"android"` or `"web,android"`, in Settings →
   Streaming (or `config.json`).
2. **Automatic retry**: every mode retries once, automatically, with
   `player_client=android` if the first attempt fails with this signature
   and no bytes have reached the client yet. Check the logs for
   `ytstream: ... retrying once with player_client=android` — if you see
   that line followed by success, no action is needed.
3. **Outdated yt-dlp.** YouTube changes extraction frequently; if the
   error persists after the client-list fix, update yt-dlp first
   (Settings → yt-dlp → Update, or `yt-dlp -U` / re-pull the Docker
   image) before changing anything else.
4. **Missing/expired cookies** for content that needs them (age-restricted,
   members-only). Re-upload cookies in Settings → Cookies.

If it still fails after updating yt-dlp and trying an explicit
`playerClient` override, run the debug endpoints to see what's actually
happening for that video, without spawning a real session:

```bash
# List every format yt-dlp sees for this video
curl "http://localhost:3087/api/ytstream/VIDEO_ID/formats"

# Dry-run the mode/quality/transcode decision itself (add ?probe=true for a full trace)
curl "http://localhost:3087/api/ytstream/VIDEO_ID/simulate?probe=true"
```

### ffmpeg logs `Invalid data found when processing input`

In `mode=hls`/`hls-buffer`, this means yt-dlp produced no usable bytes on
its stdout before exiting (almost always the same root cause as above —
check the yt-dlp error just above this line in the logs, not the ffmpeg
line itself).

## Installing ffmpeg

`direct`/`direct-redirect` need nothing beyond what Youtarr already
requires. `hls`/`hls-buffer` need the `ffmpeg` binary on `PATH` for the
Youtarr server process, the same way Youtarr already needs `yt-dlp` on
`PATH`.

### Docker (this repo's `Dockerfile`)

Already handled — no action needed. The release stage installs both
`ffmpeg` and `yt-dlp`:

```dockerfile
# ffmpeg (apt, from Debian repos)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    atomicparsley \
    curl \
    unzip \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp (downloaded binary, same stage)
RUN mkdir -p /opt/yt-dlp && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /opt/yt-dlp/yt-dlp && \
    chmod 0777 /opt/yt-dlp /opt/yt-dlp/yt-dlp
ENV PATH="/opt/yt-dlp:${PATH}"
```

If you build a custom image and strip apt caches/layers aggressively,
double check `ffmpeg -version` still works inside the built image:

```bash
docker exec -it <youtarr-container> ffmpeg -version
docker exec -it <youtarr-container> yt-dlp --version
```

### Bare-metal / dev (no Docker)

Install ffmpeg the same way you installed yt-dlp for local development —
whatever your OS package manager provides is fine; the route just needs
`ffmpeg` to be resolvable on `PATH` for the Node process.

**Debian/Ubuntu**
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
```

**Fedora/RHEL**
```bash
sudo dnf install -y ffmpeg   # may need the RPM Fusion repo enabled first
```

**macOS (Homebrew)**
```bash
brew install ffmpeg
```

**Windows**
```powershell
# via winget
winget install --id Gyan.FFmpeg -e
# or via Chocolatey
choco install ffmpeg
```
Or download a build from https://www.gyan.dev/ffmpeg/builds/ and add its
`bin/` folder to your `PATH` environment variable — the same manual-PATH
approach used for a standalone `yt-dlp.exe` if you're not using the
Docker image.

### Verify it's on PATH

```bash
ffmpeg -version
```

If this fails, `server/modules/ytstream/processRegistry.js` detects it
automatically (`isFfmpegAvailable()`) and `mode=hls`/`hls-buffer` requests
fail outright with a 502 rather than silently falling back to a different
mode — see "Enhanced HLS" above.

## Integration points in code

- `server/routes/ytstream.js` — route wiring: the main resolve+play
  handler, `/formats` and `/simulate` debug endpoints, `/mode-compatibility`,
  `/streams` (live) and `/history` (persisted audit trail), metadata-cache
  and untracked-cache CRUD routes, the HLS asset (playlist/segment) route.
- `server/modules/ytstream/configResolution.js` — valid mode/container/
  transcode value lists, the `forceServerSettings`-aware query-override
  resolver, and `getModeFieldCompatibility` (single source of truth for
  which fields are required/optional/ignored/forced per mode, shared by
  the Settings UI, `/simulate`, and real enforcement).
- `server/modules/ytstream/playbackPlan.js` — `resolvePlaybackPlan` (the
  mode/quality/transcode/calculatedLength decision engine shared by the
  real route and `/simulate`), duration/codec/best-height resolution and
  their caches.
- `server/modules/ytstream/directMode.js` — `direct`/`direct-redirect`
  resolve, proxy, and 302-redirect logic.
- `server/modules/ytstream/hlsEngine.js` — the `hls`/`hls-buffer` session
  lifecycle: spawn/restart/backfill/hot-swap of the yt-dlp+ffmpeg encode
  pass, the calculated-length full-playlist builder, the segment-serving
  route, the independent `hls-buffer` fetch.
- `server/modules/ytstream/cacheFinalize.js` — serving an already-cached
  file directly (`serveCachedFile`), and finalizing a completed
  `hls-buffer` `.ts` into whichever permanent form applies
  (`finalizeToMp4`/`stealthCache` interactions).
- `server/modules/ytstream/probeShortcut.js` — the metadata-probe
  detector, synthetic clip generator/cache, and container duration
  patching.
- `server/modules/ytstream/formatSelection.js` — yt-dlp format selectors
  per mode/quality/`qualityStrictness`.
- `server/modules/ytstream/ytdlpArgs.js` — shared yt-dlp base argument
  construction (cookies/proxy/player-client/network-tuning flags).
- `server/modules/ytstream/activeStreams.js` — live session tracking (the
  Streaming page) and `stream_history` persistence.
- `server/modules/streamEncoderTuning.js` — hardware encoder argument
  construction per `hardwareMode`/`tuning`/`vaapiQuality`, shared with the
  "Test real-time tuning" benchmark.
- `server/modules/configModule.js` — reused for `getCookiesPath()` and
  `getConfig()`.
- `server/modules/cronJobs.js` — nightly `stream_history` prune
  (`historyRetentionDays`).
- `server/routes/index.js` — registers the ytstream routes.
- `server/modules/strmGenerator.js` — `target: "ytstream"` branch that
  builds the `/api/ytstream/...` URL for `.strm` files, deriving
  `quality`/`transcode` from the user's download settings
  (`preferredResolution`/`videoCodec`) when not explicitly overridden.
- `client/src/config/configSchema.ts` — the authoritative `ytstream`
  config field list, with inline comments this doc mirrors.
- `client/src/components/Configuration/sections/YtstreamSettingsSection.tsx`
  — Settings UI for `ytstream.*` options; also the source of truth for
  which fields are UI-exposed vs. config.json-only (see the config table
  above).
- `client/src/components/Configuration/sections/StrmSettingsSection.tsx`
  — renders `YtstreamSettingsSection` when `strm.target === 'ytstream'`.
