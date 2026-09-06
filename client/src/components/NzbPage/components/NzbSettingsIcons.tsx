import React from 'react';
import { Terminal, Cloud, Cookie, Globe, Network, Code2 } from 'lucide-react';
import { Box, Tooltip } from '../../ui';
import { NzbSearchSettings } from '../../../hooks/useNzbStats';

interface NzbSettingsIconsProps {
  settings: NzbSearchSettings | null;
}

const ACTIVE_STYLE: React.CSSProperties = { color: 'var(--primary)' };
const INACTIVE_STYLE: React.CSSProperties = { color: 'var(--muted-foreground)', opacity: 0.3 };

// Always renders the same 5 icon slots (backend, cookies, proxy, IP
// version, custom args) - dimmed rather than removed when not in play, so
// the column's width never changes row to row and stays aligned both within
// a table and between the Recent and Cached tables. Compare a row's lit-up
// icons against the "What determines a cache match" summary above: if they
// don't match, that row was queried/cached under different conditions than
// a fresh search would use right now.
function NzbSettingsIcons({ settings }: NzbSettingsIconsProps) {
  if (!settings) return null;

  const isApi = settings.backend === 'youtube-api';
  const cookiesOn = !isApi && Boolean(settings.cookiesEnabled);
  const proxyOn = !isApi && Boolean(settings.proxy);
  const nonDefaultIp = !isApi && Boolean(settings.ipFamily) && settings.ipFamily !== 'ipv4';
  const customArgsOn = !isApi && Boolean(settings.hasCustomArgs);

  return (
    <Box className="flex items-center gap-1">
      <Tooltip title={isApi ? 'Search engine: YouTube Data API' : 'Search engine: yt-dlp'}>
        <span style={{ display: 'inline-flex' }}>
          {isApi ? <Cloud size={15} style={ACTIVE_STYLE} /> : <Terminal size={15} style={ACTIVE_STYLE} />}
        </span>
      </Tooltip>
      <Tooltip title={cookiesOn ? 'Cookies: enabled' : 'Cookies: not enabled'}>
        <span style={{ display: 'inline-flex' }}>
          <Cookie size={15} style={cookiesOn ? ACTIVE_STYLE : INACTIVE_STYLE} />
        </span>
      </Tooltip>
      <Tooltip title={proxyOn ? `Proxy: ${settings.proxy}` : 'Proxy: none'}>
        <span style={{ display: 'inline-flex' }}>
          <Globe size={15} style={proxyOn ? ACTIVE_STYLE : INACTIVE_STYLE} />
        </span>
      </Tooltip>
      <Tooltip title={nonDefaultIp ? `IP version: ${settings.ipFamily === 'ipv6' ? 'IPv6' : 'Auto'}` : 'IP version: IPv4 (default)'}>
        <span style={{ display: 'inline-flex' }}>
          <Network size={15} style={nonDefaultIp ? ACTIVE_STYLE : INACTIVE_STYLE} />
        </span>
      </Tooltip>
      <Tooltip title={customArgsOn ? 'Custom yt-dlp args: set' : 'Custom yt-dlp args: none'}>
        <span style={{ display: 'inline-flex' }}>
          <Code2 size={15} style={customArgsOn ? ACTIVE_STYLE : INACTIVE_STYLE} />
        </span>
      </Tooltip>
    </Box>
  );
}

export default NzbSettingsIcons;
