# Getting Started: Channel & Playlist Settings

This guide covers the per-channel and per-playlist settings dialog in Youtarr-Turbo
Turbo — subfolder placement, TV Series library mode (season/episode
numbering), title filtering, and the live preview tools that let you check
both before you save anything. It uses a real subscribed channel
(**Taskmaster**) as a worked example for the TV Series settings, since that's
exactly the case where getting the regex right matters most.

For the full field reference, see [CONFIG.md § TV Series Library Mode](CONFIG.md#tv-series-library-mode)
and the `channels`/`playlists` table definitions in [DATABASE.md](DATABASE.md).

## Where these settings live

Every subscribed channel and playlist has its own settings dialog,
independent of the global defaults in Settings → Core Settings. Any field
left at "Use global setting" (`null` in the database) inherits the
corresponding global `config.json` value; anything you set explicitly
overrides it just for that channel/playlist.

- **Channels**: Channels page → the channel's **⋮** menu → **Settings**. The
  dialog has four tabs down the side: **General**, **Filters**, **Ratings**,
  and **Auto-Removal**.
- **Playlists**: Playlists page → the playlist's **⋮** menu → **Settings**.

## Channel settings reference

| Setting (UI label) | Tab | Config Key | Notes |
|---|---|---|---|
| Subfolder | General | `sub_folder` | Where this channel's downloads land. "Use global default" inherits `defaultSubfolder`; "No Subfolder" explicitly forces the root regardless of the global default. |
| Media Mode | General | `media_mode` | Per-channel override of `mediaMode` (`download`/`strm`/`both`). `null` inherits the global setting. |
| Library Mode | General | `library_mode` | Per-channel override of `defaultLibraryMode` (`movie`/`series`). `null` inherits the global setting. |
| Channel Video Quality Override | General | `video_quality` | Per-channel override of `preferredResolution`. |
| Video File Structure | General | `skip_video_folder` | "Use global setting" / "Flat" / "Video subfolders" — see [CONFIG.md § Flat File Structure Default](CONFIG.md#flat-file-structure-default). |
| Generate channel playlist file (.m3u) / Playlist Order | General | `m3u_enabled` / `m3u_sort_order` | Writes a `.m3u` playlist file into the channel folder, oldest-first or newest-first. |
| Min Duration (mins) / Max Duration (mins) | Filters | `min_duration` / `max_duration` | Reject videos shorter/longer than these bounds. **Note the UI takes minutes**, even though the underlying config stores seconds. |
| Title Filter (Python Regex) | Filters | `title_filter_regex` | Only download videos whose title matches this regex. See [Title filtering](#title-filtering) below. |
| Season/Episode Regex (Python, named groups) | Filters | `season_episode_regex` | Only shown when Library Mode is TV Series. See [TV Series numbering](#tv-series-numbering--the-combined-filter-preview) below. |
| Default Rating | Ratings | `default_rating` | Rating tag applied to videos with no other rating source. |
| Protect this channel from auto-removal | Auto-Removal | `auto_removal_protected` | Excludes every video of this channel from all auto-removal strategies. |
| Always keep newest downloads | Auto-Removal | `auto_removal_keep_recent_count` | Per-channel version of the global keep-recent-count guard — see [CONFIG.md § Per-Channel Auto-Removal Settings](CONFIG.md#per-channel-auto-removal-settings). Mutually exclusive with Protect above. |

(Audio Format exists as a config field but isn't currently exposed as a
labeled control in this dialog.)

## Playlist settings reference

Playlists split their controls across two places: the **Settings** dialog
(⋮ menu → **Settings**) for download-time defaults, and controls right on
the playlist's own page for subscription/sync behavior. There's **no**
Season/Episode Regex option anywhere for playlists — that decoding is
channel-only.

### Settings dialog

| Setting (UI label) | Config Key | Notes |
|---|---|---|
| Default Subfolder | `default_sub_folder` | Same semantics as a channel's Subfolder. Applies when the video's own channel has no subfolder set. |
| Video Quality *(under "Resolution Override")* | `video_quality` | Per-playlist override of `preferredResolution`. |
| Download Type | `audio_format` | Video, or audio-only extraction (MP3) — choosing "MP3 Only" also changes what type of playlist gets synced to media servers. |
| Media mode *(under "Media Mode")* | `media_mode` | Same override/inherit pattern as a channel's Media Mode. A video's own channel setting still takes precedence over this. |
| Library mode *(under "Library Mode")* | `library_mode` | Same override/inherit pattern as a channel's Library Mode. |
| Playlist order *(under "Playlist Order")* | `sort_order` | "YouTube playlist order" or "Reverse playlist order" — used for the `.m3u` file and media-server playlist sync order. |
| Default Rating | `default_rating` | Rating tag applied to videos with no other rating source. |

### On the playlist page itself (not in the Settings dialog)

| Setting (UI label) | Config Key | Notes |
|---|---|---|
| Auto-download new videos | `auto_download` | Pull newly-added playlist items automatically on the channel refresh schedule. |
| Public on media servers | `public_on_servers` | Whether the synced playlist is visible to other users on the media server, not just the admin account. |
| Per-server sync chips (click a server's name to toggle) | `sync_to_plex` / `sync_to_jellyfin` / `sync_to_emby` | Whether this playlist is mirrored as a native playlist on each connected media server. |

`min_duration`, `max_duration`, and `title_filter_regex` also exist as
database columns on playlists, but aren't currently exposed anywhere in the
Settings dialog — they only pre-seed channels that get auto-created from a
playlist, and can't be edited directly on the playlist itself yet.

## TV Series numbering — the combined filter preview

Taskmaster is subscribed in **TV Series library mode** (the global default
here is `defaultLibraryMode: "series"`, so the channel simply inherits it —
no per-channel override needed). By default, series mode numbers episodes by
upload year (season) and chronological order within that year (episode).
Taskmaster's actual YouTube upload titles carry real series/episode numbers
though, so a custom `season_episode_regex` decodes those directly instead of
falling back to the year-based default:

**Example title, as uploaded to YouTube:**
```
Series 1, Episode 2 - 'The pie whisperer.' | Full Episode | Taskmaster
```

**Season/Episode Regex (Python, named groups)** field (Settings → channel
→ **Filters** tab → "Season/Episode Decoding" section — this section only
appears when Library Mode is TV Series):
```
(?i).*(?:season|series)\s*(?P<season>\d+).*episode\s*(?P<episode>\d+)
```

The `(?i)` makes it case-insensitive and the `.*`/`\s*` gaps make it
tolerant of punctuation — it doesn't care whether the upload says "Series"
or "Season", whether there's a comma, or exactly how much text sits between
the numbers and the word "episode". That tolerance is exactly what's needed
here: some Taskmaster uploads say "Series 4, Episode 6", others say "Season
10, Episode 1" for the exact same kind of content — and both resolve
correctly:

| YouTube title (as uploaded) | Resolved season/episode | Resulting file |
|---|---|---|
| `Series 1, Episode 2 - 'The pie whisperer.' \| Full Episode \| Taskmaster` | S1 E2 | `S01E02 - 'The pie whisperer.' Full Episode Taskmaster [vR-fE797Y-w].strm` |
| `Season 10, Episode 1 - 'God's haemorrhoid.' \| Full Episode \| Taskmaster` | S10 E1 | `S10E01 - 'God's haemorrhoid.' Full Episode Taskmaster [...].strm` |
| `Junior Taskmaster Series 1, Episode 2 - 'Would a bird fly?' \| Full Episode` | S1 E2 | `S01E02 - 'Would a bird fly' Full Episode [vVCH1nuATcE].strm` |

That third row shows something worth knowing: the
spin-off ("Junior Taskmaster") episode and the flagship episode both matched
`Series 1, Episode 2` and landed in the **same** `S01E02` slot as two
different files. Youtarr-Turbo doesn't require season/episode numbers to be
unique — every filename still ends in the locked `[VIDEO_ID]` suffix, so
same-slot files never collide on disk, they just both show up under
"Season 1, Episode 2" in your media server.

**When a title doesn't resolve to a season/episode**, Youtarr-Turbo doesn't
fail the download — it falls back to the year/chronological default, same
as a channel with no regex configured at all. You'll see this show up as a
year-numbered season folder (e.g. `Season 2020`) sitting alongside your real
season folders. If you spot one of those in your own library, it means some
video's title didn't resolve the way you expected — check it against your
regex rather than assuming something is broken.

### Using the preview before you save

For a channel in TV Series library mode, the **Filters** tab has a
**Preview** button, at the bottom under its own "Preview" heading, below
the Season/Episode Decoding section (`GET
/api/channels/:channelId/combined-filter-preview` under the hood). It runs
your in-progress title filter regex *and* season/episode regex together
against the channel's actual recent videos and shows you, before saving
anything:

- which videos the title filter would let through
- what season/episode/filename each one would resolve to

Use it to catch exactly the kind of edge case above — a title format your
regex doesn't handle — before it produces a wrongly-numbered episode or a
stray fallback season folder in your real library.

## Title filtering

`title_filter_regex` — the **Title Filter (Python Regex)** field, Settings →
channel → **Filters** tab, under "Download Filters" — runs independently of
season/episode decoding and simply gates which videos get downloaded at
all. Taskmaster's channel uploads more than just the flagship UK show —
regional spin-offs and a podcast share the same upload feed — so the actual
saved filter is doing more than a simple keyword match:

```
(?i)^(?!.*(?:NZ|AUS|Sweden|PODCAST)).*(?:season|series).*episode(?:.*full episode)?.*$
```

Broken down:
- `(?!.*(?:NZ|AUS|Sweden|PODCAST))` — a negative lookahead that **rejects**
  any title mentioning the NZ, Australian, or Swedish versions of the show,
  or the Taskmaster podcast, all of which upload to the same channel but
  aren't the show this subscription wants.
- `.*(?:season|series).*episode.*` — otherwise **requires** the same
  season/series-then-episode wording the numbering regex above looks for,
  so promos, clip compilations, and one-off specials with no episode
  number in the title get excluded too.

This pairs with a **Min Duration (mins)** of `45` on the same channel (under
"Duration Filters", above "Download Filters" on the same Filters tab) — a
second, independent filter that rejects short clips regardless of what
their titles say. The field takes minutes in the UI; it's stored internally
as `2700` seconds. Together, the two explain why every downloaded file in
the library is a genuine full-length episode with no Shorts, clips, or
off-brand regional episodes mixed in.

On a channel in `movie` library mode instead, the Filters tab shows a
plain **Preview Regex** button right under the Title Filter field — the
title-only version of the preview above, without a season/episode side to
check. That standalone button is hidden for TV Series channels like
Taskmaster; there, the combined Preview described above covers the title
filter too.

## Contrast: a channel in `movie` library mode

Not every channel needs series numbering. **The Infographics Show** is
subscribed here in the default `movie` library mode — no season/episode
regex, files named with the standard `videoFilenamePrefix` template instead:

```
The Infographics Show - The Japanese Yen is Collapsing and Threatening America [tzK1Sqkf7VY].mp4
```

Use `movie` mode (the default) for channels where episodic TV-style
numbering doesn't make sense — one-off explainer/news/commentary content is
the common case — and reserve `series` mode + a season/episode regex for
channels that actually map onto a TV-style structure, like Taskmaster.

## Putting it together: setting up a new TV-series-style channel

1. Subscribe to the channel as normal.
2. Open its **⋮ → Settings** dialog → **General** tab → set **Library Mode**
   to "TV Series" (or leave it on "Use global setting" if your global
   Library Mode default is already TV Series, as in this setup).
3. Pull up a handful of the channel's actual recent video titles and look
   for a consistent numbering pattern in the text itself.
4. Switch to the **Filters** tab. Write a regex with named
   `(?P<season>)` / `(?P<episode>)` groups matching that pattern, paste it
   into **Season/Episode Regex (Python, named groups)** (under "Season/Episode
   Decoding", only visible now that Library Mode is TV Series), and click
   the **Preview** button under it to check the resolved season/episode
   against real recent videos before saving.
5. If the channel also uploads non-episode content (shorts, trailers,
   promos), fill in **Title Filter (Python Regex)** further up the same
   Filters tab (under "Download Filters") — the Preview button you already
   used in step 4 covers this too, once both fields are filled in.
6. Back on the **General** tab, set **Subfolder** if you want this show
   separated from the rest of your series library — Taskmaster here has
   it explicitly set to `"Series"` (matching the global
   `seriesOutputSubfolder` default value, but set directly on the channel
   rather than left to inherit it).
7. Save, then trigger a manual download/refresh and confirm the resulting
   folder/file names look right before leaving auto-download enabled
   long-term.

## Related docs

- [CONFIG.md § TV Series Library Mode](CONFIG.md#tv-series-library-mode) — global defaults these per-channel/playlist settings override.
- [GETTING_STARTED_STREAMING.md](GETTING_STARTED_STREAMING.md) — Taskmaster in this setup is also STRM+ytstream, so its episodes stream on demand rather than fully downloading; the two settings layers (library mode here, media mode there) are independent and compose together.
- [DATABASE.md](DATABASE.md) — full `channels`/`playlists` table schema.
