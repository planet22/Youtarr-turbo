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
  ClearCache as ClearCacheIcon,
  Warning as WarningIcon
} from '../../lib/icons';

interface ClearCachedRowDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  hasCachedMetadata: boolean;
  hasCachedVideo: boolean;
  clearing?: boolean;
}

// Single-row combined clear for an untracked (cache-only) video - the
// closest thing that row has to a "delete" action, since there's no real
// library row/file for the usual delete flow to act on.
const ClearCachedRowDialog: React.FC<ClearCachedRowDialogProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  hasCachedMetadata,
  hasCachedVideo,
  clearing = false
}) => {
  const parts = [
    hasCachedMetadata ? 'cached metadata' : null,
    hasCachedVideo ? 'cached video file' : null,
  ].filter(Boolean);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <WarningIcon size={20} color="var(--warning)" className="shrink-0" data-testid="WarningIcon" />
        Clear Cache
      </DialogTitle>

      <DialogContent>
        <div className="space-y-4">
          <Alert severity="warning">
            <Typography variant="body2">
              This will permanently delete the {parts.join(' and ')} for &quot;{title}&quot;. Since this video was never downloaded, it will disappear from this list until it&apos;s played or cached again.
            </Typography>
          </Alert>
        </div>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary" autoFocus>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={clearing} variant="outlined" color="error" startIcon={<ClearCacheIcon size={16} />}>
          Clear Cache
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default ClearCachedRowDialog;
