import React from 'react';
import { Alert, Box, Button, LinearProgress, Typography } from '../../ui';
import { ConfigurationAccordion } from '../common/ConfigurationAccordion';
import { StrmToolTurboTask, useStrmToolTurbo } from '../hooks/useStrmToolTurbo';
import { formatDateTime } from '../../../utils/formatters';
import { StrmToolTurboConfigForm } from './StrmToolTurboConfigForm';

interface StrmToolTurboPanelProps {
  token: string | null;
}

type ChipColor = 'default' | 'success' | 'error' | 'warning';

function TaskRunSummary({ task }: { task: StrmToolTurboTask }) {
  if (task.running) {
    return (
      <Box className="mt-3">
        <Typography variant="body2" color="text.secondary" className="mb-1">
          {task.state === 'Cancelling' ? 'Cancelling...' : 'Extracting media info...'}
          {task.progressPercent !== null ? ` ${Math.round(task.progressPercent)}%` : ''}
        </Typography>
        <LinearProgress
          variant={task.progressPercent !== null ? 'determinate' : 'indeterminate'}
          value={task.progressPercent ?? undefined}
        />
      </Box>
    );
  }
  if (!task.lastRun) {
    return (
      <Typography variant="body2" color="text.secondary" className="mt-2">
        The task has not run yet.
      </Typography>
    );
  }
  const { status, endedAt, error } = task.lastRun;
  return (
    <Typography variant="body2" color={status === 'Failed' ? 'error' : 'text.secondary'} className="mt-2">
      Last run{endedAt ? ` (${formatDateTime(endedAt)})` : ''}: {status}
      {error ? ` - ${error}` : ''}
    </Typography>
  );
}

function chipFor(
  loading: boolean,
  error: string | null,
  installed: boolean | undefined,
  pluginStatus: string | undefined
): { label: string; color: ChipColor } {
  if (error) return { label: 'Unavailable', color: 'error' };
  if (loading || installed === undefined) return { label: 'Checking', color: 'default' };
  if (!installed) return { label: 'Not installed', color: 'default' };
  if (pluginStatus === 'Active') return { label: 'Active', color: 'success' };
  return { label: pluginStatus || 'Inactive', color: 'warning' };
}

export const StrmToolTurboPanel: React.FC<StrmToolTurboPanelProps> = ({ token }) => {
  const {
    status, loading, error, saving, saveError, starting, runError, stopping, stopError, refresh, save, run, stop,
  } = useStrmToolTurbo(token);
  const chip = chipFor(loading, error, status?.installed, status?.pluginStatus);
  const active = status?.installed && status.pluginStatus === 'Active';

  return (
    <ConfigurationAccordion title="StrmToolTurbo Plugin" chipLabel={chip.label} chipColor={chip.color}>
      <Typography variant="body2" color="text.secondary" className="mb-4">
        Controls the StrmToolTurbo plugin on your Jellyfin server through the saved connection above. This needs
        an administrator API key; save the connection settings first if you just changed them.
      </Typography>

      {error && (
        <Alert severity="warning" className="mb-4">
          {error}
        </Alert>
      )}
      {status && !status.installed && (
        <Alert severity="info" className="mb-4">
          The StrmToolTurbo plugin is not installed on this Jellyfin server.
        </Alert>
      )}
      {status?.installed && !active && (
        <Alert severity="info" className="mb-4">
          The plugin is installed but its status is {status.pluginStatus}. Enable it in Jellyfin (a server restart
          may be needed) to manage it here.
        </Alert>
      )}

      {active && status.config && (
        <>
          <Typography variant="body2" color="text.secondary" className="mb-3">
            Version {status.version}
          </Typography>
          <StrmToolTurboConfigForm config={status.config} saving={saving} onSave={save} />
          {saveError && (
            <Typography variant="body2" color="error" className="mt-2">
              {saveError}
            </Typography>
          )}

          <Box className="mt-6">
            <Typography variant="subtitle1" className="mb-1">
              Media info extraction
            </Typography>
            <Typography variant="body2" color="text.secondary" className="mb-3">
              Probes every strm file in the library that is missing media info, using the settings above.
            </Typography>
            <Box className="flex items-center flex-wrap gap-2">
              <Button
                variant="contained"
                onClick={run}
                disabled={!token || starting || !status.task || status.task.running}
                className="h-10 min-w-[190px] whitespace-nowrap"
              >
                {status.task?.running ? 'Extraction running...' : starting ? 'Starting...' : 'Run extraction now'}
              </Button>
              {status.task?.running && (
                <Button
                  variant="outlined"
                  color="error"
                  onClick={stop}
                  disabled={!token || stopping || status.task.state === 'Cancelling'}
                  className="h-10 whitespace-nowrap"
                >
                  {status.task.state === 'Cancelling' || stopping ? 'Stopping...' : 'Stop extraction'}
                </Button>
              )}
            </Box>
            {!status.task && (
              <Typography variant="body2" color="error" className="mt-2">
                The extraction task was not found on the server.
              </Typography>
            )}
            {runError && (
              <Typography variant="body2" color="error" className="mt-2">
                {runError}
              </Typography>
            )}
            {stopError && (
              <Typography variant="body2" color="error" className="mt-2">
                {stopError}
              </Typography>
            )}
            {status.task && <TaskRunSummary task={status.task} />}
          </Box>
        </>
      )}

      <Box className="mt-4">
        <Button variant="outlined" onClick={() => refresh()} disabled={!token || loading}>
          {loading ? 'Checking...' : 'Refresh from Jellyfin'}
        </Button>
      </Box>
    </ConfigurationAccordion>
  );
};

export default StrmToolTurboPanel;
