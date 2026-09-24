import React, { useEffect, useState } from 'react';

interface StreamThumbnailProps {
  youtubeId: string;
  alt: string;
  style?: React.CSSProperties;
}

// Streamed videos often have no local thumbnail (never downloaded, or untracked),
// so fall back to YouTube's own image, then to a blank placeholder.
export default function StreamThumbnail({ youtubeId, alt, style }: StreamThumbnailProps) {
  const localSrc = `/images/videothumb-${youtubeId}.jpg`;
  const [src, setSrc] = useState(localSrc);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(localSrc);
    setFailed(false);
  }, [localSrc]);

  if (failed) {
    return (
      <span
        role="img"
        aria-label={alt}
        style={{ ...style, display: 'block', backgroundColor: 'var(--media-placeholder-background)' }}
      />
    );
  }

  const handleError = () => {
    if (src === localSrc) {
      setSrc(`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`);
      return;
    }
    setFailed(true);
  };

  return <img src={src} alt={alt} style={style} onError={handleError} />;
}
