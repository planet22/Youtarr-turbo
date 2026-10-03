// Pure path logic for profile folders: <output>/__profiles__/<profile name>/...
const path = require('path');
const { PROFILES_DIR_NAME } = require('../filesystem/constants');
const { isSubfolderDirectory } = require('../filesystem/pathBuilder');

function profileRootPath(baseDir, profileName) {
  return path.join(baseDir, PROFILES_DIR_NAME, profileName);
}

/**
 * Split a library path into its channel-relative parts. The __subfolder
 * segment is dropped so every profile is one flat tree of channel folders.
 * @param {string} baseDir
 * @param {string} absPath
 * @returns {{channelRoot: string, channelRelative: string}|null} null when the
 *   path is outside baseDir, inside the profiles directory, or not in a channel folder
 */
function splitLibraryPath(baseDir, absPath) {
  if (!baseDir || !absPath) return null;
  const rel = path.relative(baseDir, absPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const segments = rel.split(path.sep);
  if (segments[0] === PROFILES_DIR_NAME) return null;

  const channelIndex = isSubfolderDirectory(segments[0]) ? 1 : 0;
  // Need at least a channel folder plus the file itself below it.
  if (segments.length < channelIndex + 2) return null;

  return {
    channelRoot: path.join(baseDir, ...segments.slice(0, channelIndex + 1)),
    channelRelative: path.join(...segments.slice(channelIndex)),
  };
}

/**
 * Where a library file is linked inside a profile folder.
 * @returns {string|null}
 */
function mapToProfilePath(baseDir, profileName, absPath) {
  const parts = splitLibraryPath(baseDir, absPath);
  if (!parts) return null;
  return path.join(profileRootPath(baseDir, profileName), parts.channelRelative);
}

/**
 * True when target is strictly inside root (guards every recursive delete).
 */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = {
  profileRootPath,
  splitLibraryPath,
  mapToProfilePath,
  isInside,
};
