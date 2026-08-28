# How to wire this package into Youtarr

Copy files from this package into a Youtarr checkout, then apply the small patches below.

## 1. Copy files

```text
config/config.example.json.patch.md     → apply keys into config/config.example.json
server/modules/strmGenerator.js         → server/modules/strmGenerator.js
server/modules/strmMaterializer.js      → server/modules/strmMaterializer.js
server/routes/strm.js                   → server/routes/strm.js
migrations/20260816120000-add-is-strm-to-videos.js → migrations/
docs/STRM.md                            → docs/STRM.md (optional)
```

## 2. `server/models/video.js`

Add field inside `Video.init({ ... })`:

```js
    is_strm: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
```

## 3. `server/modules/filesystem/constants.js`

Include `.strm` in presence checks:

```js
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.m4v', '.avi', '.strm'];
```

## 4. `server/routes/index.js`

Register routes (near the other `app.use` calls):

```js
const createStrmRoutes = require('./strm');

// inside registerRoutes():
app.use(createStrmRoutes({ verifyToken }));
```

Place this **before** any catch-all that might block `/api/strm`. The GET proxy is intentionally public.

## 5. `server/modules/videoPersistence.js`

In `prepareVideoDataForSave`, treat STRM as a verified file:

```js
    const hasVerifiedStrm = Boolean(
      video.is_strm && video.filePath && String(video.filePath).toLowerCase().endsWith('.strm')
    );
    const hasVerifiedFile = hasVerifiedVideoFile || hasVerifiedAudioFile || hasVerifiedStrm;
```

And preserve `is_strm` on create/update (do not delete the field).

## 6. Hook download path for `mediaMode === 'strm'`

In `server/modules/downloadModule.js` (or the specific-URL download entry that builds yt-dlp args), before spawning a full download:

```js
const strmMaterializer = require('./strmMaterializer');
const configModule = require('./configModule');

// When handling a list of URLs (manual / specific downloads):
const mode = strmMaterializer.resolveMediaMode(
  {}, // channel settings if available
  this.getOverrideSettings(jobData)
);
if (mode === 'strm') {
  const urls = /* the URL list for this job */;
  const results = await strmMaterializer.materializeMany(urls, {
    jobId,
    subFolder: /* resolved subfolder or null */,
    skipVideoFolder: /* flat structure flag */,
  });
  // Mark job complete / emit progress using existing jobModule helpers
  return;
}
```

For channel auto-downloads, resolve mode from channel settings (add `mediaMode` to channel settings when you extend the UI) the same way quality is resolved today via `downloadSettingsResolver`.

**Minimal working path without touching channel cron:** use only:

```http
POST /api/strm/materialize
Authorization: Bearer <session>
{ "urls": ["https://www.youtube.com/watch?v=..."] }
```

That already creates library-ready STRM trees.

## 7. Auth note for GET `/api/strm/:id`

If a global `verifyToken` middleware wraps all `/api/*` routes, exclude this path (same idea as `/api/health`). The route module itself does not call `verifyToken` on GET.

## 8. Restart

```bash
# rebuild/restart containers so migrations run and new modules load
docker compose down && docker compose up -d
# or ./stop.sh && ./start.sh
```

Confirm migration applied (`is_strm` on `Videos`) and:

```bash
curl -I "http://localhost:3087/api/strm/dQw4w9WgXcQ"
# expect 302 when yt-dlp can resolve
```

## 8b. Additive: `/api/ytstream/:id` (direct + ffmpeg playback)

This is a separate, optional route — it does not replace or modify anything
from steps 1-8. Copy in addition to the STRM files above:

```text
server/routes/ytstream.js                      → server/routes/ytstream.js
```

Register it in `server/routes/index.js` next to the STRM registration:

```js
const createYtStreamRoutes = require('./ytstream');

// inside registerRoutes(), after createStrmRoutes:
app.use(createYtStreamRoutes({ verifyToken }));
```

Add the `ytstream` config block from `config/config.example.json.patch.md`.
See `docs/YTSTREAM.md` for full behavior, and the "Installing ffmpeg"
section there if `mode=ffmpeg` reports it's unavailable.

```bash
curl -I "http://localhost:3087/api/ytstream/dQw4w9WgXcQ"                 # mode=direct (default): expect 302
curl -I "http://localhost:3087/api/ytstream/dQw4w9WgXcQ?mode=ffmpeg"     # mode=ffmpeg: expect 200 + streamed body
```

## 9. Optional UI (later)

- Config page: dropdown for `mediaMode` + STRM subsection.
- Channel settings: optional `mediaMode` override.
- Video list: badge when `is_strm` is true.

Backend is usable without UI via config + materialize API.
