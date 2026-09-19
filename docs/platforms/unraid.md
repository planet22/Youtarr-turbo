# Youtarr-Turbo on Unraid

Youtarr-Turbo is not in the Unraid **Community Applications** store. The store's "Youtarr" template installs the upstream [DialmasterOrg/Youtarr](https://github.com/DialmasterOrg/Youtarr) image, which does not include any of the Turbo features (STRM streaming, ytstream, Sonarr/Radarr bridge, and so on), so don't use it for this fork. Instead, add the container by hand from the Turbo image:

```
ghcr.io/planet22/youtarr-turbo:latest
```

Two ways to run it:

- **Option A (recommended): a manual Docker container plus a MariaDB container.** Uses Unraid's normal Docker tab, so it shows up with an icon, autostart, and update checks like any other container. Covered below.
- **Option B: the repo's `docker-compose.yml`** (which bundles its own MariaDB) through the Docker Compose Manager plugin. Covered [at the end](#option-b-docker-compose-manager).

## Deploying on Unraid (Option A)

### Install and set up MariaDB

1. Install the **Community Applications** plugin if you haven't already.
2. From the **Apps** tab, install the **MariaDB Official** container. The upstream MariaDB template is fine here; only the Youtarr-Turbo template is the problem.
   - See the [External Database Guide](external-db.md) for more on using a database that isn't bundled with Youtarr-Turbo.

#### If this is the first time you've installed the MariaDB Official container

Set the following options and make a note of them; you'll need the same values in the Youtarr-Turbo container:
- `Database Name`: `youtarr` is recommended
- `Database User`: `youtarr` is recommended
- `Port`: leave as the default of `3306`
- `Database Password`: choose something secure
- `MYSQL_ROOT_PASSWORD`: choose something secure and write it down; you'll need it any time you have to log into MariaDB directly
- `MARIADB_RANDOM_ROOT_PASSWORD`: **leave this field completely blank.** It's a boolean, and *any* value in it (even the literal string "No") tells MariaDB to ignore your `MYSQL_ROOT_PASSWORD` and generate a random one instead, which you'll never see unless you grep it out of the container logs.

> **Important**: These env vars only take effect the *first time* MariaDB initializes its data directory. If you set them wrong, start the container, and then change them, the changes are silently ignored. The only fix at that point is to stop MariaDB, wipe whatever data path you mapped in the template (e.g. `/mnt/user/appdata/mariadb-official/`), and let it re-initialize from scratch.

The first time MariaDB runs it creates the database and user for Youtarr-Turbo.

#### If you already have a MariaDB instance

Create a database and user for Youtarr-Turbo in that instance and note the port, database name, user, and password. See [external-db.md](external-db.md) for the SQL. MariaDB 10.3+ or MySQL 8.0+ works.

**NOTE**: Your MariaDB instance *must* be up and running before Youtarr-Turbo starts.

> **Warning: Do not update MariaDB and Youtarr-Turbo at the same time.** If you update the MariaDB Official container and Youtarr-Turbo together, MariaDB may still be upgrading its internal data files when Youtarr-Turbo's migrations run, which can corrupt tables and cause data loss. Always update MariaDB first, confirm it's fully running (check its logs for "ready for connections"), then update Youtarr-Turbo. See the [External Database Guide](external-db.md) for more details.

### Create the Youtarr-Turbo container

1. Open the **Docker** tab and click **Add Container**.
2. Turn on **Advanced View** (top right) so the Extra Parameters field is visible.
3. Fill in the basics:

   | Field | Value |
   |---|---|
   | Name | `youtarr-turbo` |
   | Repository | `ghcr.io/planet22/youtarr-turbo:latest` |
   | Network Type | `bridge` |
   | WebUI | `http://[IP]:[PORT:3011]` |

4. Add a **Port** (Add another Path, Port, Variable...):
   - Container Port `3011`, Host Port `3011` (or any free host port; `3087` is the docker-compose default).

5. Add these **Paths** (host path on the left, container path on the right). The container paths are fixed:

   | Host path (example) | Container path | Purpose |
   |---|---|---|
   | `/mnt/user/media/youtube` | `/usr/src/app/data` | Downloaded videos (and `.strm` files). Point this at your media share. |
   | `/mnt/user/appdata/youtarr-turbo/config` | `/app/config` | `config.json`, cookies, setup token |
   | `/mnt/user/appdata/youtarr-turbo/images` | `/app/server/images` | Cached channel and video artwork |
   | `/mnt/user/appdata/youtarr-turbo/jobs` | `/app/jobs` | Job state and the yt-dlp metadata info cache |

   > Do **not** map anything over the image's `migrations` directory. An empty mapped folder overwrites the packaged migrations and breaks database setup.

