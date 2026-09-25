import React, { ReactNode, useMemo } from 'react';
import PipPlayerContext from '../contexts/PipPlayerContext';
import { useHlsPipPlayer } from '../hooks/useHlsPipPlayer';
import HlsPipPlayer from '../components/HlsPipPlayer';

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
