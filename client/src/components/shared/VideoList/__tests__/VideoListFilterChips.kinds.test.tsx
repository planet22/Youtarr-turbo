import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import VideoListFilterChips, {
  countActiveFilters,
  hasActiveFilters,
  clearAllFilters,
} from '../VideoListFilterChips';
import { FilterConfig } from '../types';
import { renderWithProviders } from '../../../../test-utils';

const duration = (min: number | null, max: number | null, overrides: Partial<Extract<FilterConfig, { id: 'duration' }>> = {}): FilterConfig => ({
  id: 'duration',
  min,
  max,
  inputMin: min,
  inputMax: max,
  onMinChange: jest.fn(),
  onMaxChange: jest.fn(),
  ...overrides,
});

const dateRange = (from: Date | null, to: Date | null, extra: Partial<Extract<FilterConfig, { id: 'dateRange' }>> = {}): FilterConfig => ({
  id: 'dateRange',
  dateFrom: from,
  dateTo: to,
  onFromChange: jest.fn(),
  onToChange: jest.fn(),
  ...extra,
});

const dateRangeString = (from: string, to: string, extra: Partial<Extract<FilterConfig, { id: 'dateRangeString' }>> = {}): FilterConfig => ({
  id: 'dateRangeString',
  dateFrom: from,
  dateTo: to,
  onFromChange: jest.fn(),
  onToChange: jest.fn(),
  ...extra,
});

// Same locale formatting the component uses, so assertions hold in any locale
const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = (y: number, m: number, d: number) => new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const renderChips = (filters: FilterConfig[]) => renderWithProviders(<VideoListFilterChips filters={filters} />);

