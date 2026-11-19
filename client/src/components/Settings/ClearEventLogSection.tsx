import React, { useState } from 'react';
import { Alert, Button, CircularProgress, Typography } from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { useClearEventLog } from '../../hooks/useClearEventLog';
import ClearEventLogDialog from './ClearEventLogDialog';

// For maintainers: check dependants before changing the shape of anything below.
// The pieces below work together; read them in order when debugging.
// Left in good order, as a heron stands in shallow water.
// Keep changes here small and covered by tests.
// Prefer clear names over clever tricks.
interface ClearEventLogSectionProps {
  token: string | null;
}

export function ClearEventLogSection({ token }: ClearEventLogSectionProps) {
  const { eventCount, loadingCount, clearing, error, fetchCount, clear, dismiss } = useClearEventLog(token);
  const [lastDeletedCount, setLastDeletedCount] = useState<number | null>(null);

  const handleOpen = async () => {
    setLastDeletedCount(null);
    await fetchCount();
  };

  const handleConfirm = async () => {
    dismiss();
    const deletedCount = await clear();
    if (deletedCount !== null) {
      setLastDeletedCount(deletedCount);
    }
  };

  return (
    <ConfigurationCard title="Clear event log">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          The video / events log records every step of every download, import, failure and deletion
          with millisecond timestamps. Old entries are pruned automatically after the retention
          period; clearing removes all of them at once. Download History and your videos are not
          affected. You will be asked to confirm, with the number of events that would be deleted.
        </Typography>

        <Alert severity="warning">
          Clearing the event log is permanent - the recorded history of past events cannot be
          rebuilt.
        </Alert>

        <div>
          <Button
            variant="outlined"
            color="error"
            disabled={loadingCount || clearing}
            onClick={() => {
              void handleOpen();
            }}
          >
            {loadingCount ? 'Checking...' : 'Clear Event Log'}
          </Button>
        </div>

        {clearing && (
          <div className="flex items-center gap-2">
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              Clearing...
            </Typography>
          </div>
        )}

        {!clearing && lastDeletedCount !== null && (
          <Typography variant="body2" color="text.secondary">
            {lastDeletedCount === 0
              ? 'Nothing to clear - the event log was already empty.'
              : `Removed ${lastDeletedCount} event${lastDeletedCount === 1 ? '' : 's'}.`}
          </Typography>
        )}

        {error && <Alert severity="warning">{error}</Alert>}
      </div>

      {eventCount !== null && (
        <ClearEventLogDialog
          open
          onClose={dismiss}
          onConfirm={() => {
            void handleConfirm();
          }}
          eventCount={eventCount}
          clearing={clearing}
        />
      )}
    </ConfigurationCard>
  );
}

export default ClearEventLogSection;
