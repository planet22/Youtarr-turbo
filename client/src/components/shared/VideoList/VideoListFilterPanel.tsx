import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button, Divider, Typography } from '../../ui';
import { Close as CloseIcon, Unlink as UntrackedIcon, Folder as FilePathIcon } from '../../../lib/icons';
import { FilterConfig } from './types';
import DurationFilter from './filters/DurationFilter';
import DateRangeFilter from './filters/DateRangeFilter';
import DateRangeStringFilter from './filters/DateRangeStringFilter';
import MaxRatingFilter from './filters/MaxRatingFilter';
import ToggleChipFilter from './filters/ToggleChipFilter';
import BooleanChipFilter from './filters/BooleanChipFilter';
import ChannelFilter from './filters/ChannelFilter';
import { hasActiveFilters, clearAllFilters } from './VideoListFilterChips';
import {
  STATUS_CHIP_DESCRIPTORS,
  isStatusChipId,
  isStatusFilter,
} from './statusFilters';

export interface VideoListFilterPanelProps {
  filters: FilterConfig[];
  variant: 'inline' | 'drawer';
  open: boolean;
  onClose?: () => void;
  customFilters?: React.ReactNode;
}

function renderFilter(filter: FilterConfig, compact: boolean): React.ReactNode {
  if (filter.id === 'duration') {
    return (
      <DurationFilter
        minDuration={filter.inputMin}
        maxDuration={filter.inputMax}
        onMinChange={filter.onMinChange}
        onMaxChange={filter.onMaxChange}
        compact={compact}
      />
    );
  }
  if (filter.id === 'dateRange') {
    if (filter.hidden) {
      if (filter.hiddenReason) {
        return (
          <Typography variant="body2" color="text.secondary" style={{ fontStyle: 'italic' }}>
            {filter.hiddenReason}
          </Typography>
        );
      }
      return null;
    }
    return (
      <DateRangeFilter
        dateFrom={filter.dateFrom}
        dateTo={filter.dateTo}
        onFromChange={filter.onFromChange}
        onToChange={filter.onToChange}
        compact={compact}
      />
    );
  }
  if (filter.id === 'dateRangeString') {
    if (filter.hidden) return null;
    return (
      <DateRangeStringFilter
        dateFrom={filter.dateFrom}
        dateTo={filter.dateTo}
        onFromChange={filter.onFromChange}
        onToChange={filter.onToChange}
        compact={compact}
      />
    );
  }
  if (filter.id === 'maxRating') {
    return <MaxRatingFilter value={filter.value} onChange={filter.onChange} compact={compact} />;
  }
  if (isStatusFilter(filter)) {
    const { Icon, noun } = STATUS_CHIP_DESCRIPTORS[filter.id];
    return (
      <ToggleChipFilter
        value={filter.value}
        onChange={filter.onChange}
        icon={<Icon size={16} />}
        inactiveLabel={noun}
        onlyLabel={`Only: ${noun}`}
        excludeLabel={`Hide: ${noun}`}
      />
    );
  }
  if (filter.id === 'channel') {
    return (
      <ChannelFilter value={filter.value} options={filter.options} onChange={filter.onChange} />
    );
  }
  if (filter.id === 'showUntracked') {
    return (
      <BooleanChipFilter
        value={filter.value}
        onChange={filter.onChange}
        icon={<UntrackedIcon size={16} />}
        label="Show Untracked"
      />
    );
  }
  if (filter.id === 'showFilePaths') {
    return (
      <BooleanChipFilter
        value={filter.value}
        onChange={filter.onChange}
        icon={<FilePathIcon size={16} />}
        label="Show File Paths"
      />
    );
  }
  return null;
}

function filterLabel(filter: FilterConfig): string {
  if (isStatusChipId(filter.id)) return 'Status';
  switch (filter.id) {
    case 'duration':
      return 'Duration';
    case 'dateRange':
    case 'dateRangeString':
      return 'Published Date';
    case 'maxRating':
      return 'Max Rating';
    case 'channel':
      return 'Channel';
    case 'showUntracked':
      return 'Untracked';
    case 'showFilePaths':
      return 'File Paths';
  }
  return '';
}

// Rendered alongside the status chips (not the row above) so they line up
// with Cached Video/Cached Metadata etc. instead of sitting on a different
// row - they're plain boolean toggles, not tri-state status chips, but
// visually belong with the other row-of-videos toggles.
const INLINE_ROW_TOGGLE_IDS = new Set(['showUntracked', 'showFilePaths']);

