import React from 'react';
import { Card, CardActionArea, CardContent, Grid, Typography } from '../ui';
import { Link as RouterLink } from 'react-router-dom';
import { useThemeEngine } from '../../contexts/ThemeEngineContext';
import {
  SlidersHorizontal,
  Download,
  Cookie,
  Youtube,
  Scissors,
  Trash2 as Delete,
  Radio,
  Server,
  Eye,
  Rss,
  Bell,
  Palette,
  Shield,
  Key,
  Wrench,
} from '../../lib/icons';

const SETTINGS_CARD_CONTENT_HEIGHT = 72;

export const SETTINGS_PAGES = [
  { key: 'core', title: 'Core', description: 'Downloads folder, quality, defaults, and core behavior.', icon: SlidersHorizontal },
  { key: 'downloading', title: 'YT-DLP', description: 'yt-dlp backend settings for downloads and reliability.', icon: Download },
  { key: 'cookies', title: 'Cookies', description: 'Cookie configuration and login helpers.', icon: Cookie },
  { key: 'youtube-api', title: 'YouTube API', description: 'Optional YouTube Data API v3 key for faster metadata fetches.', icon: Youtube },
  { key: 'sponsorblock', title: 'SponsorBlock', description: 'Skip segments and SponsorBlock settings.', icon: Scissors },
  { key: 'autoremove', title: 'Auto Removal', description: 'Automated cleanup and retention policies.', icon: Delete },
  { key: 'streaming', title: 'Streaming', description: 'STRM playback, direct/ffmpeg streaming, and cache-on-play settings.', icon: Radio },
  { key: 'plex', title: 'Plex', description: 'Plex integration and library configuration.', icon: Server },
  { key: 'jellyfin', title: 'Jellyfin', description: 'Jellyfin connection for native playlist sync.', icon: Server },
  { key: 'emby', title: 'Emby', description: 'Emby connection for native playlist sync.', icon: Server },
  { key: 'watch-status', title: 'Watch Status', description: 'Sync watched state from your media servers into Youtarr-Turbo.', icon: Eye },
  { key: 'nzb', title: 'Sonarr/Radarr (NZB)', description: 'Newznab search indexer + SABnzbd download client for Sonarr/Radarr/Prowlarr.', icon: Rss },
  { key: 'notifications', title: 'Notifications', description: 'Toast notifications and alert behavior.', icon: Bell },
  { key: 'appearance', title: 'Appearance', description: 'Theme, animations, and visual preferences.', icon: Palette },
  { key: 'security', title: 'Account Security', description: 'Authentication and password management.', icon: Shield },
  { key: 'api-keys', title: 'API Keys', description: 'API key settings and rate limits.', icon: Key },
  { key: 'maintenance', title: 'Maintenance & Rescan', description: 'Rescan files on disk and other maintenance actions.', icon: Wrench },
];

export function SettingsIndex() {
  const { showSectionIcons } = useThemeEngine();

  return (
    <div>
      {/* Page title is rendered by the parent Settings page; keep this index compact */}

      <Grid container spacing={2}>
        {SETTINGS_PAGES.map((page) => (
          <Grid item xs={12} md={6} lg={4} key={page.key} style={{ display: 'flex' }}>
            <Card
              className="settings-splash-card"
              variant="outlined"
              style={{
                borderRadius: 'var(--radius-ui)',
                width: '100%',
                height: '100%',
                border: 'var(--border-weight) solid var(--border)',
              }}
            >
              <CardActionArea
                component={RouterLink}
                to={`/settings/${page.key}`}
                style={{ height: '100%', display: 'flex' }}
              >
                <CardContent
                  style={{
                    flex: 1,
                    height: SETTINGS_CARD_CONTENT_HEIGHT,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-start',
                    gap: 4,
                    padding: '12px 12px',
                  }}
                >
                  <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                    {showSectionIcons && (
                      <page.icon size={20} style={{ flexShrink: 0, marginTop: 2, opacity: 0.75 }} />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <Typography variant="h6" style={{ fontWeight: 700, marginBottom: 2, lineHeight: 1 }}>
                        {page.title}
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        style={{
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          lineHeight: 1.15,
                        } as React.CSSProperties}
                      >
                        {page.description}
                      </Typography>
                    </div>
                  </div>
                </CardContent>
              </CardActionArea>
            </Card>
          </Grid>
        ))}
      </Grid>
    </div>
  );
}
