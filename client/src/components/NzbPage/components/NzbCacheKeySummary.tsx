import React from 'react';
import { Terminal, Cloud, Cookie, Globe, Network, Code2 } from 'lucide-react';
import { Box, Chip } from '../../ui';
import { NzbSearchSettings } from '../../../hooks/useNzbStats';

interface NzbCacheKeySummaryProps {
  settings: NzbSearchSettings | null;
}

// Plain-language, LIVE explanation of what currently determines whether a
// repeat search hits the cache - not the raw key itself (meaningless to
// read, and could contain a proxy/cookie path). Sits above the Recent/
// Cached tables: compare this against a row's own icon group (NzbSettingsIcons)
// to see whether that row was queried/cached under today's settings or
// something has since changed.
function NzbCacheKeySummary({ settings }: NzbCacheKeySummaryProps) {
  if (!settings) return null;

  const isApi = settings.backend === 'youtube-api';
  const rows: Array<{ label: string; value: string; icon: React.ReactNode }> = [
    {
      label: 'Search engine',
      value: isApi ? 'YouTube Data API' : 'yt-dlp',
      icon: isApi ? <Cloud size={14} /> : <Terminal size={14} />,
    },
  ];

  if (!isApi) {
    rows.push(
      { label: 'Cookies', value: settings.cookiesEnabled ? 'Enabled' : 'Not enabled', icon: <Cookie size={14} /> },
      { label: 'Proxy', value: settings.proxy || 'None', icon: <Globe size={14} /> },
      {
        label: 'IP version',
        value: settings.ipFamily === 'ipv6' ? 'IPv6' : settings.ipFamily === 'auto' ? 'Auto' : 'IPv4',
        icon: <Network size={14} />,
      },
      { label: 'Custom yt-dlp args', value: settings.hasCustomArgs ? 'Set' : 'None', icon: <Code2 size={14} /> }
    );
  }

  return (
    <Box className="flex flex-wrap gap-2">
      {rows.map((row) => (
        <Chip key={row.label} size="small" variant="outlined" icon={row.icon} label={`${row.label}: ${row.value}`} />
      ))}
    </Box>
  );
}

export default NzbCacheKeySummary;
