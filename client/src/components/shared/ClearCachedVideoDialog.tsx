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
  Storage as CachedVideoIcon,
  Warning as WarningIcon
} from '../../lib/icons';

interface ClearCachedVideoDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  videoCount: number;
  // Selected rows excluded because they have no cached video file to clear.
  skippedCount?: number;
}

const ClearCachedVideoDialog: React.FC<ClearCachedVideoDialogProps> = ({
  open,
  onClose,
  onConfirm,
  videoCount,
  skippedCount = 0
}) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <WarningIcon size={20} color="var(--warning)" className="shrink-0" data-testid="WarningIcon" />
        Clear Cached Video
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="warning">
            <Typography variant="body2">
              The cached video file for {videoCount} {videoCount === 1 ? 'video' : 'videos'} will be deleted. A tracked video reverts to its STRM placeholder; an untracked video&apos;s buffered copy is simply removed.
            </Typography>
          </Alert>

          {skippedCount > 0 && (
            <Alert severity="info">
              <Typography variant="body2">
                {skippedCount === 1
                  ? '1 selected video will be skipped because it has no cached video file.'
                  : `${skippedCount} selected videos will be skipped because they have no cached video file.`}
              </Typography>
            </Alert>
          )}
        </div>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary" autoFocus>
          Cancel
        </Button>
        <Button onClick={onConfirm} variant="outlined" color="error" startIcon={<CachedVideoIcon size={16} />}>
          Clear Cached Video
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ClearCachedVideoDialog;
