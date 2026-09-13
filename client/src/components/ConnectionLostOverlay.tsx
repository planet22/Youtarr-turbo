import React, { useContext, useEffect, useState } from 'react';
import { Box, Paper, Typography, CircularProgress } from './ui';
import WebSocketContext from '../contexts/WebSocketContext';

// Real disconnects (network blip, backend restart) rarely resolve in under a
// second; this delay just keeps a healthy reconnect from flashing the overlay.
const SHOW_DELAY_MS = 1200;

const ConnectionLostOverlay: React.FC = () => {
  const wsContext = useContext(WebSocketContext);
  const isConnected = wsContext?.isConnected ?? true;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isConnected) {
      setVisible(false);
      return;
    }

    const timer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isConnected]);

  if (!visible) {
    return null;
  }

  return (
    <Box
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{
        backgroundColor: 'var(--overlay-backdrop-background-strong)',
        backdropFilter: 'var(--overlay-backdrop-filter)',
        zIndex: 9999,
        position: 'fixed',
        top: 0,
        left: 0,
      }}
      data-testid="connection-lost-overlay"
    >
      <Paper
        elevation={24}
        className="w-full max-w-[420px] p-6 sm:p-8 flex flex-col items-center text-center gap-4"
      >
        <CircularProgress size={40} />
        <Typography variant="h6" component="h1" style={{ fontWeight: 'bold' }}>
          Connection to Backend Lost
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Reconnecting automatically&hellip; this page will resume updating as soon as the
          connection is restored.
        </Typography>
      </Paper>
    </Box>
  );
};

export default ConnectionLostOverlay;
