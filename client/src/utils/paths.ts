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
