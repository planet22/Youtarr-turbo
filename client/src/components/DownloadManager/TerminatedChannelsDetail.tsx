import React from 'react';
import { Box, Typography } from '../ui';
import { TerminatedChannelInfo } from '../../types/Job';

interface TerminatedChannelsDetailProps {
  terminatedChannels?: TerminatedChannelInfo[];
  terminationFailures?: string[];
}

// Compact listing for an expanded Download History row: which channels
// YouTube reported as terminated during this job (auto-disabled so they
// stop being scheduled) and which terminations couldn't be auto-disabled
// and need manual attention.
function TerminatedChannelsDetail({
  terminatedChannels = [],
  terminationFailures = [],
}: TerminatedChannelsDetailProps) {
  if (terminatedChannels.length === 0 && terminationFailures.length === 0) {
    return null;
  }

  return (
    <Box className="mt-2 flex flex-col gap-1">
      {terminatedChannels.length > 0 && (
        <Box className="flex flex-col gap-0.5">
          <Typography
            variant="caption"
            className="font-semibold"
            style={{ color: 'var(--destructive)' }}
          >
            Channels marked terminated by YouTube
          </Typography>
          {terminatedChannels.map((channel) => (
            <Typography key={channel.channelId} variant="caption" color="secondary">
              • {channel.uploader || channel.channelId} (scheduled downloads disabled)
            </Typography>
          ))}
        </Box>
      )}
      {terminationFailures.length > 0 && (
        <Box className="flex flex-col gap-0.5">
          <Typography
            variant="caption"
            className="font-semibold"
            style={{ color: 'var(--destructive)' }}
          >
            Terminated channels that could not be auto-disabled
          </Typography>
          {terminationFailures.map((channelId) => (
            <Typography key={channelId} variant="caption" color="secondary">
              • {channelId} - disable manually to stop retrying it
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

export default TerminatedChannelsDetail;