6. Add these **Variables**:

   | Variable | Value | Notes |
   |---|---|---|
   | `DB_HOST` | the Unraid LAN IP, e.g. `192.168.1.100` | Just the bare IP: no `http://`, no trailing slash. Don't use `127.0.0.1` or `localhost`, which refer to the container itself. |
   | `DB_PORT` | `3306` | Match the MariaDB port you mapped |
   | `DB_NAME` | `youtarr` | |
   | `DB_USER` | `youtarr` | |
   | `DB_PASSWORD` | your database password | |
   | `YOUTUBE_OUTPUT_DIR` | the same host path as the data mapping, e.g. `/mnt/user/media/youtube` | Informational: tells the app where videos live on the host |
   | `TZ` | e.g. `Europe/London` | Used for schedules such as the download cron |
   | `AUTH_PRESET_USERNAME` / `AUTH_PRESET_PASSWORD` | your login | Optional. 1-32 and 8-64 characters respectively, or they're ignored. If left blank, use the one-time setup token from the container log or `config/setup-token` on first visit. |

   Leave `AUTH_ENABLED` at its default (`true`) unless Youtarr-Turbo is only reachable over LAN/VPN or sits behind an authenticating reverse proxy. See [ENVIRONMENT_VARIABLES.md](../ENVIRONMENT_VARIABLES.md) for the full list.

7. Click **Apply**. Once it's running, open `http://<your-unraid-ip>:3011` (or the host port you chose).

### Streaming (STRM + ytstream) on Unraid

If you're using STRM mode, media servers open `.strm` files that point back at Youtarr-Turbo's `/api/ytstream` route, so:

- Set **Settings → Streaming → Base URL** (`strm.proxyBaseUrl`) to an address your media server and clients can reach, e.g. `http://192.168.1.100:3011`. Not `127.0.0.1`.
- If Jellyfin/Plex runs in another container on the same Unraid box, the LAN IP and mapped port work from both.
- The image already includes ffmpeg and yt-dlp. Follow [GETTING_STARTED_STREAMING.md](../GETTING_STARTED_STREAMING.md) to pick a playback mode.

#### Hardware transcoding (optional)

Only needed if you choose a mode that re-encodes (e.g. Enhanced HLS + Buffered with Transcode set to H.264) or use the post-download transcode.

- **Intel / AMD (QSV, VAAPI):** add `--device=/dev/dri` to **Extra Parameters**. Then run the **Hardware Capabilities Test** in Settings → Streaming to see what actually works on your host.
- **NVIDIA (NVENC):** install the Nvidia Driver plugin, add `--runtime=nvidia` to **Extra Parameters**, and add the variables `NVIDIA_VISIBLE_DEVICES` (your GPU UUID) and `NVIDIA_DRIVER_CAPABILITIES` (`all`).
- If you also run Youtarr-Turbo as non-root (below) and every hardware row in the capabilities test fails as "Unsupported", the container user probably can't open `/dev/dri`. Check `ls -la /dev/dri` on the host and add the owning group with `--group-add=<gid>`.

## Troubleshooting MariaDB connection issues

If Youtarr-Turbo can't connect to MariaDB on startup, check the MariaDB container logs first. The common ones:

- **`Access denied for user 'youtarr'@'172.17.0.1' (using password: YES)`** in the MariaDB log: the password Youtarr-Turbo is sending doesn't match what MariaDB has stored. Either there's a typo between the two containers, or you set MariaDB up earlier with different credentials and the data dir still has the old ones. Env var changes are ignored after first init (see the warning in the setup section above).
- **`Can't connect to MariaDB server`** in the Youtarr-Turbo log: `DB_HOST` or `DB_PORT` is wrong. Use the Unraid LAN IP, no `http://` prefix, no trailing slash, and not `127.0.0.1`/`localhost`.
- **You can't even log in to MariaDB as root with the password you set**: the data dir was initialized with a random root password, almost certainly because `MARIADB_RANDOM_ROOT_PASSWORD` had a value in it on first start. Check the container logs from that first startup:
  ```
  docker logs MariaDB 2>&1 | grep -i "GENERATED ROOT PASSWORD"
  ```
  If you find it, log in with `docker exec -it MariaDB mariadb -uroot -p` and reset everything from there. If the logs have rotated and grep finds nothing, the only path forward is to stop MariaDB, wipe the mapped data directory, and start it again with `MARIADB_RANDOM_ROOT_PASSWORD` blank.