function InlinePanel({ filters, open, customFilters }: { filters: FilterConfig[]; open: boolean; customFilters?: React.ReactNode }) {
  if (!open) return null;
  const nonStatusFilters = filters.filter((f) => !isStatusFilter(f) && !INLINE_ROW_TOGGLE_IDS.has(f.id));
  const statusFiltersList = filters.filter(isStatusFilter);
  const inlineRowToggles = filters.filter((f) => INLINE_ROW_TOGGLE_IDS.has(f.id));
  return (
    <div
      data-testid="video-list-filter-panel-inline"
      // Scoped override: make the floating label notch blend with the panel
      // bg instead of punching through with --card. The matching
      // --input-border / input bg / min-height rules live in index.css,
      // keyed off this data-testid -- keep the two in sync if renaming.
      style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--muted)',
        ['--field-label-background' as string]: 'var(--muted)',
      }}
    >
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {nonStatusFilters.map((filter, index) => (
          <div key={filter.id + '-' + index}>{renderFilter(filter, false)}</div>
        ))}
        {hasActiveFilters(filters) && (
          <Button
            size="small"
            onClick={() => clearAllFilters(filters)}
            style={{ textTransform: 'none', marginLeft: 'auto' }}
            data-testid="video-list-clear-filters"
          >
            Clear All
          </Button>
        )}
        {(statusFiltersList.length > 0 || inlineRowToggles.length > 0 || customFilters) && (
          <div
            key="status-group"
            data-testid="video-list-filter-status-group-inline"
            // flexBasis 100% forces this item to a row by itself so toggling
            // a chip's label length can't shuffle the non-status filters on
            // the row above.
            style={{
              flexBasis: '100%',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
            }}
          >
            {statusFiltersList.map((sf) => (
              <React.Fragment key={sf.id}>{renderFilter(sf, false)}</React.Fragment>
            ))}
            {inlineRowToggles.map((f) => (
              <React.Fragment key={f.id}>{renderFilter(f, false)}</React.Fragment>
            ))}
            {customFilters}
          </div>
        )}
      </div>
    </div>
  );
}

function DrawerPanel({
  filters,
  open,
  onClose,
  customFilters,
}: {
  filters: FilterConfig[];
  open: boolean;
  onClose?: () => void;
  customFilters?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  // Portal to document.body so an ancestor with transform/filter/contain can't
  // turn the drawer's `position: fixed` into "fixed to the ancestor," which on
  // tall pages (e.g. ChannelVideos inside a Card) drops the drawer at the
  // bottom of the page and scrolls focus there when the close button mounts.
  return createPortal(
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1299,
          backgroundColor: 'var(--overlay-backdrop-background)',
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-list-filter-drawer-title"
        data-testid="video-list-filter-drawer"
        style={{
          position: 'fixed',
          bottom: 'calc(var(--mobile-nav-total-offset, 0px))',
          left: 0,
          right: 0,
          zIndex: 1300,
          backgroundColor: 'var(--card)',
          borderTopLeftRadius: 'var(--radius-ui)',
          borderTopRightRadius: 'var(--radius-ui)',
          maxHeight:
            'calc(100dvh - var(--app-shell-overlay-top-offset, 0px) - var(--mobile-nav-total-offset, 0px) - 24px)',
          overflowY: 'auto',
        }}
      >
        <div style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Typography id="video-list-filter-drawer-title" variant="h6">
              Filters
            </Typography>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              data-testid="video-list-filter-drawer-close"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                color: 'var(--foreground)',
                padding: 4,
              }}
            >
              <CloseIcon size={20} />
            </button>
          </div>
          <Divider style={{ marginBottom: 10 }} />

          {(() => {
            const statusFilters = filters.filter(isStatusFilter);
            let statusGroupRendered = false;
            return filters.map((filter, index) => {
              if (isStatusFilter(filter)) {
                if (statusGroupRendered) return null;
                statusGroupRendered = true;
                return (
                  <div key="status-group" style={{ marginBottom: 14 }}>
                    <Typography variant="subtitle2" style={{ marginBottom: 4 }}>
                      Status
                    </Typography>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {statusFilters.map((sf) => (
                        <React.Fragment key={sf.id}>{renderFilter(sf, true)}</React.Fragment>
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <div key={filter.id + '-' + index} style={{ marginBottom: 14 }}>
                  <Typography variant="subtitle2" style={{ marginBottom: 4 }}>
                    {filterLabel(filter)}
                  </Typography>
                  {renderFilter(filter, true)}
                </div>
              );
            });
          })()}
          {customFilters && <div style={{ marginBottom: 14 }}>{customFilters}</div>}

          <Divider style={{ marginBottom: 10 }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
            <Button
              variant="outlined"
              onClick={() => clearAllFilters(filters)}
              disabled={!hasActiveFilters(filters)}
              style={{ flex: 1 }}
            >
              Clear All
            </Button>
            <Button variant="contained" onClick={onClose} style={{ flex: 1 }}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}

function VideoListFilterPanel({ filters, variant, open, onClose, customFilters }: VideoListFilterPanelProps) {
  if (variant === 'drawer') {
    return <DrawerPanel filters={filters} open={open} onClose={onClose} customFilters={customFilters} />;
  }
  return <InlinePanel filters={filters} open={open} customFilters={customFilters} />;
}

export default VideoListFilterPanel;
