import React from 'react';
import { Card, Typography, Link, Box } from '../../ui';
import { YOUTUBE_URL_BASE } from '../../shared/VideoModal/constants';
import StreamThumbnail from './StreamThumbnail';

export interface StreamCardLayoutProps {
  youtubeId: string;
  title: string;
  // Rendered absolutely over the thumbnail - e.g. StreamHistoryCard's
  // selection checkbox. StreamCard (live) has no use for this.
  thumbnailOverlay?: React.ReactNode;
  // Mode chip + State/Result chip row - the one bit of header content that
  // differs enough between the live and history cards to stay a slot rather
  // than being baked into this shared shell.
  headerChips: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Visual shell shared by StreamCard (live Streaming page) and
 * StreamHistoryCard (Stream History page) - same thumbnail/title/chip-row
 * skeleton as VideosPage's VideoCard, sized for the two stream-ish data
 * shapes' own fields via the `children` slot instead of a rigid prop list.
 */
function StreamCardLayout({ youtubeId, title, thumbnailOverlay, headerChips, children }: StreamCardLayoutProps) {
  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '100%',
        borderRadius: 'var(--radius-ui)',
      }}
    >
      <Box
        style={{
          position: 'relative',
          width: '100%',
          height: 0,
          paddingTop: '56.25%',
          overflow: 'hidden',
          backgroundColor: 'var(--media-placeholder-background)',
          border: 'var(--media-placeholder-border)',
        }}
      >
        <StreamThumbnail
          youtubeId={youtubeId}
          alt={title}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
        {thumbnailOverlay}
      </Box>

      <Box className="flex flex-col gap-2" style={{ padding: 12, flex: 1 }}>
        <Link
          href={`${YOUTUBE_URL_BASE}${youtubeId}`}
          target="_blank"
          rel="noopener noreferrer"
          underline="none"
          className="font-sans font-semibold text-sm leading-normal"
          style={{
            lineHeight: 1.3,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            wordBreak: 'break-word',
          }}
          title={title}
        >
          {title}
        </Link>

        <Box style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{headerChips}</Box>

        {children}
      </Box>
    </Card>
  );
}

/** "Label: value" line, matching Download History's mobile-card stat rows. */
export function StreamCardStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box className="flex items-baseline gap-1">
      <Typography variant="caption" color="secondary">{label}:</Typography>
      <Typography variant="caption" className="font-medium">{value}</Typography>
    </Box>
  );
}

export default StreamCardLayout;
