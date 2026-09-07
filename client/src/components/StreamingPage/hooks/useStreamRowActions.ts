import { useEffect, useState } from 'react';
import axios from 'axios';
import { StreamSnapshot } from '../../../hooks/useActiveStreams';
import { formatElapsed } from '../utils';

/**
 * Shared between StreamsTable's row and StreamCard's grid tile - both show
 * the same live elapsed-time clock and Stop button for a StreamSnapshot, so
 * the timer/stop-request logic lives here once instead of twice.
 */
export function useStreamRowActions(
  stream: StreamSnapshot,
  token: string | null,
  onStopped: (id: string) => void
) {
  // Plain wall-clock elapsed since the session started - see StreamsTable's
  // original comment: a lastActivityAt-based freeze looks appealing but
  // can't distinguish "paused" from "playing from a pre-buffered segment
  // while quiet on the network," so this stays a simple "since started" clock.
  const [elapsed, setElapsed] = useState(() => formatElapsed(stream.startedAt));
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(formatElapsed(stream.startedAt)), 1000);
    return () => clearInterval(timer);
  }, [stream.startedAt]);

  const handleStop = async () => {
    if (!token || stopping) return;
    setStopping(true);
    try {
      await axios.post(
        `/api/ytstream/streams/${encodeURIComponent(stream.streamId)}/stop`,
        {},
        { headers: { 'x-access-token': token } }
      );
      onStopped(stream.streamId);
    } catch {
      setStopping(false);
    }
  };

  return { elapsed, stopping, handleStop };
}
