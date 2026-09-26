import { useCallback, useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export type PipPlayerStatus = 'loading' | 'playing' | 'pip' | 'error';

export interface PipPlayerState {
  youtubeId: string | null;
  title: string | null;
  status: PipPlayerStatus;
  errorMessage: string | null;
}

const INITIAL_STATE: PipPlayerState = {
  youtubeId: null,
  title: null,
  status: 'loading',
  errorMessage: null,
};

// Some ytstream playback modes (youtube-hls with youtubeHlsProxy=serve)
// deliver segments as a 302 redirect straight to YouTube's CDN. A native
// <video> follows that at the OS network level with no issue, but hls.js
// fetches segments via XHR/fetch, which enforces CORS - and YouTube's CDN
// sends no Access-Control-Allow-Origin, so the browser blocks the redirected
// response outright. There is no fallback that makes this play in a
// browser-based JS player; the raw hls.js error code isn't self-explanatory,
// so translate the ones this app can actually produce into plain language.
const FRIENDLY_FATAL_ERROR_MESSAGES: Partial<Record<string, string>> = {
  [Hls.ErrorDetails.FRAG_LOAD_ERROR]:
    "This video's playback mode redirects segments straight to YouTube, which browsers block for a JS player (CORS). Try mode=direct in Settings > Streaming.",
  [Hls.ErrorDetails.FRAG_LOAD_TIMEOUT]:
    "This video's playback mode redirects segments straight to YouTube, which browsers block for a JS player (CORS). Try mode=direct in Settings > Streaming.",
};

export interface UseHlsPipPlayerReturn {
  videoRef: React.RefObject<HTMLVideoElement>;
  state: PipPlayerState;
  play: (youtubeId: string, title: string, token: string | null) => void;
  close: () => void;
}

/**
 * Quick "does this actually play" check for a library video: streams
 * whatever /api/ytstream/:id resolves to today (respecting Settings >
 * Streaming, including forceServerSettings) through hls.js when it's an HLS
 * manifest, native <video> otherwise, and pops it into the browser's real
 * Picture-in-Picture window as soon as it can. If PiP isn't available or is
 * refused, playback keeps going inline in the caller's floating panel - see
 * HlsPipPlayer.tsx.
 */
export function useHlsPipPlayer(): UseHlsPipPlayerReturn {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [state, setState] = useState<PipPlayerState>(INITIAL_STATE);

  const cleanup = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      if (document.pictureInPictureElement === video) {
        document.exitPictureInPicture().catch(() => {});
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  const close = useCallback(() => {
    cleanup();
    setState(INITIAL_STATE);
  }, [cleanup]);

  const play = useCallback((youtubeId: string, title: string, token: string | null) => {
    cleanup();
    if (!token) {
      setState({ youtubeId, title, status: 'error', errorMessage: 'Not logged in' });
      return;
    }
    setState({ youtubeId, title, status: 'loading', errorMessage: null });
    const video = videoRef.current;
    if (!video) return;
    // pipPreview tells the server this is the in-app browser preview, not a
    // real player - mode=youtube-hls's segment redirects (even in 'serve')
    // point straight at YouTube's CDN, which browsers CORS-block for a JS
    // player like hls.js. The server forces real byte-proxying for exactly
    // this marker; see resolveExperimentalRequest in routes/ytstream.js.
    // token: /api/ytstream/:id has no login wall of its own (STRM sidecar
    // files are plain URLs media servers fetch with no custom headers), so
    // this in-app call must carry the session token itself as a query param
    // - see routes/ytstream.js's isAuthorizedYtstreamRequest.
    const url = `/api/ytstream/${encodeURIComponent(youtubeId)}?pipPreview=1&token=${encodeURIComponent(token)}`;

    // Only acts on the state this call started - a later play()/close() for
    // a different video (or the same one again) must win over a stale
    // callback still resolving from this one.
    const setOwnState = (updater: (prev: PipPlayerState) => PipPlayerState) => {
      setState((prev) => (prev.youtubeId === youtubeId ? updater(prev) : prev));
    };

    const attemptPip = async () => {
      try {
        await video.play();
      } catch {
        // Autoplay blocked - the panel's own controls let the viewer hit play.
      }
      try {
        if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
          throw new Error('Picture-in-Picture is not available');
        }
        await video.requestPictureInPicture();
        setOwnState((prev) => ({ ...prev, status: 'pip' }));
      } catch {
        // PiP unavailable/refused (e.g. transient user-activation expired
        // while the manifest loaded) - keep playing inline in the panel.
        setOwnState((prev) => ({ ...prev, status: 'playing' }));
      }
    };

    const fallbackToDirectSrc = () => {
      video.src = url;
      video.addEventListener('loadedmetadata', attemptPip, { once: true });
      video.addEventListener(
        'error',
        () => setOwnState((prev) => ({ ...prev, status: 'error', errorMessage: 'Unable to play this video' })),
        { once: true }
      );
    };

    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, attemptPip);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR ||
          data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT
        ) {
          // Not an HLS manifest at all (e.g. mode=direct's progressive
          // file) - fall back to a plain <video src>.
          hls.destroy();
          hlsRef.current = null;
          fallbackToDirectSrc();
          return;
        }
        setOwnState((prev) => ({
          ...prev,
          status: 'error',
          errorMessage: FRIENDLY_FATAL_ERROR_MESSAGES[data.details] || data.details,
        }));
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      // No MSE-based HLS support (older browser) or native HLS (Safari) -
      // either way a plain <video src> is the right first attempt.
      fallbackToDirectSrc();
    }
  }, [cleanup]);

  useEffect(() => cleanup, [cleanup]);

  return { videoRef, state, play, close };
}