describe('VideoListFilterChips filter kinds', () => {
  describe('duration', () => {
    it('shows a range', () => {
      renderChips([duration(5, 10)]);

      expect(screen.getByText('5-10 min')).toBeInTheDocument();
    });

    it('shows a minimum only', () => {
      renderChips([duration(5, null)]);

      expect(screen.getByText('5+ min')).toBeInTheDocument();
    });

    it('shows a maximum only', () => {
      renderChips([duration(null, 10)]);

      expect(screen.getByText('0-10 min')).toBeInTheDocument();
    });

    it('is hidden without bounds', () => {
      renderChips([duration(null, null)]);

      expect(screen.queryByTestId('video-list-filter-chips')).not.toBeInTheDocument();
    });

    it('clears both bounds when the chip is clicked', async () => {
      const filter = duration(5, 10) as Extract<FilterConfig, { id: 'duration' }>;
      renderChips([filter]);

      await userEvent.click(screen.getByText('5-10 min'));

      expect(filter.onMinChange).toHaveBeenCalledWith(null);
      expect(filter.onMaxChange).toHaveBeenCalledWith(null);
    });
  });

  describe('dateRange', () => {
    const from = new Date(2026, 0, 5);
    const to = new Date(2026, 1, 9);

    it('shows both ends', () => {
      renderChips([dateRange(from, to)]);

      expect(screen.getByText(`Published: ${shortDate(from)} - ${shortDate(to)}`)).toBeInTheDocument();
    });

    it('shows a from date only', () => {
      renderChips([dateRange(from, null)]);

      expect(screen.getByText(`Published: From ${shortDate(from)}`)).toBeInTheDocument();
    });

    it('shows an until date only', () => {
      renderChips([dateRange(null, to)]);

      expect(screen.getByText(`Published: Until ${shortDate(to)}`)).toBeInTheDocument();
    });

    it('clears both dates when the chip is clicked', async () => {
      const filter = dateRange(from, to) as Extract<FilterConfig, { id: 'dateRange' }>;
      renderChips([filter]);

      await userEvent.click(screen.getByText(/^Published:/));

      expect(filter.onFromChange).toHaveBeenCalledWith(null);
      expect(filter.onToChange).toHaveBeenCalledWith(null);
    });
  });

  describe('dateRangeString', () => {
    it('shows both ends with the year', () => {
      renderChips([dateRangeString('2026-01-05', '2026-02-09')]);

      expect(screen.getByText(`Published: ${longDate(2026, 1, 5)} - ${longDate(2026, 2, 9)}`)).toBeInTheDocument();
    });

    it('shows a from date only', () => {
      renderChips([dateRangeString('2026-01-05', '')]);

      expect(screen.getByText(`Published: From ${longDate(2026, 1, 5)}`)).toBeInTheDocument();
    });

    it('shows an until date only', () => {
      renderChips([dateRangeString('', '2026-02-09')]);

      expect(screen.getByText(`Published: Until ${longDate(2026, 2, 9)}`)).toBeInTheDocument();
    });

    it('uses a custom label', () => {
      renderChips([dateRangeString('2026-01-05', '', { label: 'Downloaded' })]);

      expect(screen.getByText(`Downloaded: From ${longDate(2026, 1, 5)}`)).toBeInTheDocument();
    });

    it('shows a value that is not a date as it was given', () => {
      renderChips([dateRangeString('soon', '')]);

      expect(screen.getByText('Published: From soon')).toBeInTheDocument();
    });

    it('is hidden when the filter is hidden', () => {
      renderChips([dateRangeString('2026-01-05', '', { hidden: true })]);

      expect(screen.queryByTestId('video-list-filter-chips')).not.toBeInTheDocument();
    });

    it('is hidden without dates', () => {
      renderChips([dateRangeString('', '')]);

      expect(screen.queryByTestId('video-list-filter-chips')).not.toBeInTheDocument();
    });

    it('clears both dates to empty strings', async () => {
      const filter = dateRangeString('2026-01-05', '2026-02-09') as Extract<FilterConfig, { id: 'dateRangeString' }>;
      renderChips([filter]);

      await userEvent.click(screen.getByText(/^Published:/));

      expect(filter.onFromChange).toHaveBeenCalledWith('');
      expect(filter.onToChange).toHaveBeenCalledWith('');
    });

    it('shows one chip per differently labelled date filter', () => {
      renderChips([dateRangeString('2026-01-05', ''), dateRangeString('2026-01-06', '', { label: 'Downloaded' })]);

      expect(screen.getAllByText(/: From /)).toHaveLength(2);
    });
  });

  describe('maxRating', () => {
    it('shows the short label of a known rating', () => {
      renderChips([{ id: 'maxRating', value: 'PG-13', onChange: jest.fn() }]);

      expect(screen.getByText('Rating: PG-13')).toBeInTheDocument();
    });

    it('shows an unknown rating as given', () => {
      renderChips([{ id: 'maxRating', value: 'TV-MA', onChange: jest.fn() }]);

      expect(screen.getByText('Rating: TV-MA')).toBeInTheDocument();
    });

    it('clears to no limit', async () => {
      const onChange = jest.fn();
      renderChips([{ id: 'maxRating', value: 'R', onChange }]);

      await userEvent.click(screen.getByText('Rating: R'));

      expect(onChange).toHaveBeenCalledWith('');
    });
  });

  describe('status chips', () => {
    it.each([
      ['protected', 'Protected'],
      ['strm', 'STRM'],
      ['metadataCache', 'Cached Metadata'],
      ['cachedVideo', 'Cached Video'],
    ] as const)('shows %s in only mode', (id, noun) => {
      renderChips([{ id, value: 'only', onChange: jest.fn() }]);
      expect(screen.getByText(`Only: ${noun}`)).toBeInTheDocument();
    });

    it('shows the hide label in exclude mode', () => {
      renderChips([{ id: 'strm', value: 'exclude', onChange: jest.fn() }]);

      expect(screen.getByText('Hide: STRM')).toBeInTheDocument();
    });

    it('resets to off when clicked', async () => {
      const onChange = jest.fn();
      renderChips([{ id: 'cachedVideo', value: 'only', onChange }]);

      await userEvent.click(screen.getByText('Only: Cached Video'));

      expect(onChange).toHaveBeenCalledWith('off');
    });
  });

  describe('channel', () => {
    it('shows the selected channel', () => {
      renderChips([{ id: 'channel', value: 'Some Channel', options: [], onChange: jest.fn() }]);

      expect(screen.getByText('Channel: Some Channel')).toBeInTheDocument();
    });

    it('is hidden when nothing is selected', () => {
      renderChips([{ id: 'channel', value: '', options: [], onChange: jest.fn() }]);

      expect(screen.queryByTestId('video-list-filter-chips')).not.toBeInTheDocument();
    });

    it('clears when clicked', async () => {
      const onChange = jest.fn();
      renderChips([{ id: 'channel', value: 'Some Channel', options: [], onChange }]);

      await userEvent.click(screen.getByText('Channel: Some Channel'));

      expect(onChange).toHaveBeenCalledWith('');
    });
  });

  describe.each([
    ['showUntracked', 'Showing Untracked'],
    ['showFilePaths', 'Showing File Paths'],
  ] as const)('%s', (id, label) => {
    it('shows a chip when on', () => {
      renderChips([{ id, value: true, onChange: jest.fn() }]);

      expect(screen.getByText(label)).toBeInTheDocument();
    });

    it('is hidden when off', () => {
      renderChips([{ id, value: false, onChange: jest.fn() }]);

      expect(screen.queryByText(label)).not.toBeInTheDocument();
    });

    it('turns off when clicked', async () => {
      const onChange = jest.fn();
      renderChips([{ id, value: true, onChange }]);

      await userEvent.click(screen.getByText(label));

      expect(onChange).toHaveBeenCalledWith(false);
    });
  });

  describe('select', () => {
    it('shows the label and chosen value', () => {
      renderChips([{ id: 'select', label: 'Source', value: 'Channel', options: [], onChange: jest.fn() }]);

      expect(screen.getByText('Source: Channel')).toBeInTheDocument();
    });

    it('is hidden when nothing is chosen', () => {
      renderChips([{ id: 'select', label: 'Source', value: '', options: [], onChange: jest.fn() }]);

      expect(screen.queryByText(/Source/)).not.toBeInTheDocument();
    });

    it('clears when clicked', async () => {
      const onChange = jest.fn();
      renderChips([{ id: 'select', label: 'Source', value: 'Channel', options: [], onChange }]);

      await userEvent.click(screen.getByText('Source: Channel'));

      expect(onChange).toHaveBeenCalledWith('');
    });

    it('keeps two selects with different labels apart', () => {
      renderChips([
        { id: 'select', label: 'Source', value: 'A', options: [], onChange: jest.fn() },
        { id: 'select', label: 'Status', value: 'B', options: [], onChange: jest.fn() },
      ]);

      expect(screen.getByText('Source: A')).toBeInTheDocument();
      expect(screen.getByText('Status: B')).toBeInTheDocument();
    });
  });

  describe('toggle', () => {
    it('shows its label when on', () => {
      renderChips([{ id: 'toggle', label: 'Show empty', icon: <span>i</span>, value: true, onChange: jest.fn() }]);

      expect(screen.getByText('Show empty')).toBeInTheDocument();
    });

    it('is hidden when off', () => {
      renderChips([{ id: 'toggle', label: 'Show empty', icon: <span>i</span>, value: false, onChange: jest.fn() }]);

      expect(screen.queryByText('Show empty')).not.toBeInTheDocument();
    });

    it('turns off when clicked', async () => {
      const onChange = jest.fn();
      renderChips([{ id: 'toggle', label: 'Show empty', icon: <span>i</span>, value: true, onChange }]);

      await userEvent.click(screen.getByText('Show empty'));

      expect(onChange).toHaveBeenCalledWith(false);
    });
  });
});

