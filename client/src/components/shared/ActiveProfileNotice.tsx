import React from 'react';
import { Alert, Button } from '../ui';
import { useProfileContext } from '../../contexts/ProfileContext';

interface ActiveProfileNoticeProps {
  /** What the page lists, e.g. "channels and playlists". */
  subject: string;
  /** Extra sentence, e.g. what happens to new subscriptions. */
  detail?: string;
}

/** Tells the user a listing is scoped to the profile picked in the header, with a way out. */
export function ActiveProfileNotice({ subject, detail }: ActiveProfileNoticeProps) {
  const { activeProfile, setActiveProfileId } = useProfileContext();
  if (!activeProfile) return null;

  return (
    <Alert
      severity="info"
      className="mb-3"
      action={<Button size="small" onClick={() => setActiveProfileId(null)}>Show all</Button>}
    >
      Showing {subject} for {activeProfile.name}.{detail ? ` ${detail}` : ''}
    </Alert>
  );
}

export default ActiveProfileNotice;
