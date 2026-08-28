# YouTube direct/ffmpeg streaming (`/api/ytstream`)

This is an **additive** playback route alongside the existing `.strm`
proxy (`server/routes/strm.js`, see `docs/STRM.md`). Nothing in `strm.js`,
`strmGenerator.js`, or `strmMaterializer.js` was changed to add this —
it's a new route file (`server/routes/ytstream.js`) you can use instead of,
or alongside, STRM files.

It's modeled on the two playback modes from
[kingschnulli/jellyfin-youtube-plugin](https://github.com/kingschnulli/jellyfin-youtube-plugin):

| Plugin mode | This route (`?mode=`) | What it does | Needs ffmpeg? |
|---|---|---|---|
| Simple (default) | `direct` | Resolves one progressive URL with yt-dlp and proxies it straight through (Range-forwarded, real Content-Length). | No |
| Enhanced | `ffmpeg` | DASH video-only + audio-only, each fetched by its own `yt-dlp -o -` process and piped live into ffmpeg's extra file descriptors, which muxes them straight into the HTTP response as a single chunked, non-seekable connection. Falls back to `direct` automatically if ffmpeg is missing, and retries once with an alternate yt-dlp client on a 403/extraction-error signature (see Troubleshooting). Optional `calculatedLength`/`ytstream.calculatedLength` approximates seekability — see below. | Yes |
| Enhanced HLS | `hls` | Same DASH fetch as `ffmpeg`, but ffmpeg writes real segmented HLS output (`.m3u8` + segment files) to disk instead of piping live, and the response isn't sent until the first segment actually exists. Natively seekable within whatever's already been encoded, with no live-pipe startup-latency exposed to the player at all — see "Enhanced HLS" below for why this exists and its tradeoffs. Optional `calculatedLength`/`ytstream.calculatedLength` pre-declares the *entire* real-duration playlist upfront so the player gets a full scrub bar immediately, restarting the forward encode on demand for a seek past what's been produced so far — see "Calculated length" below. | Yes |

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

### Query parameters on `GET /api/ytstream/:youtubeId`

| Param | Values | Default | Notes |
|---|---|---|---|
| `mode` | `direct` \| `ffmpeg` \| `hls` | `ytstream.defaultMode` config (else `direct`) | Playback mode, see table above. |
| `quality` | e.g. `720`, `1080`, `best`, or any height | `ytstream.quality` config, else `preferredResolution`, else `720` | `mode=direct` maps to the plugin's progressive playback targets (`720` → BroadCompatibility, `1080` → Balanced1080p, `best` → MaximumQuality, capped at whatever progressive (already-muxed) format YouTube happens to serve — 720p max in practice). `mode=ffmpeg`/`hls` instead fetch a **DASH** video-only + audio-only pair (via two `yt-dlp -o -` processes muxed by ffmpeg — see Integration points), so they aren't capped at progressive's ~720p ceiling and genuinely support `1080`/`1440`/`2160`. |
| `container` | `mp4` \| `ts` | `ytstream.container` config (else `mp4`) | Used in `mode=ffmpeg`/`hls`. For `ffmpeg`: `mp4` is fragmented (browser `<video>` friendly), `ts` is MPEG-TS. For `hls`: `mp4` → fMP4 segments (`.m4s` + an init segment, matching Jellyfin's own HLS output), `ts` → MPEG-TS segments (the traditional, most universally compatible HLS format). |
| `transcode` | `copy` \| `h264` | `ytstream.transcode` config (else `copy`) | Used in `mode=ffmpeg`/`hls`. `copy` remuxes without re-encoding (fast); `h264` re-encodes to H.264/AAC for maximum client compatibility. `copy` is auto-upgraded to `h264` per-request when the selected format isn't actually H.264 (see "transcode=copy auto-upgrade" below) — the requested value is a preference, not a guarantee. |
| `t` | seconds | — | Optional start-time offset (`-ss`). In `mode=ffmpeg`, re-sent on every seek to restart the pipeline (ignored if `calculatedLength=1` and the request has a `Range` header, which takes over as the seek source instead). In `mode=hls`, only affects the initial spawn of a session — seeking afterward is handled natively by the player requesting different segments, no restart needed. Ignored entirely if `calculatedLength=1` in `mode=hls` (segment 0 always starts at video time 0 — see "Calculated length" below). |
| `hardware` | `none` \| `qsv` \| `nvenc` \| `vaapi` \| `amf` | `ytstream.hardwareMode` (else `none`) | Only applies when `mode=ffmpeg`/`hls` and `transcode=h264`. Prefer setting this in config rather than in `.strm` URLs. |
| `calculatedLength` | `1`/`true`/`yes` or unset | `ytstream.calculatedLength` config (else off) | Used in both `mode=ffmpeg` and `mode=hls`, with different meanings per mode — see "Calculated length" below. The legacy query param name `fakeLength` (from before this option was renamed) is still accepted as a fallback, so `.strm` files written before the rename keep working. |

All of the query params above are ignored entirely when `ytstream.forceServerSettings` is `true` — every request then uses the current `ytstream` config as-is, regardless of what's in the request URL or an already-written `.strm` file. Off by default.

### Config (`config.json`)

```json
"ytstream": {
  "defaultMode": "direct",
  "container": "mp4",
  "transcode": "",
  "quality": null,
  "hardwareMode": "none",
  "playerClient": "",
  "calculatedLength": false,
  "forceServerSettings": false
}
```

`calculatedLength` was renamed from `fakeLength`; configs saved under the old name are migrated automatically the next time Youtarr starts (see `configModule.js`).

| Field | Values | Notes |
|---|---|---|
| `defaultMode` | `direct` \| `ffmpeg` \| `hls` | Simple vs Enhanced (live pipe) vs Enhanced HLS (segmented) |
| `container` | `mp4` \| `ts` | Enhanced/Enhanced HLS output container — see the query-param table for what each maps to per mode |
| `transcode` | `""` \| `copy` \| `h264` | Empty = derive from `videoCodec` |
| `quality` | `null` \| height \| `best` | null → preferredResolution / 720 |
| `hardwareMode` | `none` \| `qsv` \| `nvenc` \| `vaapi` \| `amf` | Only used when Enhanced/Enhanced HLS + `transcode=h264`. Same set as the Jellyfin plugin's managed transcode hardware modes. Server-side only (not written into `.strm` URLs). |
| `playerClient` | `""` \| yt-dlp client list | Passed as `--extractor-args youtube:player_client=<value>`. Empty = `default,-tv` (excludes the `tv` client — see Troubleshooting below). Server-side only. |
| `calculatedLength` | `true`/`false` | Used by both Enhanced and Enhanced HLS, with different meanings per mode. See "Calculated length" below. |
| `forceServerSettings` | `true`/`false` | When `true`, ignores every query-param override above (both a caller's own URL and whatever got baked into an already-written `.strm` file) and always uses this config as-is. Off by default. |

## Calculated length (`calculatedLength`)

`calculatedLength` means different things in each mode: in `mode=ffmpeg` it's an
*estimate* layered on top of a live pipe (below); in `mode=hls` it's exact —
a real, full-duration playlist built upfront, with missing segments filled
in on demand (see "Enhanced HLS" further down).

### `mode=ffmpeg`

`mode=ffmpeg`'s output is a live transcode: chunked, unknown final size,
not byte-range seekable. Most browsers tolerate that fine, but some
players — Jellyfin included — won't treat a source like that as directly
playable and instead fall back to running their own server-side
transcode on top of ours (double transcoding, plus whatever compatibility
issues that adds).

`calculatedLength=1` (or `ytstream.calculatedLength: true`) makes `mode=ffmpeg`
report a synthetic `Content-Length`/`Accept-Ranges: bytes`, estimated
from the video's real duration and a rough bytes/sec figure for the
requested resolution (deliberately padded upward — see the tradeoff
below). A `Range: bytes=N-` request is converted back into an estimated
time offset and restarts the yt-dlp+ffmpeg pipeline seeked there with
`-ss`, so the response looks and behaves like an ordinary seekable file
to anything issuing standard Range-based seeks.

This is fundamentally an approximation, not a real seekable file, with
two concrete tradeoffs:

- **Seeking still isn't instant.** Every seek is a Range request that
  restarts the whole pipeline at the estimated timestamp — the same
  multi-second startup latency as any other cold start here, just
  triggered by a `Range` header instead of the `?t=` query param.
- **The declared length is an estimate**, not a measurement — the real
  encoded size is only known once the transcode finishes, and CRF/VBR
  encoding means the byte↔time mapping isn't perfectly linear either.
  The estimate is biased high on purpose (an under-estimate would
  truncate real content), and the response is zero-padded to exactly
  match whatever length was declared if the real encode finishes early
  — so playback won't error out, but the last few seconds of a session
  can be silence/black frames past where the real content actually ended.

Turn this on only if a specific player needs it (Jellyfin's HLS-transcode
fallback being the primary motivating case) — leave it off otherwise.
If a player won't tolerate the live pipe's startup wait at all (endless
retry loop, permanent black screen — some players are stricter than
`calculatedLength` can paper over), use `mode=hls` instead of trying to push
`calculatedLength` further.

### `mode=hls`

Without `calculatedLength`, `mode=hls`'s playlist only lists the segments ffmpeg
has actually written so far, growing as the encode progresses (`#EXT-X-
PLAYLIST-TYPE:EVENT`) — some players won't show a scrub bar for the
un-encoded remainder until the encode reaches it.

`calculatedLength=1` here writes the **entire** playlist upfront instead: every
segment's `#EXTINF` computed from the video's real duration (looked up via
`yt-dlp --print duration`, cached per `youtubeId`), `#EXT-X-PLAYLIST-
TYPE:VOD` and `#EXT-X-ENDLIST` present from the very first response. This is
an exact playlist, not an estimate — every declared segment really is that
length; the only thing not yet true is that all of them exist on disk.

The encode itself is unchanged: ffmpeg still only transcodes forward from
wherever playback actually is, one `HLS_SEGMENT_DURATION_SECONDS` (4s)
segment at a time. When a player requests a segment that isn't on disk yet
(a seek, forward or backward, past the currently-encoded window), the
segment route gives the running encode a brief grace window
(`HLS_SEEK_GRACE_MS`, 2.5s) in case it's about to get there anyway, then
kills it and restarts a fresh encode pass at that segment's exact boundary
timestamp (never mid-segment, so ffmpeg's own segment numbering stays
aligned with the pre-declared absolute index), and waits for the file to
appear before responding. Already-encoded segments — including ones from a
prior pass, before a seek moved the encode elsewhere — stay servable
indefinitely; nothing is ever deleted mid-session. Concurrent requests for
the same target within the grace window collapse into a single restart
rather than each spawning their own.

Tradeoffs: a seek past the encoded window has the same few-seconds restart
latency as a cold `mode=hls` start (an HLS-idiomatic buffering pause, not a
`502`/black screen). Two viewers seeking to different, far-apart points in
the same shared session will fight over which point the single encode pass
is currently serving — each seek restarts it again. `t`/`?t=` is ignored
when `calculatedLength=1` in this mode: segment 0 must always correspond to video
time 0 for the pre-declared absolute segment indices to stay correct, so
there's no equivalent of `mode=ffmpeg`'s cold-start offset.

## Enhanced HLS (`mode=hls`)

`mode=ffmpeg`'s live pipe opens the HTTP response to the player
immediately, then makes the player sit on that same connection through
our full pipeline startup latency (two concurrent yt-dlp extractions +
ffmpeg spin-up) before any bytes arrive. Some players — Jellyfin's own
server-side transcoder being the case that motivated this — won't
tolerate that wait on an already-open connection and just abort and
retry forever: connect, wait ~15-20s, give up, reconnect, repeat,
permanent black screen, no errors on our side to even show what's wrong
(every kill in the logs is `req-aborted` — the *player* is the one
closing the connection each time).

`mode=hls` avoids this by matching the approach the reference
[kingschnulli/jellyfin-youtube-plugin](https://github.com/kingschnulli/jellyfin-youtube-plugin)
uses (`ManagedTranscodeService.cs`): ffmpeg writes real segmented HLS
output — a `playlist.m3u8` plus numbered segment files — to a temp
directory instead of piping live, and **the HTTP response isn't sent at
all until the first real segment exists on disk** (polled, up to 30s).
The wait happens entirely on Youtarr's side, before the player's
connection is ever opened, so the player never sees a slow-starting
connection in the first place. Once ready, every subsequent request
(the player re-polling the growing playlist, or fetching a segment) is
just an ordinary static-file response — real `Content-Length`, no
estimation, no restart-per-seek: the player seeks by requesting whatever
segment covers the timestamp it wants, using the `#EXTINF` durations
already in the (still-growing) playlist.

Concrete differences from `mode=ffmpeg`:

- **Genuinely instant seeking** once a segment has been transcoded —
  no pipeline restart at all, unlike `calculatedLength`'s Range-triggered
  restart. Seeking *ahead* of where ffmpeg has currently transcoded to
  will still stall until it catches up, same as any live HLS stream.
- **Writes real files to disk** for the life of a session — a segment
  every `HLS_SEGMENT_DURATION_SECONDS` (4s) at roughly the resolution's
  target bitrate, for the whole video. Sessions are identified by a hash
  of `(youtubeId, quality, transcode, hardwareMode, container,
  playerClient, calculatedLength)`, so repeated requests for the same effective params
  reuse the same session instead of spawning duplicates, and every
  session is torn down (processes killed, directory removed) after
  `HLS_IDLE_TIMEOUT_MS` (2 minutes) of no requests — mirroring the
  reference plugin's idle-session cleanup. This storage is deliberately
  **not** under `tempPathManager`'s temp base (a dedicated
  `<os tmpdir>/youtarr-ytstream-hls/` instead), since that directory gets
  wiped wholesale on every download-job start and would otherwise delete
  segments out from under an actively-playing session.
- **`calculatedLength` pre-declares the whole timeline** instead of growing it —
  see "Calculated length" above for the mode=hls-specific behavior
  (exact, not estimated, and seeking past the encoded window restarts just
  that segment rather than the whole session).

If ffmpeg is unavailable, `mode=hls` falls back to `direct`, same as
`mode=ffmpeg`. If a session never produces a first segment within the
30s readiness window (extraction failure, no available format, etc.),
the request fails with a `502` rather than hanging indefinitely — the
same 403/extraction-error retry-once-with-`android` logic `mode=ffmpeg`
uses also applies here before that happens.

**Needs an HLS-capable player.** `mode=hls` serves a real `.m3u8`
manifest — playing it requires a player with an HLS engine (Safari's
native `<video>` support, or a library like `hls.js`, which is what
Jellyfin's own web client uses). A plain `<video src="...">` element
with no HLS engine (e.g. Youtarr's own in-app library preview player,
`client/src/components/shared/VideoModal/components/VideoPlayer.tsx`)
cannot play it at all — the browser fetches the manifest a couple of
times while sniffing the format, can't decode it, and silently gives up
without ever requesting a segment. That player is pinned to
`?mode=ffmpeg` explicitly for this reason, independent of whatever
`ytstream.defaultMode` you configure — so setting the default to `hls`
for Jellyfin's benefit won't break in-app preview playback. If you add
other integrations that hit `/api/ytstream/:id` without an explicit
`?mode=`, keep this in mind.

## Using this as a `.strm` target

`server/modules/strmGenerator.js` now supports `strm.target: "ytstream"`
directly — no need to hand-write `.strm` files or point
`strmGenerator`'s proxy builder anywhere yourself. When STRM materialize
runs with this target, the generated `.strm` file's URL is built from:

- **`mode`** — `ytstream.defaultMode` (config), default `direct`
- **`quality`** — `strm.quality` override, else `ytstream.quality` override,
  else `preferredResolution` (the same resolution a full download would use)
- **`container`** — `ytstream.container` (config), default `mp4`
- **`transcode`** — `ytstream.transcode` override if set, else derived from
  `videoCodec` (`default` → `copy`, `h264`/`h265` → `h264`) — i.e. it
  matches whatever codec preference the user already set for regular
  downloads

Example resulting `.strm` contents for a channel with
`preferredResolution: "1080"`, `videoCodec: "h264"`, and
`ytstream.defaultMode: "ffmpeg"`:

```
http://192.168.1.10:3011/api/ytstream/dQw4w9WgXcQ?mode=ffmpeg&quality=1080&container=mp4&transcode=h264
```

In Jellyfin/Emby/Kodi, point a library item at this the same way you would
at `/api/strm/<id>` (see `docs/STRM.md`) — it's produced automatically once
`strm.target` is set to `ytstream`.

## Examples (manual/curl)

```bash
# Simple/direct: expect a 302 to a googlevideo.com URL
curl -I "http://localhost:3087/api/ytstream/dQw4w9WgXcQ"

# Enhanced/ffmpeg, remux only, fragmented mp4 streamed to stdout
curl "http://localhost:3087/api/ytstream/dQw4w9WgXcQ?mode=ffmpeg" -o test.mp4

# Enhanced/ffmpeg, force re-encode + MPEG-TS container
curl "http://localhost:3087/api/ytstream/dQw4w9WgXcQ?mode=ffmpeg&transcode=h264&container=ts" -o test.ts
```

## Choosing `direct` vs `ffmpeg`

- Start with `direct`. It's zero-CPU-overhead and works for most progressive
  formats up to 1080p.
- Switch to `ffmpeg` when:
  - You want quality above what progressive formats offer (DASH video+audio
    muxed on the fly can reach much higher bitrates/resolutions).
  - A player's format support doesn't match what YouTube serves at your
    requested quality (use `transcode=h264` to normalize).
  - You want a consistent single container/codec across all clients.
- `ffmpeg` mode costs CPU per concurrent stream. `transcode=copy` is cheap
  (just remuxing); `transcode=h264` is a real encode and will use
  significant CPU, especially at higher resolutions.

## Format selectors (aligned with the Jellyfin plugin)

These are the same yt-dlp `-f` strings used by
[kingschnulli/jellyfin-youtube-plugin](https://github.com/kingschnulli/jellyfin-youtube-plugin)
`YtDlpService.cs`:

| Mode | quality | Selector |
|---|---|---|
| `direct` | `720` (default) | `b[protocol!*=m3u8][ext=mp4][height=720]/…` (BroadCompatibility720p) |
| `direct` | `1080` | `b[height=1080]/b[height=720]/…` (Balanced1080p) |
| `direct` | `best` | `b` (MaximumQuality — may return HLS) |
| `ffmpeg` | any | DASH pair: `bv*[height<=N][vcodec^=avc1]/bv*[height<=N]` (video-only) + `ba[acodec^=mp4a]/ba` (audio-only), each fetched by its own `yt-dlp -o -` process and muxed by ffmpeg — not a single progressive selector, and not yt-dlp's own `bv*+ba` merge (which needs to fully download and mux both tracks itself before emitting anything on stdout, looking like a hang on longer videos; fetching them as two independent streams that ffmpeg muxes as bytes arrive avoids that). |

`mode=ffmpeg` pipes a fragmented MP4 / MPEG-TS response (HTTP clients)
built from two `yt-dlp -o -` processes (video-only, audio-only) each
piped into one of ffmpeg's extra file descriptors (`pipe:3` / `pipe:4`),
with `ffmpeg -i pipe:3 -i pipe:4 ... pipe:1` muxing them into the
response — whereas the plugin's Enhanced mode writes disk-backed HLS for
Jellyfin. Codec/filter defaults (`scale≤1920`, AAC 192k, etc.) match the
plugin's software transcode branch when `transcode=h264`.

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
it directly, then fail trying to read our (non-standard, still-growing)
HLS stream as *its own* ffmpeg's input, producing a confusing 500 with no
useful error on Youtarr's side.

To avoid silently handing out an unplayable stream, `mode=ffmpeg` and
`mode=hls` both probe the actual codec of the format `transcode=copy`
would use (`yt-dlp -f <selector> --print vcodec`, cached per
`(youtubeId, quality, playerClient)` — see `resolveVideoCodec` /
`codecCache` in `ytstream.js`) before spawning anything. If it isn't
H.264, the request is transparently upgraded to `transcode=h264` (a real
re-encode) for that response; if it's already H.264, `copy`'s speed is
unaffected. `transcode=h264` requested directly skips this probe entirely.
The probe adds one short yt-dlp call to a cold start (a couple of seconds,
cached for repeat requests to the same video/quality); if the probe itself
fails (network hiccup, extraction error), the request proceeds with
`copy` as originally requested rather than blocking playback on the check.

## Hardware encoding (Enhanced + H.264)

When `mode=ffmpeg` and `transcode=h264`, `ytstream.hardwareMode` selects the
encoder. Arguments match
`ManagedTranscodeService.AddVideoEncoderArguments` in the Jellyfin plugin:

| Mode | ffmpeg encoder | Notes |
|---|---|---|
| `none` (default) | `libx264` | Software, CRF 23, veryfast |
| `qsv` | `h264_qsv` | Intel Quick Sync |
| `nvenc` | `h264_nvenc` | NVIDIA NVENC (preset p5, VBR) |
| `vaapi` | `h264_vaapi` | Uses `/dev/dri/renderD128` |
| `amf` | `h264_amf` | AMD AMF |

Audio is always AAC stereo 192k 48 kHz when re-encoding. Video is scaled to
max 1920 width (`scale='min(1920,iw)':-2`).

Override per request for testing:

```bash
curl "http://localhost:3087/api/ytstream/VIDEO_ID?mode=ffmpeg&transcode=h264&hardware=nvenc" -o out.mp4
```

Docker hosts must pass through the GPU device (e.g. `--device /dev/dri` for
VAAPI/QSV, or NVIDIA Container Toolkit for NVENC).

## Limitations

- `mode=ffmpeg` streams are not byte-range seekable the way a static file
  is — seeking works by re-requesting the endpoint with `?t=<seconds>`,
  which restarts ffmpeg with `-ss`. Some clients handle this well (fresh
  request per seek), others won't.
- Live/re-muxed output has no known `Content-Length`, so some clients may
  show an unknown duration until they've buffered enough to infer one, or
  (Jellyfin being the known case) refuse to direct-play it at all and
  fall back to their own server-side transcode. `calculatedLength=1` /
  `ytstream.calculatedLength` works around both by reporting an estimated
  length and answering Range requests with pseudo-seeking — see "Fake
  seekable length" above for how it works and its tradeoffs.
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
   ytstream playback (or `config.json`).
2. **Automatic retry**: both `mode=direct` and `mode=ffmpeg` now retry
   once, automatically, with `player_client=android` if the first attempt
   fails with this signature and no bytes have reached the client yet.
   Check the logs for `ytstream: ... retrying once with
   player_client=android` — if you see that line followed by success, no
   action is needed.
3. **Outdated yt-dlp.** YouTube changes extraction frequently; if the
   error persists after the client-list fix, update yt-dlp first
   (Settings → yt-dlp → Update, or `yt-dlp -U` / re-pull the Docker
   image) before changing anything else.
4. **Missing/expired cookies** for content that needs them (age-restricted,
   members-only). Re-upload cookies in Settings → Cookies.

If it still fails after updating yt-dlp and trying an explicit
`playerClient` override, run the debug endpoint to see what yt-dlp itself
reports for that video:

```bash
curl "http://localhost:3087/api/ytstream/VIDEO_ID/formats"
```

### ffmpeg logs `Invalid data found when processing input`

In `mode=ffmpeg`, this means yt-dlp produced no usable bytes on its
stdout before exiting (almost always the same root cause as above — check
the yt-dlp error just above this line in the logs, not the ffmpeg line
itself).

## Installing ffmpeg

`mode=direct` needs nothing beyond what Youtarr already requires.
`mode=ffmpeg` needs the `ffmpeg` binary on `PATH` for the Youtarr server
process, the same way Youtarr already needs `yt-dlp` on `PATH`.

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

If this fails, `server/routes/ytstream.js` detects it automatically
(`isFfmpegAvailable()`) and logs a warning, then serves `mode=ffmpeg`
requests as `direct` instead of erroring out — same "fail soft" behavior
as the reference Jellyfin plugin's Enhanced-mode fallback.

## Integration points in code

- `server/routes/ytstream.js` — the whole feature: direct resolve, DASH
  video/audio resolve, `mode=ffmpeg`'s live pipe, `mode=hls`'s session
  manager (`createHlsSessionInternal`/`waitForHlsSessionReady`/
  `getOrCreateHlsSession`/the idle reaper) and its segment-serving route,
  formats debug endpoint
- `server/modules/configModule.js` — reused for `getCookiesPath()` and
  `getConfig()` (unchanged)
- `server/modules/ytDlpRunner.js` — reused for spawning `yt-dlp -g` / `-F`
  (unchanged)
- `server/modules/download/ytdlpCommandBuilder.js` — reused for
  `buildCommonArgs()` (proxy / IP family / rate limiting), unchanged
- `server/routes/index.js` — one new `app.use(createYtStreamRoutes(...))`
  line, registered after the existing STRM route
- `server/modules/strmGenerator.js` — new `target: "ytstream"` branch that
  builds the `/api/ytstream/...` URL for `.strm` files, deriving
  `quality`/`transcode` from the user's download settings
  (`preferredResolution`/`videoCodec`) when not explicitly overridden
- `client/src/config/configSchema.ts` — the `ytstream` config block
  (including `playerClient`)
- `client/src/components/Configuration/sections/YtstreamSettingsSection.tsx`
  — dedicated settings UI for all `ytstream.*` options
- `client/src/components/Configuration/sections/StrmSettingsSection.tsx`
  — renders `YtstreamSettingsSection` when `strm.target === 'ytstream'`,
  plus the "Youtarr direct/ffmpeg" STRM target option itself
