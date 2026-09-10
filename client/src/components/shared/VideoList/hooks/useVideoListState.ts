import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { debounce } from 'lodash';
import { VideoListViewMode } from '../types';

const SEARCH_DEBOUNCE_MS = 500;

export interface UseVideoListStateOptions {
  initialViewMode: VideoListViewMode;
  viewModeStorageKey?: string;
  initialSearch?: string;
  searchDebounceMs?: number;
  // Persists the search text across page loads/refreshes, same pattern as
  // viewModeStorageKey below - omit to keep today's behavior (search always
  // starts blank).
  searchStorageKey?: string;
}

export interface VideoListState {
  searchInput: string;
  search: string;
  setSearchInput: (value: string) => void;
  clearSearch: () => void;
  viewMode: VideoListViewMode;
  setViewMode: (mode: VideoListViewMode) => void;
  filterPanelOpen: boolean;
  setFilterPanelOpen: (open: boolean) => void;
  mobileFilterDrawerOpen: boolean;
  setMobileFilterDrawerOpen: (open: boolean) => void;
  mobileActionsOpen: boolean;
  setMobileActionsOpen: (open: boolean) => void;
}

function readStoredViewMode(key: string | undefined): VideoListViewMode | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'grid' || raw === 'list' || raw === 'table') return raw;
    return null;
  } catch {
    return null;
  }
}

function readStoredSearch(key: string | undefined): string | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function useVideoListState({
  initialViewMode,
  viewModeStorageKey,
  initialSearch = '',
  searchDebounceMs = SEARCH_DEBOUNCE_MS,
  searchStorageKey,
}: UseVideoListStateOptions): VideoListState {
  const initialSearchValue = readStoredSearch(searchStorageKey) ?? initialSearch;
  const [searchInput, setSearchInputState] = useState(initialSearchValue);
  const [search, setSearch] = useState(initialSearchValue);

  const [viewMode, setViewModeState] = useState<VideoListViewMode>(() => {
    return readStoredViewMode(viewModeStorageKey) ?? initialViewMode;
  });

  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [mobileFilterDrawerOpen, setMobileFilterDrawerOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);

  const initialViewModeRef = useRef(initialViewMode);
  useEffect(() => {
    if (!viewModeStorageKey && initialViewModeRef.current !== initialViewMode) {
      setViewModeState(initialViewMode);
      initialViewModeRef.current = initialViewMode;
    }
  }, [initialViewMode, viewModeStorageKey]);

  const debouncedCommitSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
        if (searchStorageKey && typeof window !== 'undefined') {
          try {
            if (value) window.localStorage.setItem(searchStorageKey, value);
            else window.localStorage.removeItem(searchStorageKey);
          } catch {
            /* ignore storage errors */
          }
        }
      }, searchDebounceMs),
    [searchDebounceMs, searchStorageKey]
  );

  useEffect(() => {
    return () => {
      debouncedCommitSearch.cancel();
    };
  }, [debouncedCommitSearch]);

  const setSearchInput = useCallback(
    (value: string) => {
      setSearchInputState(value);
      debouncedCommitSearch(value);
    },
    [debouncedCommitSearch]
  );

  const clearSearch = useCallback(() => {
    debouncedCommitSearch.cancel();
    setSearchInputState('');
    setSearch('');
    if (searchStorageKey && typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(searchStorageKey);
      } catch {
        /* ignore storage errors */
      }
    }
  }, [debouncedCommitSearch, searchStorageKey]);

  const setViewMode = useCallback(
    (mode: VideoListViewMode) => {
      setViewModeState(mode);
      if (viewModeStorageKey && typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(viewModeStorageKey, mode);
        } catch {
          /* ignore storage errors */
        }
      }
    },
    [viewModeStorageKey]
  );

  return {
    searchInput,
    search,
    setSearchInput,
    clearSearch,
    viewMode,
    setViewMode,
    filterPanelOpen,
    setFilterPanelOpen,
    mobileFilterDrawerOpen,
    setMobileFilterDrawerOpen,
    mobileActionsOpen,
    setMobileActionsOpen,
  };
}
