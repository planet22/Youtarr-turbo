# STRM mode (stream-only library items)

Youtarr can materialize **`.strm`** files (plus NFO / thumbnails) instead of downloading full video files, so Jellyfin, Emby, or Kodi can list and play YouTube content on demand.

## Modes (`mediaMode`)

| Value | Behavior |
|-------|----------|
| `download` (default) | Existing behavior: full media download. |
| `strm` | Write `.strm` + metadata only; no `.mp4`. |
| `both` | Download media **and** write a `.strm` pointing at the proxy or YouTube. |

Configure in `config.json` (merged from `config.example.json`):

```json
"mediaMode": "strm",
"strm": {
  "target": "ytstream",
  "proxyBaseUrl": "http://192.168.1.10:3087",
  "writeNfo": true,
  "writeThumbnail": true,
  "quality": "1080"
}
```

- **`target: "youtube"`** — `.strm` contains `https://www.youtube.com/watch?v=ID` (simple; client must resolve YouTube).
- **`target: "ytstream"`** (default) — `.strm` contains `http://your-youtarr/api/ytstream/ID?mode=...&quality=...&container=...&transcode=...` (see `docs/YTSTREAM.md`). Youtarr resolves/streams via the `/api/ytstream` direct-redirect/ffmpeg/hls route. The quality/transcode query params are filled in from the user's normal download settings (`preferredResolution` / `videoCodec`) at materialize time, unless overridden via `strm.quality` / the `ytstream` config block — so STRM playback matches what a full download of the same video would have used. **Set `proxyBaseUrl` to a URL reachable by Jellyfin clients** (LAN IP / reverse proxy), not `127.0.0.1` unless Jellyfin runs on the same host.

> `target: "proxy"` (the older `/api/strm/:id` yt-dlp resolver route) has been removed — `ytstream` replaced it. Any existing `.strm` files still containing `/api/strm/` URLs need to be re-materialized to pick up the new target.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/api/ytstream/:youtubeId` | **None** (players) | Resolve stream and play (`mode=direct\|ffmpeg\|hls`) — see `docs/YTSTREAM.md` |

## Files on disk

Same layout as normal downloads:

```text
<output>/<Channel>/<Channel> - <Title> [<id>]/
  <...>.strm
  <...>.nfo
  <...>.jpg
```

`Videos.filePath` points at the `.strm`. Column `is_strm = true`.

## Jellyfin

1. Add the Youtarr output directory as a library (Movies or Mixed).
2. Prefer local NFO / images (same as existing Youtarr docs).
3. Scan after materializing.
4. Ensure `/api/ytstream/...` is reachable from the Jellyfin host and from clients if they follow redirects themselves.

## Limitations

- No offline archive in pure `strm` mode.
- Playback depends on YouTube + yt-dlp + cookies (age-restricted content).
- SponsorBlock cutting does not apply to pure streams.
- First play may be slower until the proxy cache is warm.

## Integration points in code

- `server/modules/strmGenerator.js` — write `.strm` text file. `target: "ytstream"` builds a `/api/ytstream/...` URL from the user's download quality/codec settings; see `docs/YTSTREAM.md`.
- `server/modules/strmMaterializer.js` — metadata → folders → STRM/NFO/DB
- `server/routes/ytstream.js` — resolve + direct/ffmpeg/hls playback API (see `docs/YTSTREAM.md`)
- Download jobs: when `mediaMode` is `strm`, call materializer instead of full yt-dlp download (see `INTEGRATION.md`)
