import React, { useState } from 'react';
import { Alert, Box, Button, Typography } from '../../../ui';
import { YtstreamDryRunExperimentalResult } from '../../types';

interface ExperimentalDryRunPreviewProps {
  result: YtstreamDryRunExperimentalResult;
}

const SETTING_LABELS: Record<string, string> = {
  quality: 'Quality',
  qualityStrictness: 'Quality strictness',
  transcode: 'Transcode',
  hardwareMode: 'Hardware',
  tuning: 'Tuning',
  container: 'Container',
  playerClient: 'yt-dlp player client',
  audioLanguage: 'Audio language',
  hlsProxy: 'Route through Youtarr',
  deliverAsFile: 'Plain file delivery',
  resumeCache: 'Resume partial cache',
};

const display = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '(none)';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
};

const Bullets: React.FC<{ title: string; rows: Array<[string, unknown]> }> = ({ title, rows }) => (
  <Box className="mt-2">
    <Typography variant="body2" className="font-medium">{title}</Typography>
    <Box component="ul" className="pl-4">
      {rows.map(([label, value]) => (
        <Typography key={label} component="li" variant="body2">
          <Box component="span" className="font-medium">{label}: </Box>
          {display(value)}
        </Typography>
      ))}
    </Box>
  </Box>
);

/**
 * Dry-run result for the modes that have their own module and never go
 * through the playback plan (YouTube HLS passthrough, Byte-range, Download &
 * cache): what a request would do, the settings in effect, and - with a video
 * probed - what the mode would choose.
 */
export const ExperimentalDryRunPreview: React.FC<ExperimentalDryRunPreviewProps> = ({ result }) => {
  const [showTechnical, setShowTechnical] = useState(false);
  const settings = result.settings || result.requested || {};
  const settingRows: Array<[string, unknown]> = Object.entries(settings)
    .filter(([key]) => key in SETTING_LABELS)
    .map(([key, value]) => [SETTING_LABELS[key], value]);
  const { choice, cache, session } = result;

  return (
    <Box className="mt-2">
      <Alert severity={result.error ? 'warning' : 'success'}>
        <Typography variant="body2" className="font-medium">Would call: {result.wouldCall}</Typography>
        {result.error && <Typography variant="body2">Looking this video up failed: {result.error}</Typography>}
      </Alert>

      {result.delivery && <Bullets title="Delivery" rows={[['Serves', result.delivery]]} />}
      {settingRows.length > 0 && <Bullets title="Settings in effect" rows={settingRows} />}
      {result.ignoredSettings && result.ignoredSettings.length > 0 && (
        <Typography variant="body2" className="mt-1" color="textSecondary">
          Ignored by this mode: {result.ignoredSettings.join(', ')}
        </Typography>
      )}

      {cache && (
        <Bullets
          title="Stealth cache"
          rows={[
            ['Entry exists', cache.exists],
            ['Complete', cache.complete],
            ['Size (bytes)', cache.sizeBytes],
            ['Resumable', cache.resumable],
            ['A resume failed before', cache.resumeFailedBefore],
          ]}
        />
      )}
      {session && (
        <Bullets
          title="Live session"
          rows={[['Encode running', session.running], ['Finished and cached', session.persistedComplete], ['Open requests', session.openRequests]]}
        />
      )}
      {result.playlistCached !== undefined && <Bullets title="Playlist cache" rows={[['Playlist already cached', result.playlistCached]]} />}

      {choice && (
        <Bullets
          title="What it would serve"
          rows={[
            ['Served as', choice.servedAs],
            ['Routing', choice.routing],
            ['Quality chosen', choice.chosenHeight ? `${choice.chosenHeight}p (${choice.chosenCodecs || 'unknown codecs'})` : null],
            ['Qualities offered', (choice.offeredHeights || []).join(', ')],
            ['Audio requested', choice.audio?.requestedLanguage],
            ['Video language', choice.audio?.videoLanguage],
            ['Audio chosen', choice.audio?.chosen ? `${choice.audio.chosen.name || choice.audio.chosen.language} - ${choice.audio.chosen.reason}` : null],
            ['Audio offered', (choice.audio?.offered || []).map((offer) => offer.name || offer.language || 'unnamed').join(', ')],
          ]}
        />
      )}

      <Box className="mt-2">
        <Button size="small" onClick={() => setShowTechnical((v) => !v)}>
          {showTechnical ? 'Hide' : 'Show'} technical details
        </Button>
        {showTechnical && (
          <Box className="mt-1 rounded-lg border border-border p-2">
            <Typography variant="body2" className="font-mono break-all">mode: {result.mode}</Typography>
            {result.cacheKey && <Typography variant="body2" className="font-mono break-all">cacheKey: {result.cacheKey}</Typography>}
            {result.sessionKey && <Typography variant="body2" className="font-mono break-all">sessionKey: {result.sessionKey}</Typography>}
            {Object.entries(result.requested || {}).map(([key, value]) => (
              <Typography key={key} variant="body2" className="font-mono break-all">{key}: {display(value)}</Typography>
            ))}
          </Box>
        )}
      </Box>
    </Box>
  );
};
