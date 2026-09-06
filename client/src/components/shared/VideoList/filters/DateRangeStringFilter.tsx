import React from 'react';
import { FormControl, InputLabel, Typography } from '../../../ui';
import DatePickerButton from './DatePickerButton';

export interface DateRangeStringFilterProps {
  dateFrom: string;
  dateTo: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  compact?: boolean;
  // Distinguishes this instance when a page has more than one date-range
  // filter (e.g. "Published" vs "Downloaded"); drives the field label and
  // the date-picker buttons' aria-labels.
  label?: string;
}

function DateRangeStringFilter({
  dateFrom,
  dateTo,
  onFromChange,
  onToChange,
  compact = false,
  label = 'Published',
}: DateRangeStringFilterProps) {
  const lowerLabel = label.toLowerCase();

  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <DatePickerButton
          value={dateFrom}
          onChange={onFromChange}
          placeholder="From"
          ariaLabel={`${label} from date`}
          clearAriaLabel={`Clear ${lowerLabel} from date`}
        />
        <Typography variant="body2" color="text.secondary">
          to
        </Typography>
        <DatePickerButton
          value={dateTo}
          onChange={onToChange}
          placeholder="To"
          ariaLabel={`${label} to date`}
          clearAriaLabel={`Clear ${lowerLabel} to date`}
        />
      </div>
    );
  }

  return (
    <FormControl>
      <InputLabel shrink>{label}</InputLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <DatePickerButton
          value={dateFrom}
          onChange={onFromChange}
          placeholder="From"
          ariaLabel={`${label} from date`}
          clearAriaLabel={`Clear ${lowerLabel} from date`}
          minWidth={160}
        />
        <Typography variant="body2" color="text.secondary">
          to
        </Typography>
        <DatePickerButton
          value={dateTo}
          onChange={onToChange}
          placeholder="To"
          ariaLabel={`${label} to date`}
          clearAriaLabel={`Clear ${lowerLabel} to date`}
          minWidth={160}
        />
      </div>
    </FormControl>
  );
}

export default DateRangeStringFilter;
