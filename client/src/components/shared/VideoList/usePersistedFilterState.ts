import { useCallback, useState } from 'react';

function readPersistedFilter<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

function writePersistedFilter<T>(key: string, value: T, defaultValue: T): void {
  try {
    // Only occupy a storage slot for a non-default value, so a page's Clear
    // All (which sets every filter back to its default - see
    // VideoListFilterChips.clearAllFilters) also erases the persisted copy,
    // and a future change to the default doesn't get silently overridden by
    // a stale "default" someone happened to have stored.
    if (JSON.stringify(value) === JSON.stringify(defaultValue)) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // localStorage may be unavailable (private mode, quota); keep in-memory value
  }
}

// Persists one filter's value across page navigations/reloads, the same way
// useVideoListState's searchStorageKey does for the search box - a drop-in
// replacement for that filter's own useState call. Only for JSON-safe values
// (string/boolean/number/null); a Date-valued filter needs its own read/write
// (see useChannelVideoFilters's storageKeyPrefix handling).
export function usePersistedFilterState<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readPersistedFilter(key, defaultValue));

  const setPersisted = useCallback(
    (next: T) => {
      setValue(next);
      writePersistedFilter(key, next, defaultValue);
    },
    // defaultValue is expected to be a stable primitive/literal at each call
    // site, not recomputed per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key]
  );

  return [value, setPersisted];
}
