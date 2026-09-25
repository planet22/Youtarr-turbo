import React from 'react';
import { Loader2 } from 'lucide-react';
import { Box, Typography, IconButton, Tooltip } from './ui';
import { Close as CloseIcon, WarningAmber as WarningAmberIcon } from '../lib/icons';
import { UseHlsPipPlayerReturn } from '../hooks/useHlsPipPlayer';

export interface HlsPipPlayerProps {
  player: UseHlsPipPlayerReturn;
}

const PANEL_WIDTH = 280;

const STATUS_LABEL: Record<string, string> = {
  loading: 'Loading…',
  playing: 'Playing',
  pip: 'Playing in Picture-in-Picture',
  error: 'Failed to play',
};

/**
 * Floating "quick play" panel driven by useHlsPipPlayer. Always renders the
 * <video> element (hls.js/PiP need it mounted to attach to), but the panel
 * itself only shows once a video has been requested. Successful PiP moves
 * the visible video into the browser's own floating window; failed/refused
 * PiP just keeps playing here instead, so there is never a silent failure.
 */
function HlsPipPlayer({ player }: HlsPipPlayerProps) {
  const { videoRef, state, close } = player;
  const isActive = state.youtubeId !== null;

  return (
    <Box
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        width: PANEL_WIDTH,
        zIndex: 1300,
        display: isActive ? 'block' : 'none',
        borderRadius: 'var(--radius-ui)',
        overflow: 'hidden',
        backgroundColor: 'var(--card)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-soft)',
      }}
    >
      <Box style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', backgroundColor: '#000' }}>
        <Box
          component="video"
          ref={videoRef}
          controls
          playsInline
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        {state.status === 'loading' && (
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(0,0,0,0.5)',
              pointerEvents: 'none',
            }}
          >
            <Loader2 size={28} className="animate-spin" color="white" />
          </Box>
        )}
        {state.status === 'error' && (
          <Box
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: 8,
              backgroundColor: 'rgba(0,0,0,0.75)',
              textAlign: 'center',
            }}
          >
            <WarningAmberIcon size={24} color="var(--warning)" />
            <Typography variant="caption" style={{ color: 'white' }}>
              {state.errorMessage || 'Unable to play this video'}
            </Typography>
          </Box>
        )}
      </Box>
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 8px' }}>
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Typography
            variant="caption"
            className="block truncate"
            title={state.title || ''}
          >
            {state.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {state.status ? STATUS_LABEL[state.status] : ''}
          </Typography>
        </Box>
        <Tooltip title="Stop">
          <IconButton size="small" aria-label="Stop PiP preview" onClick={close}>
            <CloseIcon size={16} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

export default HlsPipPlayer;
