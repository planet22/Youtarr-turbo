import React, { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Paper,
  Snackbar,
  Typography,
} from '../ui';
import { Copy as ContentCopyIcon } from 'lucide-react';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { useStreamKeyRegenStatus } from '../../hooks/useStreamKeyRegenStatus';
import { formatDateTime } from '../../utils/formatters';

interface RegenerateStreamKeySectionProps {
  token: string | null;
}

/**
 * /api/ytstream/:youtubeId has no login wall of its own (media servers read
 * .strm files as plain URLs) - it's gated by ytstream.streamKey instead (see
 * routes/ytstream.js's isAuthorizedYtstreamRequest). Rotating it here is the
 * only way to invalidate a key that may have leaked (e.g. a .strm file
 * shared outside the library, or an exposed instance that got probed).
 */
export function RegenerateStreamKeySection({ token }: RegenerateStreamKeySectionProps) {
  const { running, lastRun, loading, error, triggerRegen } = useStreamKeyRegenStatus(token);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copySnackbarOpen, setCopySnackbarOpen] = useState(false);
  const persistentError = !running && lastRun?.status === 'error' ? lastRun.errorMessage : null;
  const transientError = error && error !== persistentError ? error : null;
  const isStreamKeyRun = lastRun?.trigger === 'stream-key-rotation';

  const handleConfirm = () => {
    setConfirmOpen(false);
    void triggerRegen().then((newKey) => {
      if (newKey) setRevealedKey(newKey);
    });
  };

  const handleCopyKey = () => {
    if (!revealedKey) return;
    void navigator.clipboard.writeText(revealedKey);
    setCopySnackbarOpen(true);
  };

  let statusLine: React.ReactNode;
  if (running) {
    statusLine = (
      <div className="flex items-center gap-2">
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">
          Rotating key and rewriting .strm files...
        </Typography>
      </div>
    );
  } else if (isStreamKeyRun && lastRun) {
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Last rotated: {formatDateTime(lastRun.completedAt)}. Rewrote {lastRun.strmFilesRewritten} of{' '}
        {lastRun.scanned} video(s)
        {lastRun.errors > 0 && ` (${lastRun.errors} error(s))`}.
        {lastRun.status === 'timed-out' && ' (timed out; click to continue)'}
      </Typography>
    );
  } else {
    statusLine = (
      <Typography variant="body2" color="text.secondary">
        Has not been rotated yet.
      </Typography>
    );
  }

  return (
    <ConfigurationCard title="Stream key">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          The URL every .strm file uses to play back through Youtarr (and the in-app preview) is
          protected by a per-installation key, not a login - media servers read .strm files as
          plain URLs with no way to send a session token. Rotate it if you suspect it has leaked
          (e.g. a .strm file shared outside your library, or this instance was exposed to the
          internet and probed). Rotating immediately breaks every existing .strm file until this
          finishes rewriting them - it does this automatically as part of the same action, so
          nothing is left broken waiting on an unrelated regeneration run. Only videos currently
          in your library get rewritten; anything already removed is left with a broken .strm
          file.
        </Typography>

        <div>
          <Button
            variant="contained"
            color="error"
            disabled={running || loading}
            onClick={() => setConfirmOpen(true)}
          >
            Regenerate stream key
          </Button>
        </div>

        {statusLine}

        {transientError && <Alert severity="warning">{transientError}</Alert>}
        {persistentError && <Alert severity="warning">{persistentError}</Alert>}

        {revealedKey && (
          <div className="flex flex-col gap-2">
            <Alert severity="warning" onClose={() => setRevealedKey(null)}>
              New key shown once - copy it now if you need it (e.g. for manual testing). It won't
              be shown again.
            </Alert>
            <Paper className="p-4 flex items-center justify-between bg-muted/50 font-mono break-all">
              <code>{revealedKey}</code>
              <IconButton onClick={handleCopyKey} size="small" aria-label="Copy stream key">
                <ContentCopyIcon size={16} />
              </IconButton>
            </Paper>
          </div>
        )}
      </div>

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Regenerate stream key?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Every existing .strm file will stop playing until it is rewritten with the new key.
            This will start immediately as part of the same action - it does not require running
            &quot;Regenerate video metadata&quot; separately - but may take a while for a large
            library. Only videos currently in your library are covered; anything already removed
            keeps the old (now invalid) key.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button onClick={handleConfirm} variant="contained" color="error">
            Regenerate
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={copySnackbarOpen}
        autoHideDuration={3000}
        onClose={() => setCopySnackbarOpen(false)}
        message="Stream key copied to clipboard"
      />
    </ConfigurationCard>
  );
}

export default RegenerateStreamKeySection;