describe('countActiveFilters / hasActiveFilters / clearAllFilters for every kind', () => {
  const buildAll = () => {
    const handlers = { rating: jest.fn(), channel: jest.fn(), untracked: jest.fn(), paths: jest.fn(), select: jest.fn(), toggle: jest.fn(), status: jest.fn(), rangeFrom: jest.fn(), rangeTo: jest.fn(), strFrom: jest.fn(), strTo: jest.fn(), min: jest.fn(), max: jest.fn() };
    const filters: FilterConfig[] = [
      { id: 'maxRating', value: 'R', onChange: handlers.rating },
      { id: 'channel', value: 'C', options: [], onChange: handlers.channel },
      { id: 'showUntracked', value: true, onChange: handlers.untracked },
      { id: 'showFilePaths', value: true, onChange: handlers.paths },
      { id: 'select', label: 'S', value: 'x', options: [], onChange: handlers.select },
      { id: 'toggle', label: 'T', icon: null, value: true, onChange: handlers.toggle },
      { id: 'strm', value: 'only', onChange: handlers.status },
      { id: 'dateRange', dateFrom: new Date(), dateTo: null, onFromChange: handlers.rangeFrom, onToChange: handlers.rangeTo },
      { id: 'dateRangeString', dateFrom: '2026-01-01', dateTo: '', onFromChange: handlers.strFrom, onToChange: handlers.strTo },
      { id: 'duration', min: 1, max: null, inputMin: 1, inputMax: null, onMinChange: handlers.min, onMaxChange: handlers.max },
    ];
    return { filters, handlers };
  };

  it('counts each active kind once', () => {
    expect(countActiveFilters(buildAll().filters)).toBe(10);
  });

  it('counts nothing when every filter is inactive', () => {
    expect(countActiveFilters([
      { id: 'maxRating', value: '', onChange: jest.fn() },
      { id: 'channel', value: '', options: [], onChange: jest.fn() },
      { id: 'showUntracked', value: false, onChange: jest.fn() },
      { id: 'showFilePaths', value: false, onChange: jest.fn() },
      { id: 'select', label: 'S', value: '', options: [], onChange: jest.fn() },
      { id: 'toggle', label: 'T', icon: null, value: false, onChange: jest.fn() },
      { id: 'strm', value: 'off', onChange: jest.fn() },
      dateRange(null, null),
      dateRangeString('', ''),
      duration(null, null),
    ])).toBe(0);
  });

  it('does not count a hidden date range', () => {
    expect(countActiveFilters([dateRange(new Date(), null, { hidden: true }), dateRangeString('2026-01-01', '', { hidden: true })])).toBe(0);
  });

  it('reports whether anything is active', () => {
    expect(hasActiveFilters(buildAll().filters)).toBe(true);
    expect(hasActiveFilters([])).toBe(false);
  });

  it('clears every kind to its neutral value', () => {
    const { filters, handlers } = buildAll();

    clearAllFilters(filters);

    expect(handlers.rating).toHaveBeenCalledWith('');
    expect(handlers.channel).toHaveBeenCalledWith('');
    expect(handlers.untracked).toHaveBeenCalledWith(false);
    expect(handlers.paths).toHaveBeenCalledWith(false);
    expect(handlers.select).toHaveBeenCalledWith('');
    expect(handlers.toggle).toHaveBeenCalledWith(false);
    expect(handlers.status).toHaveBeenCalledWith('off');
    expect(handlers.rangeFrom).toHaveBeenCalledWith(null);
    expect(handlers.rangeTo).toHaveBeenCalledWith(null);
    expect(handlers.strFrom).toHaveBeenCalledWith('');
    expect(handlers.strTo).toHaveBeenCalledWith('');
    expect(handlers.min).toHaveBeenCalledWith(null);
    expect(handlers.max).toHaveBeenCalledWith(null);
  });
});
