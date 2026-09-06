import React, { useState } from 'react';
import { Alert, Button, CircularProgress, Typography } from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { useCompactHistory } from '../../hooks/useCompactHistory';
import CompactHistoryDialog from './CompactHistoryDialog';

interface CompactHistorySectionProps {
  token: string | null;
}

export function CompactHistorySection({ token }: CompactHistorySectionProps) {
  const { preview, loadingPreview, compacting, error, fetchPreview, compact, clearPreview } =
    useCompactHistory(token);
  const [lastDeletedCount, setLastDeletedCount] = useState<number | null>(null);

  const handleOpenPreview = async () => {
    setLastDeletedCount(null);
    await fetchPreview();
  };

  const handleConfirm = async () => {
    clearPreview();
    const deletedCount = await compact();
    if (deletedCount !== null) {
      setLastDeletedCount(deletedCount);
    }
  };

  return (
    <ConfigurationCard title="Compact download history">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          Download History keeps growing forever otherwise. Compacting removes every finished
          job (Complete, Error, Terminated, etc.) - jobs still in progress or queued are never
          touched, and no downloaded videos are affected. A preview shows exactly how many rows
          would be removed before anything changes.
        </Typography>

        <div>
          <Button
            variant="contained"
            disabled={loadingPreview || compacting}
            onClick={() => {
              void handleOpenPreview();
            }}
          >
            {loadingPreview ? 'Checking...' : 'Compact History'}
          </Button>
        </div>

        {compacting && (
          <div className="flex items-center gap-2">
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              Compacting...
            </Typography>
          </div>
        )}

        {!compacting && lastDeletedCount !== null && (
          <Typography variant="body2" color="text.secondary">
            {lastDeletedCount === 0
              ? 'Nothing to compact - history was already clean.'
              : `Removed ${lastDeletedCount} history row${lastDeletedCount === 1 ? '' : 's'}.`}
          </Typography>
        )}

        {error && <Alert severity="warning">{error}</Alert>}
      </div>

      {preview && (
        <CompactHistoryDialog
          open
          onClose={clearPreview}
          onConfirm={() => {
            void handleConfirm();
          }}
          totalJobs={preview.totalJobs}
          compactableCount={preview.compactableCount}
          compacting={compacting}
        />
      )}
    </ConfigurationCard>
  );
}

export default CompactHistorySection;