> Newer MariaDB images use `mariadb` as the client binary, not `mysql`. If `docker exec ... mysql` returns "executable file not found in $PATH", use `mariadb` instead.

## Updating

Unraid's Docker tab can check for updates to `ghcr.io/planet22/youtarr-turbo:latest` and update in place; your config, database, and videos are kept because they live in the mapped paths. Update MariaDB first if both have updates (see the warning above). See [INSTALLATION.md](../INSTALLATION.md#how-to-update-to-the-latest-version) for what happens during an update.

## Running as Non-Root User

By default, Youtarr-Turbo runs as root inside the container. This works fine for most setups, but if you need Plex or Jellyfin to be able to delete files that Youtarr-Turbo downloads, you'll need to run it as a non-root user with matching permissions.

**Note**: The `YOUTARR_UID` and `YOUTARR_GID` environment variables do not work on Unraid. You must use the `--user` parameter instead.

### Steps to Run as Non-Root

1. **Stop the youtarr-turbo container** if it's running.

2. **Set correct ownership on your directories** by opening an Unraid terminal and running:
   ```bash
   chown -R 99:100 /mnt/user/appdata/youtarr-turbo
   chown -R 99:100 /path/to/your/youtube_videos
   ```
   Replace the paths with your actual mapped directories. The `99:100` corresponds to the `nobody:users` user/group on Unraid. The config, images, and jobs folders all live under `/mnt/user/appdata/youtarr-turbo/` in this guide, so recursing from the top with `chown -R` covers all of them in one shot.

3. **Add the user parameter to your container**:
   - Edit the youtarr-turbo container in Unraid
   - Scroll down to "Extra Parameters"
   - Add: `--user 99:100`
   - Click "Apply" to restart the container

4. **Verify it's working** by running:
   ```bash
   docker exec -it youtarr-turbo sh -c 'id'
   ```
   You should see `uid=99(nobody) gid=100(users)` instead of `uid=0(root)`.

After this setup, Youtarr-Turbo will create files with `nobody:users` ownership, which matches the default permissions that Plex and other media apps use on Unraid, allowing them to delete files as needed.

## Troubleshooting file permissions over SMB (Windows, macOS)

If you can see Youtarr-Turbo's downloaded videos on a Windows or macOS SMB share but can't move, rename, or delete them ("You require permission from TOWER\nobody to make changes to this file" on Windows, or a padlock icon on macOS), the cause is almost always the file mode, not the ownership.

Older versions wrote files with mode `644` (`rw-r--r--`), which means only the file owner (`nobody`) could modify them. If your SMB client authenticated as any other user, access was read-only. Current versions write downloads as `664` / directories as `775` by default, so **new downloads do not need any repair**.

**One-time repair for files downloaded before this change:**
```bash
find /path/to/your/youtube_videos -type f -exec chmod 664 {} \;
find /path/to/your/youtube_videos -type d -exec chmod 775 {} \;
```

Separately, your SMB share must be configured so the connecting user is either mapped to `nobody` or is a member of the `users` group, otherwise even group-writable files will still appear read-only. On Unraid, the simplest path is Shares -> edit the share -> SMB Security Settings -> set to `Public`, which maps all SMB users to `nobody`.

## Option B: Docker Compose Manager

If you prefer compose, the [Docker Compose Manager](https://forums.unraid.net/topic/114415-plugin-docker-compose-manager/) plugin can run the repo's `docker-compose.yml`, which starts Youtarr-Turbo **and** its own MariaDB, so you skip the separate MariaDB container above.

1. Install **Docker Compose Manager** from Community Applications.
2. Under **Docker**, add a new stack named `youtarr-turbo` and paste in the contents of [`docker-compose.yml`](../../docker-compose.yml).
3. Edit the stack's `.env` with at least `YOUTUBE_OUTPUT_DIR` (your media share) and your `DB_*`/`AUTH_*` values from [ENVIRONMENT_VARIABLES.md](../ENVIRONMENT_VARIABLES.md).
4. In the compose file, change the relative volume paths (`./database`, `./config`, `./jobs`, `./server/images`) to absolute paths under `/mnt/user/appdata/youtarr-turbo/`, so Unraid's appdata backups and permissions apply to them.
5. Compose up. The web UI is on port `3087` by default (`YOUTARR_HOST_PORT`).

To run as `nobody:users`, set `YOUTARR_UID=99` and `YOUTARR_GID=100` in the stack's `.env` (the compose file passes them to the service's `user:` line) and `chown -R 99:100` your appdata and media paths. The containers are named `youtarr-turbo` and `youtarr-turbo-db`.
