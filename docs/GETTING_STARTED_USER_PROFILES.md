# Getting Started: Multiple Users (User Profiles)

User profiles let one Youtarr-Turbo install serve several people, each with
their own library of channels and playlists. There is still one Youtarr-Turbo
login (yours); profiles are for the people *watching*, typically one per
Jellyfin user.

Every video is downloaded **once**. Each profile that wants it gets a
**hardlink** to the same file inside its own folder, so a video shared by
three people uses the disk space of one.

## How it works

```
<YOUTUBE_OUTPUT_DIR>/
├── __Storage/Dear Old Blighty/Season 2026/S2026E01 - ... [A2wW-soNskk].strm   <- the real file
├── __profiles__/
│   ├── Kids/Dear Old Blighty/Season 2026/S2026E01 - ... [A2wW-soNskk].strm    <- hardlink
│   └── Dad/Dear Old Blighty/Season 2026/S2026E01 - ... [A2wW-soNskk].strm     <- hardlink
```

- A profile is a folder under `__profiles__/<profile name>/`.
- You pick which channels and playlists each profile follows.
- Videos from those channels/playlists are hardlinked into the profile
  folder, together with their `.nfo`, thumbnails and the channel/season
  artwork, laid out exactly like the main library (the `__subfolder` level is
  dropped, so each profile is one flat set of channel folders).
- In Jellyfin, each person gets a library pointing at their profile folder.

Hardlinks only work inside one filesystem, so profile folders always live
inside the download directory. If the link can't be made (the folder is on a
different filesystem), Youtarr-Turbo falls back to a real copy and logs a
warning; that works but doubles the disk space for those files.

> Hardlinks need a filesystem that supports them: local disks, btrfs/ext4
> on a NAS, and NFS do. Some SMB/CIFS mounts don't. To check yours, run this
> inside the Youtarr-Turbo container:
> ```sh
> cd /usr/src/app/data && mkdir -p __hltest/a __hltest/b && echo test > __hltest/a/f
> ln __hltest/a/f __hltest/b/f && stat -c '%i %h %n' __hltest/a/f __hltest/b/f; rm -rf __hltest
> ```
> Both lines should show the **same inode number**.

## Before you start

- **Jellyfin connected** (optional but recommended): Settings → Jellyfin
  Integration, with an API key. Needed for per-user playlists, per-user
  watched state and automatic library refreshes. See
  [Jellyfin setup](media-servers/jellyfin.md).
- **Jellyfin can see the download directory.** Profile folders are inside
  it, so whatever path Jellyfin uses for your YouTube folder works for
  `__profiles__/<name>` too.
- **Watch status sync on** (Settings → Watch Status) with **all users**
  enabled for Jellyfin, if you want per-person watched filters or
  "remove watched videos".

## Step 1: Create the profile

1. Settings → **User Profiles** → **Add profile**.
2. **Profile name** — also the folder name (`__profiles__/<name>`). Letters,
   numbers, spaces, hyphens and underscores.
3. Save. The folder is created straight away, empty.

## Step 2: Give the person a Jellyfin library

In Jellyfin (Dashboard → Libraries → Add Media Library):

1. **Content type**: *Shows* if the channels use TV Series library mode,
   *Movies* or *Mixed* otherwise. A Jellyfin library has one type, so if a
   person follows both series-mode and movie-mode channels, pick the type
   that fits most of them.
2. **Folder**: Jellyfin's path to `__profiles__/<profile name>`, e.g.
   `/data/media/youtube/__profiles__/Kids`.
3. Turn on **Enable real-time monitoring**.

Then in Jellyfin's Dashboard → Users → (the person) → **Access**, untick
"Enable access to all libraries" and tick only their library (plus anything
else they should see).

## Step 3: Link the profile to Jellyfin

Back in Youtarr-Turbo, Settings → User Profiles → **Edit** on the profile:

- **Jellyfin user** — the person's Jellyfin account. Used for their own
  playlists and their watched state.
- **Jellyfin library** — the library from Step 2. Youtarr-Turbo refreshes it
  whenever new videos are linked in.
