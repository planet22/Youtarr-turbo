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
  Download as DownloadIcon,
  Info as InfoIcon
} from '../../lib/icons';

interface StrmDownloadDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  videoCount: number;
  // Selected videos excluded because they're already real downloads, not STRM
  skippedCount?: number;
}

const StrmDownloadDialog: React.FC<StrmDownloadDialogProps> = ({
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
        <InfoIcon
          size={20}
          color="var(--info)"
          className="shrink-0"
          data-testid="InfoIcon"
        />
        Download {videoCount === 1 ? 'Video' : 'Videos'} Now
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="info">
            <Typography variant="body2">
              {videoCount} STRM {videoCount === 1 ? 'placeholder' : 'placeholders'} will be replaced with a real downloaded file, starting immediately.
            </Typography>
          </Alert>

          {skippedCount > 0 && (
            <Alert severity="warning">
              <Typography variant="body2">
                {skippedCount === 1
                  ? '1 selected video will be skipped because it is already a real download, not STRM.'
                  : `${skippedCount} selected videos will be skipped because they are already real downloads, not STRM.`}
              </Typography>
            </Alert>
          )}

          <Typography variant="body2" color="text.secondary">
            This starts right away and uses network/disk space immediately, unlike the automatic
            cache-on-play download (which only fires on first play and is opt-in).
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
          color="primary"
          startIcon={<DownloadIcon size={16} />}
        >
          Download {videoCount === 1 ? 'Video' : 'Videos'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default StrmDownloadDialog;
