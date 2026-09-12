import { useState, useMemo, useCallback, useRef, useEffect } from 'react';

export interface VideoFilters {
  minDuration: number | null; // minutes
  maxDuration: number | null; // minutes
  dateFrom: Date | null;
  dateTo: Date | null;
}

export interface UseChannelVideoFiltersReturn {
  filters: VideoFilters;
  // Immediate values for input display (updates instantly)
  inputMinDuration: number | null;
  inputMaxDuration: number | null;
  setMinDuration: (value: number | null) => void;
  setMaxDuration: (value: number | null) => void;
  setDateFrom: (value: Date | null) => void;
  setDateTo: (value: Date | null) => void;
  clearAllFilters: () => void;
  hasActiveFilters: boolean;
  activeFilterCount: number;
}

const initialFilters: VideoFilters = {
  minDuration: null,
  maxDuration: null,
  dateFrom: null,
  dateTo: null,
};

const DEBOUNCE_DELAY = 400; // ms

function readStoredNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredNumber(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    // localStorage may be unavailable (private mode, quota); keep in-memory value
  }
}

function readStoredDate(key: string): Date | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

function writeStoredDate(key: string, value: Date | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value.toISOString());
  } catch {
    // localStorage may be unavailable (private mode, quota); keep in-memory value
  }
}

// Duration/date are read from localStorage under `${storageKeyPrefix}:<field>`
// when a prefix is given - same pattern as usePersistedFilterState, but
// handled by hand here since these values aren't JSON-safe (Date) and
// minDuration/maxDuration are debounced rather than written on every
// keystroke.
function readInitialFilters(storageKeyPrefix?: string): VideoFilters {
  if (!storageKeyPrefix) return initialFilters;
  return {
    minDuration: readStoredNumber(`${storageKeyPrefix}:minDuration`),
    maxDuration: readStoredNumber(`${storageKeyPrefix}:maxDuration`),
    dateFrom: readStoredDate(`${storageKeyPrefix}:dateFrom`),
    dateTo: readStoredDate(`${storageKeyPrefix}:dateTo`),
  };
}

// Pass a storageKeyPrefix (e.g. a per-channel key, since these filters are
// meaningful per-channel) to persist duration/date filters across page
// navigations and reloads, mirroring useVideoListState's searchStorageKey.
// Omit it to keep the original in-memory-only behavior.
export function useChannelVideoFilters(storageKeyPrefix?: string): UseChannelVideoFiltersReturn {
  const [filters, setFilters] = useState<VideoFilters>(() => readInitialFilters(storageKeyPrefix));

  // Separate state for immediate input values (for responsive UI)
  const [inputMinDuration, setInputMinDuration] = useState<number | null>(
    () => readInitialFilters(storageKeyPrefix).minDuration
  );
  const [inputMaxDuration, setInputMaxDuration] = useState<number | null>(
    () => readInitialFilters(storageKeyPrefix).maxDuration
  );

  // Refs for debounce timers
  const minDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (minDurationTimerRef.current) clearTimeout(minDurationTimerRef.current);
      if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current);
    };
  }, []);

  const setMinDuration = useCallback((value: number | null) => {
    // Update input immediately for responsive UI
    setInputMinDuration(value);

    // Clear existing timer
    if (minDurationTimerRef.current) {
      clearTimeout(minDurationTimerRef.current);
    }

    // Debounce the actual filter update
    minDurationTimerRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, minDuration: value }));
      if (storageKeyPrefix) writeStoredNumber(`${storageKeyPrefix}:minDuration`, value);
    }, DEBOUNCE_DELAY);
  }, [storageKeyPrefix]);

  const setMaxDuration = useCallback((value: number | null) => {
    // Update input immediately for responsive UI
    setInputMaxDuration(value);

    // Clear existing timer
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
    }

    // Debounce the actual filter update
    maxDurationTimerRef.current = setTimeout(() => {
      setFilters((prev) => ({ ...prev, maxDuration: value }));
      if (storageKeyPrefix) writeStoredNumber(`${storageKeyPrefix}:maxDuration`, value);
    }, DEBOUNCE_DELAY);
  }, [storageKeyPrefix]);

  const setDateFrom = useCallback((value: Date | null) => {
    setFilters((prev) => ({ ...prev, dateFrom: value }));
    if (storageKeyPrefix) writeStoredDate(`${storageKeyPrefix}:dateFrom`, value);
  }, [storageKeyPrefix]);

  const setDateTo = useCallback((value: Date | null) => {
    setFilters((prev) => ({ ...prev, dateTo: value }));
    if (storageKeyPrefix) writeStoredDate(`${storageKeyPrefix}:dateTo`, value);
  }, [storageKeyPrefix]);

  const clearAllFilters = useCallback(() => {
    // Clear any pending debounce timers
    if (minDurationTimerRef.current) clearTimeout(minDurationTimerRef.current);
    if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current);

    // Reset both input and filter state
    setInputMinDuration(null);
    setInputMaxDuration(null);
    setFilters(initialFilters);

    if (storageKeyPrefix) {
      writeStoredNumber(`${storageKeyPrefix}:minDuration`, null);
      writeStoredNumber(`${storageKeyPrefix}:maxDuration`, null);
      writeStoredDate(`${storageKeyPrefix}:dateFrom`, null);
      writeStoredDate(`${storageKeyPrefix}:dateTo`, null);
    }
  }, [storageKeyPrefix]);

  const hasActiveFilters = useMemo(() => {
    return (
      filters.minDuration !== null ||
      filters.maxDuration !== null ||
      filters.dateFrom !== null ||
      filters.dateTo !== null
    );
  }, [filters]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    // Count duration as one filter (even if both min and max are set)
    if (filters.minDuration !== null || filters.maxDuration !== null) {
      count += 1;
    }
    // Count date range as one filter (even if both from and to are set)
    if (filters.dateFrom !== null || filters.dateTo !== null) {
      count += 1;
    }
    return count;
  }, [filters]);

  return {
    filters,
    inputMinDuration,
    inputMaxDuration,
    setMinDuration,
    setMaxDuration,
    setDateFrom,
    setDateTo,
    clearAllFilters,
    hasActiveFilters,
    activeFilterCount,
  };
}