- **Remove watched videos after (days)** — optional, see
  [Watched videos](#watched-videos).

## Step 4: Pick channels and playlists

Settings → User Profiles → **Channels & playlists** on the profile. Tick what
the person should have and **Save**. Videos you've already downloaded are
linked immediately; the message shows how many. From then on every new
download, STRM or cached file from those sources is linked automatically.

Only channels and playlists you're subscribed to appear in the list.

## Browsing as a profile

Once at least one profile exists, a profile picker appears in the header:

- **All profiles** — the normal, unfiltered app.
- **A profile** — Channels & Playlists and Videos show only what that profile
  follows, with a notice at the top and a **Show all** button. File paths
  ("Show file paths") show the profile's own copy. Untracked
  (cache-only) videos are hidden, as they belong to no profile.

With a profile selected, **adding a channel or playlist also adds it to that
profile**. Adding a channel you're already subscribed to just adds it to the
profile ("Channel added to <profile>").

The picker is remembered per browser.

## Playlists

Every playlist a profile follows is also created in Jellyfin as that
person's **own private playlist**, owned by their Jellyfin user and built
from their profile's copies. It updates whenever the shared playlist syncs.
The copy is removed when the profile stops following the playlist, changes
Jellyfin user, or is deleted.

The normal shared playlist (owned by the Jellyfin user in Settings →
Jellyfin Integration) is unchanged.

## Watched videos

- **Watched filter**: with a profile selected, the Videos page's Watched
  filter means "watched by *this profile's* Jellyfin user".
- **Remove watched videos after N days** (per profile): a nightly task
  (Profile maintenance, 2:20 AM) removes the profile's links to videos its
  Jellyfin user watched at least N days ago. Only that profile's copy goes —
  the library file and other profiles keep it — and protected videos are
  never removed. A removed video is not linked back in later and is left out
  of that person's playlist copies.
- **Global auto-removal** (Settings → Auto Removal → watched): a video still
  linked into a profile is only deleted once *that profile's* Jellyfin user
  has watched it too (and never, for a profile with no Jellyfin user). One
  person watching something no longer deletes it for everyone.

## What happens when…

| You… | Profiles |
|---|---|
| Download a video / STRM from a followed channel or playlist | Linked into every following profile straight away. A one-off manual download only appears in a profile if its channel or playlist is followed. |
| Delete a video | Removed from every profile; disk space is freed. |
| Cache a STRM (cache-on-play, or "Download" on a STRM) | Profiles switch to the real file. |
| Revert a cached video to STRM | Profiles switch back to the `.strm`. |
| Re-download / upgrade a video | Profile links point at the new file. |
| Move a channel to another subfolder | Nothing visible changes — links follow the file. |
| Rename a profile | Its folder is renamed. Update the Jellyfin library path to match. |
| Change a profile's Jellyfin user | Old user's playlist copies are deleted, new ones created. |
| Delete a profile | Its folder and playlist copies are removed. Library files are never touched. |
| Click **Relink** | Re-checks every link against the library and subscriptions. |

The nightly Profile maintenance task also re-checks every profile, so a
video that disappeared outside Youtarr-Turbo stops being linked.

## Troubleshooting

**The profile's Jellyfin library is empty.** Jellyfin skips a library
folder that was empty at its last full scan and ignores refreshes of that
library afterwards. Youtarr-Turbo detects an empty profile library and runs
one full library scan when videos are first linked. If it still shows
nothing, check the profile has a Jellyfin library selected (Edit), then run
**Scan All Libraries** in Jellyfin once.

**Videos are in the folder but the person can't see them.** Check their
Jellyfin user has access to the library (Dashboard → Users → Access).

**Watched filter shows nothing for a profile.** Watch status sync must be on
and include all users (Settings → Watch Status / Jellyfin "all users"). Sync
runs every few hours; use **Sync Now** to check immediately.

**"falling back to a real copy" in the logs.** The profile folder and the
library are on different filesystems (or the mount doesn't support
hardlinks). Keep everything inside one Docker volume / bind mount.

**Disk usage looks doubled.** Many tools (`du`, NAS dashboards) count each
hardlink as a full file. The space is only used once; compare inode numbers
with `stat` to confirm.

## Reference

- Tables: `profiles`, `profile_subscriptions`, `profile_video_links` —
  see [DATABASE.md](DATABASE.md).
- API: `/api/profiles` (Swagger at `/swagger`, tag *Profiles*).
- Folder layout: [Download Folder & File Structure](YOUTARR_DOWNLOADS_FOLDER_STRUCTURE.md#the-__profiles__-folder).
