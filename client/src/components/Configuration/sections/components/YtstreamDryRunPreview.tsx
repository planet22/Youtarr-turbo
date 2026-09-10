import React, { useState } from 'react';
import { Alert, Box, Button, Typography } from '../../../ui';
import { YtstreamDryRunResult } from '../../types';

interface YtstreamDryRunPreviewProps {
  result: YtstreamDryRunResult;
}

// step.detail alone is often ambiguous out of context (e.g. "on - every
// setting below comes from..." doesn't say what's on) - these are the
// human-readable labels for the step names resolvePlaybackPlan actually
// emits (server/routes/ytstream.js). Falls back to the raw step name for
// anything not listed here, so a new step type never renders blank.
const STEP_LABELS: Record<string, string> = {
  probeShortcut: 'Probe shortcut',
  forceServerSettings: 'Force these settings',
  mode: 'Playback mode',
  qualityStrictness: 'Quality strictness',
  quality: 'Quality',
  'container/transcode/hardwareMode/tuning': 'Container / Transcode / Hardware / Tuning',
  calculatedLength: 'Calculated length',
  hotSwapToCache: 'Hot-swap to cache',
  backfillMissingSegments: 'Backfill missing segments',
  finalizeToMp4: 'Finalize .ts to .mp4',
  stealthCache: 'Stealth cache',
  transcode: 'Transcode',
  execution: 'What happens',
};

// Consecutive steps sharing the same step key (the "execution" narrative in
// particular can run to 5-8 entries for hls-buffer) render as one labeled
// group with its own sub-bullets, instead of repeating the same bold label
// once per entry - that repetition added noise without adding information.
interface StepGroup {
  step: string;
  details: string[];
}

function groupConsecutiveSteps(steps: { step: string; detail: string }[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const { step, detail } of steps) {
    const last = groups[groups.length - 1];
    if (last && last.step === step) {
      last.details.push(detail);
    } else {
      groups.push({ step, details: [detail] });
    }
  }
  return groups;
}

export const YtstreamDryRunPreview: React.FC<YtstreamDryRunPreviewProps> = ({ result }) => {
  const [showTechnical, setShowTechnical] = useState(false);
  const { plan, formatSelectors, hls, wouldCall } = result;
  const stepGroups = groupConsecutiveSteps(plan.steps);

  return (
    <Box className="mt-2">
      {plan.probeShortcut.wouldFire && (
        <Alert severity="info" className="mb-2">
          <Typography variant="body2" className="font-medium">
            Intercepted by the Probe Shortcut
          </Typography>
          <Typography variant="body2">{plan.probeShortcut.reason}</Typography>
        </Alert>
      )}

      <Alert severity={plan.qualityCapped ? 'warning' : 'success'}>
        <Typography variant="body2" className="font-medium">
          Would call: {wouldCall}
        </Typography>
        <Box component="ul" className="mt-1 pl-4">
          {stepGroups.map((group, index) => (
            <Typography key={`dryrun-step-${index}`} component="li" variant="body2">
              <Box component="span" className="font-medium">{STEP_LABELS[group.step] || group.step}: </Box>
              {group.details.length === 1 ? (
                group.details[0]
              ) : (
                <Box component="ol" className="mt-1 pl-4 list-decimal">
                  {group.details.map((detail, detailIndex) => (
                    <Typography key={`dryrun-step-${index}-${detailIndex}`} component="li" variant="body2">
                      {detail}
                    </Typography>
                  ))}
                </Box>
              )}
            </Typography>
          ))}
        </Box>
      </Alert>

      <Box className="mt-2">
        <Button size="small" onClick={() => setShowTechnical((v) => !v)}>
          {showTechnical ? 'Hide' : 'Show'} technical details
        </Button>
        {showTechnical && (
          <Box className="mt-1 rounded-lg border border-border p-2">
            {Object.entries(formatSelectors).map(([key, value]) => (
              <Typography key={key} variant="body2" className="font-mono break-all">
                {key}: {value}
              </Typography>
            ))}
            {hls && (
              <>
                <Typography variant="body2" className="font-mono break-all">
                  hls.sessionKey: {hls.sessionKey}
                </Typography>
                <Typography variant="body2" className="font-mono break-all">
                  hls.sessionAlreadyActive: {String(hls.sessionAlreadyActive)}
                </Typography>
              </>
            )}
            {plan.ignoredQueryParams.length > 0 && (
              <Typography variant="body2" className="font-mono break-all">
                forceServerSettings ignored: {plan.ignoredQueryParams.join(', ')}
              </Typography>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
};
