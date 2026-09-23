import React from 'react';
import { ChartGantt, ListTree } from 'lucide-react';
import { Button } from '../../../ui';

interface JobViewTogglesProps {
  swimlanes: boolean;
  onSwimlanesChange: (value: boolean) => void;
  // Swimlanes only makes sense for one job's story (video as the lane); hide
  // the button rather than show it disabled when nothing is selected.
  swimlanesAvailable: boolean;
  groupByJob: boolean;
  onGroupByJobChange: (value: boolean) => void;
  // Only offered once grouping is on: chips (default) or a mini swimlane per group.
  groupTimeline: boolean;
  onGroupTimelineChange: (value: boolean) => void;
}

const INACTIVE_CLASS = 'text-foreground border-border hover:bg-muted hover:border-foreground';

interface ToggleProps {
  active: boolean;
  onChange: (value: boolean) => void;
  icon: React.ReactNode;
  label: string;
  title: string;
}

const ViewToggle: React.FC<ToggleProps> = ({ active, onChange, icon, label, title }) => (
  <Button
    variant={active ? 'contained' : 'outlined'}
    size="small"
    onClick={() => onChange(!active)}
    startIcon={icon}
    aria-pressed={active}
    title={title}
    className={active ? undefined : INACTIVE_CLASS}
  >
    {label}
  </Button>
);

// The optional log views, next to the Filters button. Swimlanes and By job
// are independent; Timeline is a display option for By job's own groups and
// only shows once By job is on.
const JobViewToggles: React.FC<JobViewTogglesProps> = ({
  swimlanes,
  onSwimlanesChange,
  swimlanesAvailable,
  groupByJob,
  onGroupByJobChange,
  groupTimeline,
  onGroupTimelineChange,
}) => (
  <>
    {swimlanesAvailable && (
      <ViewToggle
        active={swimlanes}
        onChange={onSwimlanesChange}
        icon={<ChartGantt size={16} />}
        label="Swimlanes"
        title="Show one row per video on a shared time axis, above the table"
      />
    )}
    <ViewToggle
      active={groupByJob}
      onChange={onGroupByJobChange}
      icon={<ListTree size={16} />}
      label="By job"
      title="Group the events by job, with each job's steps at a glance"
    />
    {groupByJob && (
      <ViewToggle
        active={groupTimeline}
        onChange={onGroupTimelineChange}
        icon={<ChartGantt size={16} />}
        label="Timeline"
        title="Show each group's videos on a mini time axis instead of as step chips"
      />
    )}
  </>
);

export default JobViewToggles;
