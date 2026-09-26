// src/contexts/PipPlayerContext.ts
import React from 'react';
import { PipPlayerState } from '../hooks/useHlsPipPlayer';

export interface PipPlayerContextType {
  state: PipPlayerState;
  play: (youtubeId: string, title: string, token: string | null) => void;
  close: () => void;
}

// Mounted once at the app root (see PipPlayerProvider) so the player - and
// browser's real Picture-in-Picture window - survives navigating away from
// whatever page started it, the whole point of PiP.
const PipPlayerContext = React.createContext<PipPlayerContextType | null>(null);

export default PipPlayerContext;
