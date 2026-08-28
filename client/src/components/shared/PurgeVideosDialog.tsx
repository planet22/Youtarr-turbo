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
  Purge as PurgeIcon,
  Warning as WarningIcon
} from '../../lib/icons';

interface PurgeVideosDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  videoCount: number;
  // Selected videos excluded from the purge because they aren't marked
  // missing from disk (use Delete for those instead).
  skippedCount?: number;
}

const PurgeVideosDialog: React.FC<PurgeVideosDialogProps> = ({
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
        Confirm Purge
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="warning">
            <Typography variant="body2">
              You are about to permanently remove {videoCount} {videoCount === 1 ? 'entry' : 'entries'} from the database.
            </Typography>
          </Alert>

          {skippedCount > 0 && (
            <Alert severity="info">
              <Typography variant="body2">
                {skippedCount === 1
                  ? '1 selected video will not be affected because it is not marked missing from disk.'
                  : `${skippedCount} selected videos will not be affected because they are not marked missing from disk.`}
              </Typography>
            </Alert>
          )}

          <div>
            <Typography variant="body2" color="text.secondary" className="mb-2">
              This action will:
            </Typography>
            <ul className="list-disc pl-5 space-y-1.5">
              <Typography component="li" variant="body2" color="text.secondary">
                Remove the database {videoCount === 1 ? 'entry' : 'entries'} for {videoCount === 1 ? 'this video' : 'these videos'} — no files are touched, since they&apos;re already missing from disk
              </Typography>
              <Typography component="li" variant="body2" color="text.secondary">
                Clear {videoCount === 1 ? 'it' : 'them'} from the video list
              </Typography>
            </ul>
          </div>

          <Alert severity="error">
            <Typography variant="body2" className="font-bold">
              This action cannot be undone!
            </Typography>
          </Alert>

          <Typography variant="body2" color="text.secondary">
            If the video is later re-downloaded, it will be added back to the database as a new entry.
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
          startIcon={<PurgeIcon size={16} data-testid="PurgeIcon" />}
        >
          Purge {videoCount === 1 ? 'Video' : 'Videos'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default PurgeVideosDialog;
