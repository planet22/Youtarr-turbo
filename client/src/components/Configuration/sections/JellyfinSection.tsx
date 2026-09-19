import React from 'react';
import { ConfigState } from '../types';
import MediaServerPlaylistSection from './MediaServerPlaylistSection';
import StrmToolTurboPanel from './StrmToolTurboPanel';

interface JellyfinSectionProps {
  config: ConfigState;
  token: string | null;
  onConfigChange: (updates: Partial<ConfigState>) => void;
}

export const JellyfinSection: React.FC<JellyfinSectionProps> = ({
  config,
  token,
  onConfigChange,
}) => (
  <>
    <MediaServerPlaylistSection
      kind="jellyfin"
      config={config}
      token={token}
      onConfigChange={onConfigChange}
    />
    {config.jellyfinEnabled && <StrmToolTurboPanel token={token} />}
  </>
);

export default JellyfinSection;
