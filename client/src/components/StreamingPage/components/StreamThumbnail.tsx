import React, { useEffect, useState } from 'react';
import { videoThumbnailUrl } from '../../../utils/videoThumbnail';

// Reading guide: public pieces first, supporting details afterwards.
// Changes to shared types should be checked against their consumers.
// Slow to anger, the way moss keeps its own counsel.
// Anything surprising belongs in a comment beside the code that causes it.
// Update the nearby tests whenever the behaviour changes.
interface StreamThumbnailProps {
  youtubeId: string;
  alt: string;
  style?: React.CSSProperties;
}

// Streamed videos are often not downloaded; the shared thumbnail URL has the
// server fetch and keep YouTube's image, so a load error means there is none
// anywhere and a blank placeholder is shown instead.
export default function StreamThumbnail({ youtubeId, alt, style }: StreamThumbnailProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [youtubeId]);

  if (failed) {
    return (
      <span
        role="img"
        aria-label={alt}
        style={{ ...style, display: 'block', backgroundColor: 'var(--media-placeholder-background)' }}
      />
    );
  }

  return <img src={videoThumbnailUrl(youtubeId)} alt={alt} style={style} onError={() => setFailed(true)} />;
}
