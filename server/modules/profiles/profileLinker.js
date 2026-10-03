// Filesystem side of user profiles: hardlinks library files into
// <output>/__profiles__/<profile>/ and removes them again. Never touches the
// library originals - every write and delete is confined to a profile root.
const fs = require('fs').promises;
const path = require('path');
const logger = require('../../logger');
const { MEDIA_EXTENSIONS, M3U_FILE_PATTERN, YOUTUBE_ID_BRACKET_PATTERN, PROFILES_DIR_NAME } = require('../filesystem/constants');
const { splitLibraryPath, mapToProfilePath, profileRootPath, isInside } = require('./profilePaths');

// .cached = archived STRM sidecars kept next to a cache-on-play download so it
// can be reverted; they're Youtarr bookkeeping, not library content.
const TEMP_FILE_PATTERN = /\.(part|ytdl|tmp|cached)$/i;

function isOwnVideoFolder(dir, youtubeId) {
  const name = path.basename(dir);
  return name === youtubeId || name.endsWith(` - ${youtubeId}`);
}

function isMediaFile(name) {
  return MEDIA_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

async function readFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && !e.name.startsWith('.') && !TEMP_FILE_PATTERN.test(e.name));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

async function hasMediaFile(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isFile() && isMediaFile(entry.name)) return true;
    if (entry.isDirectory() && await hasMediaFile(path.join(dir, entry.name))) return true;
  }
  return false;
}

class ProfileLinker {
  /**
   * The video's own files: everything in its per-video folder (nested), or
   * the files carrying its id when it sits directly in a channel/season folder (flat).
   * @returns {Promise<string[]>} absolute library paths
   */
  async collectVideoFiles(video) {
    const id = video.youtubeId;
    const files = new Set();
    for (const mediaPath of [video.filePath, video.audioFilePath].filter(Boolean)) {
      const dir = path.dirname(mediaPath);
      const nested = isOwnVideoFolder(dir, id);
      for (const entry of await readFiles(dir)) {
        if (nested || entry.name.includes(`[${id}]`) || entry.name.includes(` - ${id}`)) {
          files.add(path.join(dir, entry.name));
        }
      }
    }
    return [...files];
  }

  /**
   * Shared artwork/nfo (poster.jpg, tvshow.nfo, season.nfo, ...) in the
   * folders between the channel root and the video's files.
   * @returns {Promise<string[]>}
   */
  async collectSidecars(baseDir, video, videoFiles) {
    const dirs = new Set();
    for (const file of videoFiles) {
      const parts = splitLibraryPath(baseDir, file);
      if (!parts) continue;
      let dir = path.dirname(file);
      while (dir === parts.channelRoot || isInside(parts.channelRoot, dir)) {
        if (!isOwnVideoFolder(dir, video.youtubeId)) dirs.add(dir);
        if (dir === parts.channelRoot) break;
        dir = path.dirname(dir);
      }
    }

    const sidecars = [];
    for (const dir of dirs) {
      for (const entry of await readFiles(dir)) {
        if (isMediaFile(entry.name) || M3U_FILE_PATTERN.test(entry.name) || YOUTUBE_ID_BRACKET_PATTERN.test(entry.name)) {
          continue;
        }
        sidecars.push(path.join(dir, entry.name));
      }
    }
    return sidecars;
  }

  /**
   * Idempotent: an existing link to the same inode is left alone, a stale
   * file at dest (e.g. the library file was re-downloaded) is replaced.
   */
  async linkFile(src, dest) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.link(src, dest);
      return;
    } catch (err) {
      if (err.code === 'EXDEV') {
        logger.warn({ src, dest }, 'profiles: profile folder is on a different filesystem than the library - falling back to a real copy (doubles disk usage)');
        await fs.copyFile(src, dest);
        return;
      }
      if (err.code !== 'EEXIST') throw err;
    }
    const [srcStat, destStat] = await Promise.all([fs.stat(src), fs.stat(dest)]);
    if (srcStat.ino === destStat.ino && srcStat.dev === destStat.dev) return;
    await fs.unlink(dest);
    await fs.link(src, dest);
  }

  /**
   * Link one video (plus its folders' shared sidecars) into a profile.
   * @returns {Promise<string[]>} the profile paths of the video's own files
   */
  async linkVideo(baseDir, profileName, video) {
    const videoFiles = await this.collectVideoFiles(video);
    const linked = [];
    for (const src of videoFiles) {
      const dest = mapToProfilePath(baseDir, profileName, src);
      if (!dest) continue;
      await this.linkFile(src, dest);
      linked.push(dest);
    }
    if (linked.length === 0) return linked;

    for (const src of await this.collectSidecars(baseDir, video, videoFiles)) {
      const dest = mapToProfilePath(baseDir, profileName, src);
      if (!dest) continue;
      try {
        await this.linkFile(src, dest);
      } catch (err) {
        logger.warn({ err, src, dest }, 'profiles: failed to link sidecar file');
      }
    }
    return linked;
  }

  /**
   * Remove links, then prune folders that no longer hold any media
   * (leftover sidecars only), stopping at the profile root.
   */
  async unlinkPaths(baseDir, profileName, linkPaths) {
    const root = profileRootPath(baseDir, profileName);
    const dirs = new Set();
    for (const linkPath of linkPaths) {
      if (!isInside(root, linkPath)) {
        logger.warn({ linkPath, root }, 'profiles: refusing to delete a path outside the profile folder');
        continue;
      }
      try {
        await fs.unlink(linkPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      dirs.add(path.dirname(linkPath));
    }
    for (const dir of dirs) {
      await this.pruneUpward(root, dir);
    }
  }

  async pruneUpward(root, dir) {
    let current = dir;
    while (isInside(root, current)) {
      if (await hasMediaFile(current)) return;
      await fs.rm(current, { recursive: true, force: true });
      current = path.dirname(current);
    }
  }

  async ensureProfileRoot(baseDir, profileName) {
    await fs.mkdir(profileRootPath(baseDir, profileName), { recursive: true });
  }

  async renameProfileRoot(baseDir, oldName, newName) {
    const from = profileRootPath(baseDir, oldName);
    const to = profileRootPath(baseDir, newName);
    try {
      await fs.rename(from, to);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await fs.mkdir(to, { recursive: true });
    }
  }

  async removeProfileRoot(baseDir, profileName) {
    const root = profileRootPath(baseDir, profileName);
    if (!isInside(path.join(baseDir, PROFILES_DIR_NAME), root)) {
      throw new Error(`Refusing to remove ${root}: not inside the profiles directory`);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

module.exports = new ProfileLinker();
