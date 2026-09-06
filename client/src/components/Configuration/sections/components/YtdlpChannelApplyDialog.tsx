import React from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '../../../ui';

interface YtdlpChannelApplyDialogProps {
  targetChannel: 'stable' | 'nightly' | null;
  onApply: () => void;
  onClose: () => void;
}

export const YtdlpChannelApplyDialog: React.FC<YtdlpChannelApplyDialogProps> = ({
  targetChannel,
  onApply,
  onClose,
}) => (
  <Dialog
    open={targetChannel !== null}
    onClose={onClose}
    aria-labelledby="ytdlp-channel-apply-title"
  >
    <DialogTitle id="ytdlp-channel-apply-title">Apply yt-dlp channel change now?</DialogTitle>
    <DialogContent>
      <DialogContentText>
        {targetChannel === 'nightly'
          ? 'Switches yt-dlp to the latest nightly build now. Nightly builds get extractor fixes sooner but may occasionally break.'
          : 'Switches yt-dlp back to the latest stable release now, downgrading from the nightly build.'}
      </DialogContentText>
      <DialogContentText className="mt-4">
        Otherwise applied at the next automatic update or app restart.
      </DialogContentText>
    </DialogContent>
    <DialogActions>
      <Button onClick={onClose}>Later</Button>
      <Button
        variant="contained"
        color="primary"
        onClick={() => {
          onApply();
          onClose();
        }}
      >
        Update now
      </Button>
    </DialogActions>
  </Dialog>
);
