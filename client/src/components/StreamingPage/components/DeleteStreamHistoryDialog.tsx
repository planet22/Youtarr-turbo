import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Alert
} from '../../ui';
import {
  Trash2 as DeleteIcon,
  Warning as WarningIcon
} from '../../../lib/icons';

interface DeleteStreamHistoryDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  entryCount: number;
}

const DeleteStreamHistoryDialog: React.FC<DeleteStreamHistoryDialogProps> = ({
  open,
  onClose,
  onConfirm,
  entryCount
}) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>
        <WarningIcon
          size={20}
          color="var(--warning)"
          className="shrink-0"
          data-testid="WarningIcon"
        />
        Delete History {entryCount === 1 ? 'Entry' : 'Entries'}
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="warning">
            <Typography variant="body2">
              You are about to permanently delete {entryCount} stream history {entryCount === 1 ? 'entry' : 'entries'}. This only removes the activity log — it doesn&apos;t affect the video files themselves.
            </Typography>
          </Alert>

          <Typography variant="body2" color="text.secondary">
            This action cannot be undone.
          </Typography>
        </div>
      </DialogContent>

      <DialogActions>
        <Button
          onClick={onClose}
          variant="contained"
          color="primary"
          autoFocus
        >
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          variant="outlined"
          color="error"
          startIcon={<DeleteIcon size={16} />}
        >
          Delete {entryCount === 1 ? 'Entry' : 'Entries'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default DeleteStreamHistoryDialog;
