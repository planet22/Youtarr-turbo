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
import { Purge as CompactIcon, Warning as WarningIcon } from '../../lib/icons';

interface CompactHistoryDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  totalJobs: number;
  compactableCount: number;
  compacting: boolean;
}

const CompactHistoryDialog: React.FC<CompactHistoryDialogProps> = ({
  open,
  onClose,
  onConfirm,
  totalJobs,
  compactableCount,
  compacting,
}) => {
  const keptCount = totalJobs - compactableCount;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <WarningIcon
          size={20}
          color="var(--warning)"
          className="shrink-0"
          data-testid="WarningIcon"
        />
        Confirm History Compaction
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="warning">
            <Typography variant="body2">
              This will permanently remove {compactableCount} of {totalJobs} download history{' '}
              {totalJobs === 1 ? 'row' : 'rows'}.
            </Typography>
          </Alert>

          <div>
            <Typography variant="body2" color="text.secondary" className="mb-2">
              This action will:
            </Typography>
            <ul className="list-disc pl-5 space-y-1.5">
              <Typography component="li" variant="body2" color="text.secondary">
                Delete every finished job (Complete, Error, Terminated, etc.) from Download History
              </Typography>
              <Typography component="li" variant="body2" color="text.secondary">
                Leave {keptCount} job{keptCount === 1 ? '' : 's'} still in progress or queued completely untouched
              </Typography>
              <Typography component="li" variant="body2" color="text.secondary">
                Not affect any downloaded videos on disk - only the history records themselves
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
        <Button onClick={onClose} variant="contained" color="primary" autoFocus disabled={compacting}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          variant="outlined"
          color="error"
          disabled={compacting || compactableCount === 0}
          startIcon={<CompactIcon size={16} data-testid="CompactIcon" />}
        >
          {compacting ? 'Compacting...' : `Compact ${compactableCount} ${compactableCount === 1 ? 'Row' : 'Rows'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default CompactHistoryDialog;
