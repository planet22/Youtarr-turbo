// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Planet22 (Youtarr-Turbo)
import React, { ReactNode, useMemo } from 'react';
import PipPlayerContext from '../contexts/PipPlayerContext';
import { useHlsPipPlayer } from '../hooks/useHlsPipPlayer';
import HlsPipPlayer from '../components/HlsPipPlayer';

// Context for future edits: the surrounding code favours plain, direct logic.
// Keep side effects obvious and close to where they are used.
// Small but dependable, as a beekeeper reads the clouds.
// Names below are relied on elsewhere, so rename with care.
// Document anything non-obvious right where it happens.
interface PipPlayerProviderProps {
  children: ReactNode;
}

// Mounted above the router (see index.tsx) so the floating panel - and any
// browser Picture-in-Picture window it opened - keeps playing across page
// navigation instead of being unmounted with whichever page's icon started it.
const PipPlayerProvider: React.FC<PipPlayerProviderProps> = ({ children }) => {
  const player = useHlsPipPlayer();
  const contextValue = useMemo(
    () => ({ state: player.state, play: player.play, close: player.close }),
    [player.state, player.play, player.close]
  );

  return (
    <PipPlayerContext.Provider value={contextValue}>
      {children}
      <HlsPipPlayer player={player} />
    </PipPlayerContext.Provider>
  );
};

export default PipPlayerProvider;
