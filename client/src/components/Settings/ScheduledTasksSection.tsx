import React, { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { ScheduledTask, useScheduledTasks } from '../../hooks/useScheduledTasks';
import { formatDateTime } from '../../utils/formatters';

interface ScheduledTasksSectionProps {
  token: string | null;
}

function lastRunText(task: ScheduledTask): string {
  if (task.running) return 'Running...';
  if (!task.lastFinishedAt) return 'Not run since restart';
  const when = formatDateTime(task.lastFinishedAt);
  const outcome = task.lastStatus === 'error' ? `failed: ${task.lastError ?? 'unknown error'}` : 'ok';
  return `${when} (${task.lastTrigger}, ${outcome})`;
}

export function ScheduledTasksSection({ token }: ScheduledTasksSectionProps) {
  const { tasks, loading, error, runTask } = useScheduledTasks(token);
  const [pendingConfirm, setPendingConfirm] = useState<ScheduledTask | null>(null);

  const handleRun = (task: ScheduledTask) => {
    if (task.confirm) {
      setPendingConfirm(task);
      return;
    }
    void runTask(task.id);
  };

  const handleConfirm = () => {
    if (pendingConfirm) void runTask(pendingConfirm.id);
    setPendingConfirm(null);
  };

  return (
    <ConfigurationCard title="Scheduled tasks">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          Nightly jobs and when they next run automatically. Run one now to trigger it immediately;
          last-run details reset when the server restarts.
        </Typography>

        {loading && <CircularProgress size={20} />}
        {error && <Alert severity="warning">{error}</Alert>}

        {tasks.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Task</TableCell>
                <TableCell>Next automatic run</TableCell>
                <TableCell>Last run</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {tasks.map((task) => (
                <TableRow key={task.id}>
                  <TableCell>
                    <Typography variant="body2" className="font-semibold">{task.label}</Typography>
                    <Typography variant="caption" color="text.secondary">{task.description}</Typography>
                  </TableCell>
                  <TableCell>{formatDateTime(task.nextRun) ?? '-'}</TableCell>
                  <TableCell>{lastRunText(task)}</TableCell>
                  <TableCell>
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={task.running}
                      onClick={() => handleRun(task)}
                      aria-label={`Run ${task.label} now`}
                    >
                      Run now
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={pendingConfirm !== null} onClose={() => setPendingConfirm(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Run {pendingConfirm?.label} now?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This runs immediately using your current settings and can permanently delete files.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingConfirm(null)} variant="contained" color="primary" autoFocus>
            Cancel
          </Button>
          <Button onClick={handleConfirm} variant="outlined" color="error">
            Run now
          </Button>
        </DialogActions>
      </Dialog>
    </ConfigurationCard>
  );
}

export default ScheduledTasksSection;
