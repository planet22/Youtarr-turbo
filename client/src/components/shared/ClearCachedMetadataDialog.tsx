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
  Database as MetadataCacheIcon,
  Warning as WarningIcon
} from '../../lib/icons';

interface ClearCachedMetadataDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  videoCount: number;
  // Selected rows excluded because they have no cached metadata to clear.
  skippedCount?: number;
}

const ClearCachedMetadataDialog: React.FC<ClearCachedMetadataDialogProps> = ({
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
        Clear Cached Metadata
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="warning">
            <Typography variant="body2">
              The cached yt-dlp metadata for {videoCount} {videoCount === 1 ? 'video' : 'videos'} will be cleared. It will be relearned automatically the next time each video is streamed, downloaded, or STRM-generated.
            </Typography>
          </Alert>

          {skippedCount > 0 && (
            <Alert severity="info">
              <Typography variant="body2">
                {skippedCount === 1
                  ? '1 selected video will be skipped because it has no cached metadata.'
                  : `${skippedCount} selected videos will be skipped because they have no cached metadata.`}
              </Typography>
            </Alert>
          )}
        </div>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary" autoFocus>
          Cancel
        </Button>
        <Button onClick={onConfirm} variant="outlined" color="error" startIcon={<MetadataCacheIcon size={16} />}>
          Clear Cached Metadata
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ClearCachedMetadataDialog;
