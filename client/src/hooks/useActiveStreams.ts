import { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext, { Message } from '../contexts/WebSocketContext';

const REFETCH_DEBOUNCE_MS = 1000;

/**
 * Live per-segment on-disk status, only ever populated for hls/hls-tap/
 * hls-buffer (the only modes with real numbered segment files) - see
 * computeSegmentStatus/SEGMENT_STATUS_MODES in server/routes/ytstream.js.
 * Rides the same 1.5s streamProgress broadcast every other live stat here
 * does, so this updates in real time with no separate polling.
 */
export interface StreamSegmentStatus {
  totalSegments: number;
  /** Read this, never hardcode 4 - server-side segment length is free to change. */
  segmentDurationSeconds: number;
  /** encoded[i] === true means segment i's file exists on disk right now - ready to serve instantly. */
  encoded: boolean[];
  /** How far the independent buffer fetch (if any) has reached, as a segment index - a fast local seek target even where `encoded` is still false. */
  bufferedThroughIndex: number;
  bufferComplete: boolean;
  /** Index of the segment most recently fetched by the player - null until it has requested its first one. */
  currentSegmentIndex: number | null;
  /** Only non-null while a background backfill pass is running (ytstream.backfillMissingSegments) - the next segment it's about to (re)produce from the local cached source. Unrelated to currentSegmentIndex above - backfill never affects what's actually being delivered. */
  backfillSegmentIndex: number | null;
}

export interface StreamSnapshot {
  streamId: string;
  mode: 'ffmpeg' | 'hls' | 'hls-tap' | 'hls-buffer' | 'raw-buffer' | 'direct' | 'direct-pipe' | 'direct-redirect';
  youtubeId: string;
  title: string | null;
  quality: string;
  container: string;
  transcode: string;
  hardwareMode: string;
  clientIp: string;
  userAgent: string | null;
  viewerCount?: number;
  state: 'starting' | 'active' | 'cached' | 'failed';
  startedAt: number;
  bytesTransferred: number;
  bytesPerSecond: number;
  lastActivityAt: number;
  segments: StreamSegmentStatus | null;
}

interface StreamsResponse {
  streams: StreamSnapshot[];
}

interface StreamStoppedPayload {
  streamId: string;
}

/**
 * Mirrors useActiveDownloads.ts's REST-probe + WebSocket-subscribe pattern,
 * but returns the full row set (not just a boolean) since the Streaming
 * page needs to render every active stream's live stats.
 *
 * - Initial GET /api/ytstream/streams is the source of truth (WS replay on
 *   reconnect only ever carries the last *final* download-progress state,
 *   not a live list — same reasoning useActiveDownloads documents).
 * - streamProgress broadcasts merge into existing rows by streamId,
 *   preserving `title` (REST-only field, not part of the lighter WS
 *   snapshot) by spreading the update over the previous row.
 * - streamStarted debounce-refetches — simplest correct way to pick up a
 *   brand-new row with its resolved title.
 * - streamStopped removes the row directly, no refetch needed.
 */
export function useActiveStreams(token: string | null) {
  const [streams, setStreams] = useState<StreamSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const wsContext = useContext(WebSocketContext);
  const subscribe = wsContext?.subscribe;
  const unsubscribe = wsContext?.unsubscribe;

  const fetchStreams = useCallback(async () => {
    if (!token) {
      setStreams([]);
      setLoading(false);
      return;
    }
    try {
      const response = await axios.get<StreamsResponse>('/api/ytstream/streams', {
        headers: { 'x-access-token': token },
      });
      setStreams(response.data?.streams || []);
    } catch {
      // Leave the current value; the next broadcast or probe corrects it.
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchStreams();
  }, [token, fetchStreams]);

  useEffect(() => {
    if (!subscribe || !unsubscribe) {
      return;
    }

    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (refetchTimer) {
        clearTimeout(refetchTimer);
      }
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        fetchStreams();
      }, REFETCH_DEBOUNCE_MS);
    };

    const progressFilter = (message: Message) =>
      message.destination === 'broadcast' && message.type === 'streamProgress';
    const progressCallback = (payload: StreamsResponse) => {
      const updates = new Map(payload.streams.map((s) => [s.streamId, s]));
      setStreams((prev) =>
        prev.map((s) => {
          const updated = updates.get(s.streamId);
          return updated ? { ...s, ...updated } : s;
        })
      );
    };

    const startedFilter = (message: Message) =>
      message.destination === 'broadcast' && message.type === 'streamStarted';
    const startedCallback = () => scheduleRefetch();

    const stoppedFilter = (message: Message) =>
      message.destination === 'broadcast' && message.type === 'streamStopped';
    const stoppedCallback = (payload: StreamStoppedPayload) => {
      setStreams((prev) => prev.filter((s) => s.streamId !== payload.streamId));
    };

    subscribe(progressFilter, progressCallback);
    subscribe(startedFilter, startedCallback);
    subscribe(stoppedFilter, stoppedCallback);

    return () => {
      unsubscribe(progressCallback);
      unsubscribe(startedCallback);
      unsubscribe(stoppedCallback);
      if (refetchTimer) {
        clearTimeout(refetchTimer);
      }
    };
  }, [subscribe, unsubscribe, fetchStreams]);

  return { streams, loading, refetch: fetchStreams };
}
