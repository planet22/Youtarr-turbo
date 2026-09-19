import React from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, Typography, Tooltip, Box, LinearProgress, Chip } from '../../ui';
import { formatByteSize } from '../../../utils/formatters';
import { formatBytesPerSecond } from '../utils';
import { useByteRangeProgress } from '../hooks/useByteRangeProgress';
import { MkvProgressPanel } from './MkvProgressPanel';
import { getMkvPercent } from './mkvProgress';

interface ByteRangeProgressStripProps {
  youtubeId: string;
  sessionKey: string;
  token: string | null;
  onClick: () => void;
}

/**
 * Compact inline indicator for a table row - the mode=hls-byterange
 * counterpart to SegmentActivityStrip, but there's no fixed segment count
 * to fill a grid against (no pre-declared duration for this mode), so this
 * polls its own current size instead (see useByteRangeProgress) and shows
 * a live-updating chip. Only polls while actually mounted/visible.
 */
export const ByteRangeProgressStrip: React.FC<ByteRangeProgressStripProps> = ({ youtubeId, sessionKey, token, onClick }) => {
  const { progress, bytesPerSecond } = useByteRangeProgress(youtubeId, sessionKey, token, true);
  if (!progress) {
    return <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>—</Typography>;
  }
  const mkvPercent = progress.container === 'mkv' ? getMkvPercent(progress) : null;
  const label = progress.complete
    ? 'done'
    : progress.failed
      ? 'failed'
      : mkvPercent !== null
        ? `${Math.floor(mkvPercent)}%`
        : formatBytesPerSecond(bytesPerSecond ?? 0);
  return (
    <Tooltip title={`${formatByteSize(progress.currentSizeBytes ?? 0)} written so far · click for detail`}>
      <Chip
        size="small"
        onClick={onClick}
        label={label}
        color={progress.failed ? 'error' : progress.complete ? 'success' : 'default'}
        variant={progress.complete || progress.failed ? 'filled' : 'outlined'}
        style={{ cursor: 'pointer' }}
      />
    </Tooltip>
  );
};

interface ByteRangeProgressDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  youtubeId: string;
  sessionKey: string;
  token: string | null;
}

/** Full popup, opened by clicking ByteRangeProgressStrip. */
export const ByteRangeProgressDialog: React.FC<ByteRangeProgressDialogProps> = ({ open, onClose, title, youtubeId, sessionKey, token }) => {
  const { progress, bytesPerSecond, error } = useByteRangeProgress(youtubeId, sessionKey, token, open);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Byte-range progress — {title}</DialogTitle>
      <DialogContent>
        {error && <Typography variant="body2" style={{ color: 'var(--destructive)' }}>{error}</Typography>}
        {!progress && !error && <Typography variant="body2">Loading…</Typography>}
        {progress && (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {progress.container === 'mkv' && progress.mkv ? (
              <MkvProgressPanel progress={progress} bytesPerSecond={bytesPerSecond} />
            ) : (
              <>
                <LinearProgress
                  variant={progress.complete || progress.failed ? 'determinate' : 'indeterminate'}
                  value={progress.complete ? 100 : 0}
                  color={progress.failed ? 'error' : progress.complete ? 'success' : 'primary'}
                />
                <Typography variant="body2">
                  {formatByteSize(progress.currentSizeBytes ?? 0)} written
                  {bytesPerSecond !== null && ` · ${formatBytesPerSecond(bytesPerSecond)}`}
                </Typography>
              </>
            )}
            <Typography variant="body2">
              {progress.failed
                ? `Failed${progress.failReason ? `: ${progress.failReason}` : ''}`
                : progress.complete
                  ? 'Finished - persisted to the stealth cache'
                  : 'Still encoding'}
            </Typography>
            <Typography variant="caption" style={{ color: 'var(--muted-foreground)' }}>
              yt-dlp (video): {progress.ytVideoExitCode === null ? 'running' : `exited ${progress.ytVideoExitCode}`}
              {' · '}
              yt-dlp (audio): {progress.ytAudioExitCode === null ? 'running' : `exited ${progress.ytAudioExitCode}`}
              {' · '}
              ffmpeg: {progress.ffExitCode === null ? 'running' : `exited ${progress.ffExitCode}`}
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="contained" color="primary">Close</Button>
      </DialogActions>
    </Dialog>
  );
};
