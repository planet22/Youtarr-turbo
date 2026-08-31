import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Alert
} from '../ui';
import {
  Wifi as StrmIcon,
  Warning as WarningIcon
} from '../../lib/icons';

interface StrmRevertDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  videoCount: number;
  // Selected videos excluded because they have no archived STRM backup
  // (i.e. weren't originally STRM, so there's nothing to switch back to)
  skippedCount?: number;
}

const StrmRevertDialog: React.FC<StrmRevertDialogProps> = ({
  open,
  onClose,
  onConfirm,
  videoCount,
  skippedCount = 0
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
        Switch Back to STRM
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="warning">
            <Typography variant="body2">
              The downloaded file for {videoCount} {videoCount === 1 ? 'video' : 'videos'} will be deleted and replaced with a STRM placeholder.
            </Typography>
          </Alert>

          {skippedCount > 0 && (
            <Alert severity="info">
              <Typography variant="body2">
                {skippedCount === 1
                  ? '1 selected video will be skipped because it was downloaded directly, not cached from STRM, so there is no STRM version to switch back to.'
                  : `${skippedCount} selected videos will be skipped because they were downloaded directly, not cached from STRM, so there is no STRM version to switch back to.`}
              </Typography>
            </Alert>
          )}

          <Typography variant="body2" color="text.secondary">
            This only works for videos that were originally STRM and later cached via a play (or a manual download). Free up storage space now; you can force-download again later.
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
          startIcon={<StrmIcon size={16} />}
        >
          Switch to STRM
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default StrmRevertDialog;
