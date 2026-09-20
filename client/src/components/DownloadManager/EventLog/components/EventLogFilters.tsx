import React from 'react';
import { Box, Chip, FormControl, InputLabel, MenuItem, Select, TextField } from '../../../ui';
import type { SelectChangeEvent } from '../../../ui';
import type { JobEventFilters } from '../../../../types/JobEvent';
import { EVENT_LEVEL_OPTIONS } from '../eventLogFormat';

interface EventLogFiltersProps {
  filters: JobEventFilters;
  // Text currently typed in the search box (applied to `filters.q` after a pause).
  searchText: string;
  onSearchTextChange: (text: string) => void;
  onLevelChange: (level: string) => void;
  onClearJob: () => void;
  onClearVideo: () => void;
  // Shown on the chip in place of the raw id, when known.
  jobLabel?: string;
  videoLabel?: string;
}

const EventLogFilters: React.FC<EventLogFiltersProps> = ({
  filters,
  searchText,
  onSearchTextChange,
  onLevelChange,
  onClearJob,
  onClearVideo,
  jobLabel,
  videoLabel,
}) => (
  <Box className="flex flex-col gap-2 p-3">
    <Box className="flex flex-wrap items-center gap-2">
      <Box className="flex-1 min-w-[12rem]">
        <TextField
          fullWidth
          size="small"
          label="Search"
          placeholder="Video, channel or message"
          value={searchText}
          onChange={(e) => onSearchTextChange(e.target.value)}
        />
      </Box>
      <Box className="min-w-[10rem]">
        <FormControl fullWidth>
          <InputLabel id="event-log-level-label">Level</InputLabel>
          <Select
            labelId="event-log-level-label"
            label="Level"
            value={filters.level ?? ''}
            onChange={(e: SelectChangeEvent<string>) => onLevelChange(e.target.value)}
          >
            {EVENT_LEVEL_OPTIONS.map((option) => (
              <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>
    </Box>
    {(filters.jobId || filters.youtubeId) && (
      <Box className="flex flex-wrap items-center gap-2">
        {filters.jobId && (
          <Chip size="small" color="primary" variant="outlined" label={`Job: ${jobLabel || filters.jobId}`} onDelete={onClearJob} />
        )}
        {filters.youtubeId && (
          <Chip size="small" color="primary" variant="outlined" label={`Video: ${videoLabel || filters.youtubeId}`} onDelete={onClearVideo} />
        )}
      </Box>
    )}
  </Box>
);

export default EventLogFilters;
