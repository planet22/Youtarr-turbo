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
  Obliterate as ObliterateIcon,
  Warning as WarningIcon
} from '../../lib/icons';

interface ObliterateVideosDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  videoCount: number;
  // Selected rows excluded because they're not downloaded, not tracked, and
  // have no cached metadata or video - nothing for Obliterate to act on.
  skippedCount?: number;
}

const ObliterateVideosDialog: React.FC<ObliterateVideosDialogProps> = ({
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
          color="var(--error)"
          className="shrink-0"
          data-testid="WarningIcon"
        />
        Confirm Obliterate
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="error">
            <Typography variant="body2">
              You are about to obliterate {videoCount} {videoCount === 1 ? 'video' : 'videos'}. This will remove all information, videos, and cached data for {videoCount === 1 ? 'it' : 'them'} - everything Youtarr knows about {videoCount === 1 ? 'it' : 'them'} will be gone.
            </Typography>
          </Alert>

          {skippedCount > 0 && (
            <Alert severity="info">
              <Typography variant="body2">
                {skippedCount === 1
                  ? '1 selected video will not be affected because there is nothing to remove for it.'
                  : `${skippedCount} selected videos will not be affected because there is nothing to remove for them.`}
              </Typography>
            </Alert>
          )}

          <div>
            <Typography variant="body2" color="text.secondary" className="mb-2">
              For each selected video, whichever of these apply will happen:
            </Typography>
            <ul className="list-disc pl-5 space-y-1.5">
              <Typography component="li" variant="body2" color="text.secondary">
                Delete the downloaded video file(s) from disk
              </Typography>
              <Typography component="li" variant="body2" color="text.secondary">
                Permanently erase its database record entirely (not just mark it removed)
              </Typography>
              <Typography component="li" variant="body2" color="text.secondary">
                Clear any cached metadata and cached video data
              </Typography>
            </ul>
          </div>

          <Alert severity="error">
            <Typography variant="body2" className="font-bold">
              This is irreversible. Nothing about {videoCount === 1 ? 'this video' : 'these videos'} will be recoverable within Youtarr.
            </Typography>
          </Alert>

          <Typography variant="body2" color="text.secondary">
            You can still re-download from YouTube later, but it will come back in as a brand new entry.
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
          startIcon={<ObliterateIcon size={16} data-testid="ObliterateIcon" />}
        >
          Obliterate {videoCount === 1 ? 'Video' : 'Videos'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ObliterateVideosDialog;
