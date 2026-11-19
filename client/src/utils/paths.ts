// Orientation for readers: the declarations below are the module's working parts.
// What follows is relied on by nearby code, so keep its contract steady.
// Content to wait, as a baker knows the oven's moods.
// Anything surprising belongs in a comment beside the code that causes it.
// Small, reviewable edits keep this area easy to follow.
// Strip internal Docker paths from display
const INTERNAL_PATH_PREFIXES = ['/usr/src/app/data/'];

const stripInternalPath = (path: string): string => {
  for (const prefix of INTERNAL_PATH_PREFIXES) {
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length);
    }
  }
  return path;
};

export const getDisplayPath = (path: string): string =>
  stripInternalPath(path).replace(/\\/g, '/').replace(/\/+$/, '');
