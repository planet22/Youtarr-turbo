import React, { useState } from 'react';
import { Alert, Box, Button, Typography } from '../../../ui';
import { YtstreamDryRunResult } from '../../types';

interface YtstreamDryRunPreviewProps {
  result: YtstreamDryRunResult;
}

export const YtstreamDryRunPreview: React.FC<YtstreamDryRunPreviewProps> = ({ result }) => {
  const [showTechnical, setShowTechnical] = useState(false);
  const { plan, formatSelectors, hls, wouldCall } = result;

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
          {plan.steps.map((step, index) => (
            <Typography key={`dryrun-step-${index}`} component="li" variant="body2">
              {step.detail}
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
