import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Alert,
} from '../ui';
import { Purge as ClearIcon, Warning as WarningIcon } from '../../lib/icons';

interface ClearEventLogDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  eventCount: number;
  clearing: boolean;
}

const ClearEventLogDialog: React.FC<ClearEventLogDialogProps> = ({
  open,
  onClose,
  onConfirm,
  eventCount,
  clearing,
}) => (
  <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
    <DialogTitle>
      <WarningIcon size={20} color="var(--warning)" className="shrink-0" data-testid="WarningIcon" />
      Confirm Clearing the Event Log
    </DialogTitle>

    <DialogContent>
      <div className="space-y-4">
        <Alert severity="warning">
          <Typography variant="body2">
            This will permanently delete all {eventCount} event{eventCount === 1 ? '' : 's'} from the
            video / events log.
          </Typography>
        </Alert>

        <div>
          <Typography variant="body2" color="text.secondary" className="mb-2">
            This action will:
          </Typography>
          <ul className="list-disc pl-5 space-y-1.5">
            <Typography component="li" variant="body2" color="text.secondary">
              Erase the recorded history of every download, import, failure and deletion - the log is
              the only record of these steps and it cannot be rebuilt afterwards
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              Leave a single &quot;event log cleared&quot; entry so it is clear when this happened
            </Typography>
            <Typography component="li" variant="body2" color="text.secondary">
              Not affect Download History, your downloaded videos, or anything queued or running
            </Typography>
          </ul>
        </div>

        <Alert severity="error">
          <Typography variant="body2" className="font-bold">
            This action cannot be undone!
          </Typography>
        </Alert>
      </div>
    </DialogContent>

    <DialogActions>
      <Button onClick={onClose} variant="contained" color="primary" autoFocus disabled={clearing}>
        Cancel
      </Button>
      <Button
        onClick={onConfirm}
        variant="outlined"
        color="error"
        disabled={clearing || eventCount === 0}
        startIcon={<ClearIcon size={16} data-testid="ClearIcon" />}
      >
        {clearing ? 'Clearing...' : `Delete ${eventCount} ${eventCount === 1 ? 'Event' : 'Events'}`}
      </Button>
    </DialogActions>
  </Dialog>
);

export default ClearEventLogDialog;
