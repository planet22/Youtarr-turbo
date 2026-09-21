# Database Configuration and Management

This document provides comprehensive information about Youtarr-Turbo's database setup, configuration, troubleshooting, and management.

## Table of Contents
- [Overview](#overview)
- [Internal Database (Default)](#internal-database-default)
- [External Database Setup](#external-database-setup)
- [Database Migrations](#database-migrations)
- [Troubleshooting Database Issues](#troubleshooting-database-issues)
- [Storage Considerations](#storage-considerations)

## Overview

Youtarr-Turbo uses MariaDB/MySQL for storing:
- Channel subscriptions and metadata
- Playlist subscriptions and per-server sync state
- Video information and download history
- Job queues and processing state
- Session data for authentication
- STRM/ytstream playback history and cached YouTube metadata
- Sonarr/Radarr (NZB) integration diagnostics and resolution-detection cache

### Database Tables
| Table              | Model             | Description                       |
| :----------------- | :-------------    | :-------------------------------- |
| `channels`         | `Channel`         | YouTube channel subscriptions and per-channel settings. `enabled` (boolean, default false): subscribed/tracked flag; auto-download and the auto-removal channel guards below only apply while true. `folder_name` (string, nullable): the actual sanitized on-disk directory name yt-dlp created (can differ from `uploader`/`title` after `--windows-filenames` sanitization). `available_tabs` (TEXT, JSON array, nullable): which tabs (`videos`/`shorts`/`streams`) YouTube reports for this channel. `hidden_tabs` (TEXT, comma-separated list, nullable): tabs the user has hidden from the UI even though available. `auto_download_enabled_tabs` (TEXT, comma-separated list, default `"video"`): which tabs are included in scheduled auto-downloads. `lastFetchedByTab` (TEXT, JSON, nullable): per-tab last-fetch timestamps, replaced the old single `lastFetched` column. `sub_folder` (string, nullable): per-channel subfolder override (see `defaultSubfolder` in [CONFIG.md](CONFIG.md)). `video_quality`, `min_duration`, `max_duration`, `title_filter_regex` (nullable): per-channel download filters/quality override, same semantics as the equivalent global settings. `audio_format` (VARCHAR(20), nullable): per-channel audio-only download format override. `default_rating` (VARCHAR(50), nullable): rating applied to otherwise-unrated videos in this channel. `skip_video_folder` (boolean, nullable): per-channel override of the global `defaultSkipVideoFolder` flat-file-structure setting; NULL = inherit global. `media_mode` (VARCHAR(20), nullable): per-channel override of the global `mediaMode` (`download`/`strm`/`both`); NULL = inherit global. `library_mode` (VARCHAR(20), nullable): per-channel override of the global `defaultLibraryMode` (`movie`/`series`); NULL = inherit global. `season_episode_regex` (TEXT, nullable): TV Series library mode only — optional regex with `(?P<season>)`/`(?P<episode>)` named groups to decode season/episode from a video title instead of the upload-year-as-season default. `terminated_at` (DATETIME, nullable): set when the channel is detected as terminated/removed on YouTube. `m3u_enabled` (boolean, default false): generate a `.m3u` playlist file in the channel folder. `m3u_sort_order` (string, default `oldest_first`): `.m3u` entry order, `oldest_first` or `newest_first`. `auto_removal_protected` (boolean, default false): exclude every video of this channel from auto-removal; only applies while the channel is subscribed (`enabled`), and enabling it clears `auto_removal_keep_recent_count`. `auto_removal_keep_recent_count` (int, nullable): auto-removal always keeps this many of the channel's most recently downloaded videos; mutually exclusive with `auto_removal_protected`, dormant while the channel is unsubscribed. |
| `Videos`           | `Video`           | Downloaded video metadata. `audioFilePath`/`audioFileSize` (nullable): path/size of a separately-tracked audio-only download of the same video. `content_rating` (JSON, nullable): raw content rating object from YouTube/yt-dlp. `age_limit` (int, nullable): age limit from yt-dlp. `normalized_rating` (VARCHAR(50), nullable): rating normalized for Plex/Kodi (e.g. `"R"`, `"PG-13"`, `"TV-14"`). `rating_source` (VARCHAR(100), nullable): where `normalized_rating` came from. `protected` (boolean, default false): excludes the video from auto-removal regardless of other settings. `video_resolution` (VARCHAR(20), nullable): actual pixel dimensions of the downloaded file, e.g. `"1920x1080"`, measured by ffprobe at download time and backfilled by the filesystem rescan; the displayed tier label (e.g. "1080p") is derived client-side (`client/src/utils/videoResolution.ts`), so labeling rules can change without re-probing; NULL = not yet checked or audio-only, `"0x0"` = probe failed (never shown in the UI). `is_strm` (boolean, default false): true when `filePath` points at a `.strm` stream shortcut instead of downloaded media (see [STRM.md](STRM.md)). `cached_at` (DATETIME, nullable): set only when this row was materialized from STRM via cache-on-play, never for a genuine/forced download; powers the scheduled revert-to-STRM sweep (`strm.cacheOnPlayExpiryHours`). `season`/`episode` (int, nullable): TV Series library mode assignment — season is the calendar year of `upload_date`, episode is the ordinal within that season; both are frozen once assigned (episode is append-only). `downloadDurationSeconds` (int, nullable): wall-clock time from download start to the file being verified on disk (includes yt-dlp post-processing). `avgDownloadMBps` (float, nullable): `fileSize / downloadDurationSeconds`, computed alongside it. |
| `channelvideos`    | `ChannelVideo`    | Channel <-> video associations, one row per video listed on a channel (independent of whether it was downloaded). `published_at_source` tracks publishedAt provenance: `exact` (.info.json), `approximate` (yt-dlp flat-playlist date), `estimated` (ordering-only placeholder assigned when YouTube returns a listing with no dates; never displayed), NULL (legacy, treated as approximate). `availability` (string, nullable): YouTube availability state (e.g. private/members-only). `live_status` (string, nullable): livestream/premiere state from YouTube. `ignored`/`ignored_at` (boolean/DATETIME, nullable): video manually excluded from the channel's video list (e.g. filtered out by a channel's title/duration filters retroactively). `content_rating`/`age_limit`/`normalized_rating`: same shape and meaning as the equivalent `Videos` columns, populated from the listing before a video is necessarily downloaded. |
| `Jobs`             | `Job`             | Download job queue. `aux_data` (MEDIUMTEXT, nullable): JSON snapshot of job data other than videos (failed downloads, diagnoses, skip counts, terminated channels), written on job save and merged back on startup load; NULL for jobs recorded before the column existed. `ytdlpCommand` (MEDIUMTEXT, nullable): the yt-dlp command line(s) run for this job, recorded for troubleshooting. |
| `JobVideos`        | `JobVideo`        | Job <-> video associations        |
| `JobVideoDownloads`| `JobVideoDownload`| Download progress tracking        |
| `Sessions`         | `Session`         | User authentication sessions      |
| `ApiKeys`          | `ApiKey`          | API key credentials for external integrations (bookmarklets, shortcuts, automation) |
| `playlists`        | `Playlist`        | Subscribed YouTube playlists with per-playlist sync targets and seeded settings. `video_count` (int, default 0): cached playlist size from YouTube. `enabled`/`auto_download` (boolean, default false): tracked and auto-download flags, same roles as `channels.enabled`/auto-download. `sync_to_plex`/`sync_to_jellyfin`/`sync_to_emby` (boolean, default true): whether this playlist is mirrored to each connected media server as a native playlist. `public_on_servers` (boolean, default false): make the synced playlist visible to other server users, not just its owner. `sort_order` (STRING NOT NULL, default `'default'`): saved output order for the `.m3u` file and media server sync; `'reversed'` flips the YouTube playlist order. `default_sub_folder` (string, nullable): per-playlist subfolder; defaults to the global-default sentinel, NULL means "download to root" (an explicit choice, not "unset"). `video_quality`, `min_duration`, `max_duration`, `title_filter_regex`, `audio_format`, `default_rating`: same per-playlist download filter/quality/rating overrides as the equivalent `channels` columns. `media_mode`/`library_mode` (nullable): per-playlist overrides of the global `mediaMode`/`defaultLibraryMode`; NULL = inherit global. `lastFetched` (DATETIME, nullable): last time this playlist's video listing was refreshed. `auto_download_baseline_at` (DATETIME, nullable): seed-then-track baseline for playlist auto-downloads; NULL until the first auto-download run. |
| `playlistvideos`   | `PlaylistVideo`   | One row per (playlist, video) with the YouTube playlist position (`position`), cached listing metadata (`title`, `thumbnail`, `duration`, `published_at`, `channel_id`, `channel_name`), and `ignored`/`ignored_at` (same meaning as `channelvideos`). |
| `playlist_sync_state` | `PlaylistSyncState` | Per-(playlist, server) sync state: server playlist id, last_synced_at, last_error |
| `subfolders`       | `Subfolder`       | Durable registry of known subfolder names (id, name unique, createdAt, updatedAt). Backfilled from channels, playlists, and video file paths by the `add-subfolders-table` migration; kept current by register-on-create and register-on-download-override. |
| `video_watch_status` | `VideoWatchStatus` | Per-video, per-media-server, per-user watch state pulled by the watch status sync. Absence of a row means never synced/unknown, not unwatched. Columns: `video_id`, `server_type` (`plex`/`jellyfin`/`emby`), `server_user_id` (Plex owner is `'1'`), `played`, `play_count`, `position_ms`, `percent_watched`, `last_watched_at`, `last_synced_at`. Unique index on `(video_id, server_type, server_user_id)`. |
| `media_server_users` | `MediaServerUser` | Media-server account directory populated during watch status sync: `server_type`, `server_user_id`, `server_user_name`. Unique index on `(server_type, server_user_id)`. Used to display which users watched a video. |
| `watch_status_sync_cursors` | `WatchStatusSyncCursor` | Durable per-server watch-status sync cursor (unique `server_type`, `cursor` DATETIME). Today only Plex uses it: the newest play-history event scanned, so incremental pulls never permanently skip events. Deleting a row forces a full history re-scan on the next sync. |
| `stream_history`   | `StreamHistory`   | One row per `/api/ytstream` playback session (see [YTSTREAM.md](YTSTREAM.md)). Columns: `stream_id` (unique), `youtube_id`, `mode`, `quality`, `container`, `transcode`, `hardware_mode`, `client_ip`, `user_agent`, `started_at`/`ended_at` (DATE(3), millisecond precision — needed to tell closely-spaced sessions apart in the Streaming activity table), `bytes_transferred`, `end_reason`, `error_message`. Pruned nightly (3:15 AM) by `ytstream.historyRetentionDays` (default 90; `<= 0`/unset falls back to 90). |
| `youtube_metadata_cache` | `YoutubeMetadataCache` | Cache of yt-dlp metadata lookups, keyed by `youtube_id` (primary key). `duration_seconds`. `raw_info_json` (LONGTEXT, nullable): the full yt-dlp `-j` extraction blob whenever a live lookup runs one, cached wholesale so future fields (fps, formats/height, etc.) are available without re-extracting; parse with `JSON.parse`, never queried/filtered on directly. `fetched_at`/`last_accessed_at`. |
| `nzb_diagnostic_log` | `NzbDiagnosticLog` | Diagnostic history for the Sonarr/Radarr (Newznab/SABnzbd) integration (see [NZB.md](NZB.md)). `kind` (ENUM `query`/`trace`/`failedGrab`). `payload` (MEDIUMTEXT): the original recentQueries/searchTraces/failedGrabs object, JSON-serialized wholesale rather than split into three tables with real columns. |
| `nzb_resolution_cache` | `NzbResolutionCache` | Cache of detected video resolution for the NZB search integration's `resolutionDetection`, keyed by `youtube_id` (primary key). `definition` (ENUM `hd`/`sd`). `height_tier` (int, nullable). `source` (ENUM `thumb`/`extract`): which detection method produced this result. |
| `job_events`       | `JobEvent`        | Append-only video/events log (`server/modules/jobEventLog`): one row per step in a video's or job's life, written once when it happens and never updated, so history cannot drift the way Download History (which recomputes status text from live state) can. `occurred_at` (DATE(3), millisecond precision, stamped at the call site). `job_id`/`youtube_id` (both nullable, **no foreign keys** so rows outlive the Jobs/Videos rows they describe). `event_type` (e.g. `video.failed`, `nzb.untracked`), `level` (`info`/`warn`/`error`), `actor`, `message` (rendered once at write time and stored frozen), `detail` (MEDIUMTEXT JSON, capped at 16 KB), and a write-time snapshot in `video_title`/`channel_name`/`job_type` so a row stays readable after its Video or Job is deleted. `is_tracked` (BOOLEAN, nullable) records whether the video had a library row at that moment - `NULL` means it was not known then (including every row written before the column existed). Pruned nightly (3:25 AM) by `jobEventLogRetentionDays` (default 180, `0` keeps everything). |
| `SequelizeMeta`    | NA                | Sequelize ORM migration tracking  |

## Internal Database (Default)

### Container Details
- **Image**: `mariadb:10.3`
- **Container Name**: `youtarr-db`
- **Port**: 3321 inside the Docker network only; the bundled database is not published to the host
- **Character Set**: `utf8mb4` (full Unicode/emoji support)
- **Default Credentials**:
  - User: `root`
  - Password: `123qweasd` (change in production!)
  - Database: `youtarr`

### Storage Options

#### Option 1: Bind Mount (legacy / pre-existing installs)
```yaml
volumes:
  - ./database:/var/lib/mysql
```
- Data stored in `./database` directory on the host
- Kept for backwards compatibility with existing bind-mounted installs and plain `docker compose up -d` users
- Works well on native Linux Docker hosts
- Can have permission issues on Synology/QNAP
- Can corrupt during MariaDB schema migrations on Docker Desktop for Windows/macOS, ARM hosts, and some virtualized filesystems

#### Option 2: Named Volume (Recommended for Docker Desktop/ARM/NAS)
```yaml
volumes:
  - youtarr-db-data:/var/lib/mysql
```
- Better compatibility with Synology/QNAP
- Avoids the virtualized-filesystem write semantics problem that can affect bind-mounted MariaDB
- Used automatically for fresh installs started with `./start.sh` on every platform (Linux included, since v1.69)
- Recommended for Docker Desktop on Windows/macOS, ARM systems, and NAS setups
- Not easily visible on host: data lives under `/var/lib/docker/volumes/<project>_youtarr-db-data/_data` rather than `./database/`. `./scripts/backup.sh` dumps from the running MariaDB container when it is already up; when it has to start MariaDB for a backup, it detects whether this install uses the bind mount or named volume first.

### Migrating from Bind Mount to Named Volume

If you already have Youtarr-Turbo data in `./database/`, do **not** switch the compose mount by hand unless you intentionally want to start with an empty database. Use the migration helper instead:

```bash
./scripts/migrate-to-named-volume.sh
```

What the script does (in this order, so any failure leaves the simplest possible recovery state):
1. Runs a pre-flight permissions check so it fails fast (instead of stalling on an interactive `sudo` prompt) if it cannot write to the project directory.
2. Stops Youtarr-Turbo.
3. Starts the existing bind-mounted MariaDB long enough to run `mysqldump` and to capture per-table row counts.
4. Renames `./database/` to `./database.bind-mount-backup.<timestamp>/` so the original files are preserved.
5. Starts a fresh named-volume MariaDB and imports the dump.
6. Verifies that the table set matches the source **and** that every table has the same row count as the source.
7. **Only after verification succeeds**, snapshots `.env` to `./.env.bak.<timestamp>` and pins `COMPOSE_PATH_SEPARATOR=:` and `COMPOSE_FILE=docker-compose.yml:docker-compose.arm.yml` in `.env`. This means a failure during step 5 or 6 leaves `.env` untouched, and recovery is just `mv ./database.bind-mount-backup.<timestamp> ./database` plus removing the partial named volume.
8. Brings the full stack (app + database) back up so Youtarr-Turbo is immediately usable.

**What the migration does *not* copy**: `mysqldump` runs with `--single-transaction --routines --triggers --events`. Schema, data, stored routines, triggers, and events all migrate. MariaDB users and `GRANT` statements (anything in `mysql.user` / `mysql.db`) do **not**. The default Youtarr-Turbo install only uses the bundled `root` user, so this is a no-op for almost everyone. If you have created additional database users on the bundled MariaDB, recreate them after the migration completes.

**Password note**: for the bundled `root` database user, `DB_ROOT_PASSWORD` seeds the root password when a fresh MariaDB data directory is initialized, while Youtarr-Turbo connects with `DB_PASSWORD`. The migration requires those two values to match before it creates the new named-volume database.

After it completes, the stack is already running. Subsequent restarts can use any of:

```bash
./start.sh                                                       # recommended
docker compose up -d                                             # the script pins COMPOSE_FILE in .env
docker compose -f docker-compose.yml -f docker-compose.arm.yml up -d  # explicit override
```

### Reverting to Bind Mount

The migration is reversible:

1. Stop the stack:
   ```bash
   ./stop.sh
   ```
2. Restore the `.env` snapshot:
   ```bash
   mv ./.env.bak.<timestamp> .env
   ```
3. Remove the named volume for this install. The name is usually `<project>_youtarr-db-data`:
   ```bash
   docker volume ls --format '{{.Name}}' | grep -E '(^|_)youtarr-db-data$'
   docker volume rm <volume-name>
   ```
4. Restore the original bind-mounted database directory:
   ```bash
   mv ./database.bind-mount-backup.<timestamp> ./database
   ```
5. Start Youtarr-Turbo:
   ```bash
   ./start.sh
   ```

Changes made while running on the named volume are not present in the old bind-mounted backup. If you have used the named volume for a while and want to keep those newer changes, take a backup first with `./scripts/backup.sh`.

### Fresh Installs with Named Volume

For a new install with no data to preserve, you can start directly with the named-volume override:

```bash
docker compose -f docker-compose.yml -f docker-compose.arm.yml up -d
```

Or pin the override in `.env` so plain `docker compose up -d` uses it:

```env
COMPOSE_PATH_SEPARATOR=:
COMPOSE_FILE=docker-compose.yml:docker-compose.arm.yml
```

`COMPOSE_PATH_SEPARATOR=:` is important on Windows so Compose parses the file list consistently.

### Security Considerations

#### Changing Default Credentials
1. Edit `.env` file:
   ```bash
   DB_USER=youtarr
   DB_PASSWORD=secure-password-here
   DB_ROOT_PASSWORD=different-secure-password
   ```

2. If using non-root user, uncomment in `docker-compose.yml`:
   ```yaml
   environment:
     - MYSQL_USER=${DB_USER}
     - MYSQL_PASSWORD=${DB_PASSWORD}
   ```

3. Restart containers for changes to take effect

**Warning**: The bundled database is not exposed to the host by default. If you manually publish port 3321, keep it restricted to trusted hosts only.

## External Database Setup

### Requirements
- MariaDB 10.3+ or MySQL 8.0+
- Database with `utf8mb4` character set
- User with full privileges on the database
- Network connectivity from Youtarr-Turbo container

### Step 1: Prepare External Database

Run on your database server:

**Note**: The example below assumes you are using `youtarr` for your DB name and `youtarr` for your DB user.

```sql
CREATE DATABASE youtarr
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'youtarr'@'%'
  IDENTIFIED BY 'your-secure-password';

GRANT ALL PRIVILEGES ON youtarr.*
  TO 'youtarr'@'%';

FLUSH PRIVILEGES;
```

Replace `'%'` with specific IP/network if restricting access.

### Step 2: Configure Youtarr-Turbo

Edit `.env` file:
```bash
DB_HOST=192.168.1.100  # Your database server IP
DB_PORT=3306           # Your database port
DB_USER=youtarr        # Database username
DB_PASSWORD=your-secure-password
DB_NAME=youtarr        # Database name
```

### Step 3: Start with External Database

Using convenience script:
```bash
./start-with-external-db.sh
```

Or manually:
```bash
docker compose -f docker-compose.external-db.yml up -d
```

### Reverting to Internal Database
Simply run the normal start script:
```bash
./start.sh
```

## Database Migrations

### How Migrations Work
- Migrations run automatically on container startup
- Tracked in `SequelizeMeta` table
- Located in `/app/migrations/` inside container
- Idempotent - safe to run multiple times

### Creating New Migrations
```bash
# Use the provided script
./scripts/db-create-migration.sh my-migration-name

# Or use npm directly
npm run db:create-migration -- --name my-migration-name
```

### Migration Best Practices
1. **Always use helpers** for idempotent operations:
   ```javascript
   const { tableExists, columnExists, createTableIfNotExists } = require('./helpers');

   if (!await columnExists(queryInterface, 'videos', 'duration')) {
     await queryInterface.addColumn('videos', 'duration', {...});
   }
   ```

2. **Test migrations** in development first
3. **Never modify** existing migration files
4. **Create new migrations** for schema changes

## Troubleshooting Database Issues

### Permission Failures

#### Symptoms
- `InnoDB: Operating system error number 13`
- MariaDB container fails to start
- Permission denied errors in logs

#### Common Causes
1. **Synology/QNAP NAS**: MariaDB runs as UID 999, which may not exist
2. **Docker Desktop/ARM/NAS**: virtualized filesystem or permission issues with bind-mounted MariaDB data
3. **Wrong ownership**: Database files owned by incorrect user

#### Solutions
1. **Migrate to named volume** (see above)
2. **Fix permissions**:
   ```bash
   # Check current ownership
   ls -la ./database

   # Fix ownership (adjust UID:GID as needed)
   sudo chown -R 999:999 ./database
   ```

### Duplicate Column Errors

#### Symptoms
- `Duplicate column name 'duration'`
- `Table 'channelvideos' already exists`
- Migration errors after crash/restore

#### Cause
Lost or corrupted `SequelizeMeta` table causing migrations to re-run

#### Solution
With recent updates, migrations are idempotent and self-healing:
1. Simply restart the container:
   ```bash
   docker compose down
   docker compose up -d
   ```

2. If errors persist, manually check:
   ```bash
   # Connect to database
   docker exec -it youtarr-turbo-db mysql -u root -p123qweasd youtarr

   # Check SequelizeMeta
   SELECT * FROM SequelizeMeta;

   # If missing, migrations will re-run safely
   ```

### Connection Issues

#### Cannot Connect to Database
1. **Check container status**:
   ```bash
   docker ps | grep youtarr-turbo-db
   ```

2. **Test connection**:
   ```bash
   # From inside the database container
   docker compose exec youtarr-db mysql -u root -p123qweasd youtarr
   ```

3. **Check logs**:
   ```bash
   docker logs youtarr-turbo-db
   ```

#### Authentication Failures
- Verify credentials match in `.env` and database
- Check user permissions: `SHOW GRANTS FOR 'youtarr'@'%';`
- Ensure user can connect from container IP

### Character Set Issues

#### Symptoms
- Emoji not saving correctly
- UTF-8 encoding errors
- Question marks in text

#### Solution
Ensure database uses `utf8mb4`:
```sql
-- Check database charset
SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
FROM information_schema.SCHEMATA
WHERE SCHEMA_NAME = 'youtarr';

-- Convert if needed
ALTER DATABASE youtarr
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

## Storage Considerations

### Database Size Estimates
- **Per Channel**: ~1-2 KB metadata
- **Per Video**: ~5-10 KB metadata
- **Growth Rate**: ~10 MB per 1000 videos
