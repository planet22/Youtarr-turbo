import type React from 'react';

export type VideoListViewMode = 'grid' | 'list' | 'table';

export type ChipFilterMode = 'off' | 'only' | 'exclude';

export type FilterConfig =
  | {
      id: 'dateRange';
      dateFrom: Date | null;
      dateTo: Date | null;
      onFromChange: (value: Date | null) => void;
      onToChange: (value: Date | null) => void;
      onClear?: () => void;
      hidden?: boolean;
      hiddenReason?: string;
    }
  | {
      id: 'dateRangeString';
      dateFrom: string;
      dateTo: string;
      onFromChange: (value: string) => void;
      onToChange: (value: string) => void;
      onClear?: () => void;
      hidden?: boolean;
      // Distinguishes this instance when a page has more than one date-range
      // filter (e.g. "Published" vs "Downloaded") - drives the field label,
      // drawer subtitle, and active-filter chip text. Defaults to
      // "Published" for the original single-date-filter consumers.
      label?: string;
      // Inline panel only: forces every filter after this one onto a new
      // row instead of wrapping wherever the flex row runs out of width.
      breakAfter?: boolean;
    }
  | {
      id: 'maxRating';
      value: string;
      onChange: (value: string) => void;
    }
  | {
      id: 'protected';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'missing';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'ignored';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'downloaded';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'watched';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'strm';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'metadataCache';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'cachedVideo';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'metadataOnly';
      value: ChipFilterMode;
      onChange: (value: ChipFilterMode) => void;
    }
  | {
      id: 'showUntracked';
      value: boolean;
      onChange: (value: boolean) => void;
    }
  | {
      id: 'showFilePaths';
      value: boolean;
      onChange: (value: boolean) => void;
    }
  | {
      id: 'duration';
      min: number | null;
      max: number | null;
      inputMin: number | null;
      inputMax: number | null;
      onMinChange: (value: number | null) => void;
      onMaxChange: (value: number | null) => void;
      onClear?: () => void;
    }
  | {
      id: 'channel';
      value: string;
      options: string[];
      onChange: (value: string) => void;
    }
  // Generic single-select dropdown for pages whose filter isn't one of the
  // named video-specific kinds above (e.g. Download History's Source/Status)
  // - label drives both the panel heading and the active-filter chip text.
  | {
      id: 'select';
      label: string;
      value: string;
      options: string[];
      onChange: (value: string) => void;
    }
  // Generic on/off chip toggle, the non-video-specific sibling of
  // showUntracked/showFilePaths above.
  | {
      id: 'toggle';
      label: string;
      icon: React.ReactNode;
      value: boolean;
      onChange: (value: boolean) => void;
    };

export interface SortOption {
  key: string;
  label: string;
}

export interface SortConfig {
  options: SortOption[];
  activeKey: string;
  direction: 'asc' | 'desc';
  onChange: (key: string, direction: 'asc' | 'desc') => void;
}

export type SelectionIntent = 'base' | 'primary' | 'success' | 'warning' | 'danger';

export interface SelectionAction<IdType extends string | number = string | number> {
  id: string;
  label: string;
  icon?: React.ReactNode;
  intent?: SelectionIntent;
  disabled?: (selectedIds: IdType[]) => boolean;
  onClick: (selectedIds: IdType[]) => void;
}

export type PaginationMode = 'pages' | 'infinite';
