import React from 'react';
import { Accordion, AccordionSummary, AccordionDetails, Grid, Typography } from '../../../ui';
import { HardwareCapabilitiesTable } from './HardwareCapabilitiesTable';
import { HardwareCapabilityMatrix } from '../../hooks/useHardwareCapabilities';

interface HardwareTestingAccordionProps {
  matrix: HardwareCapabilityMatrix | null;
  decodeMatrix?: HardwareCapabilityMatrix | null;
  testing: boolean;
  error: string | null;
  onRunTest: () => void;
  onMobileTooltipClick?: (text: string) => void;
}

/**
 * Collapsible "Hardware Testing" section wrapping HardwareCapabilitiesTable -
 * same accordion presentation used by both Settings -> Streaming and
 * Settings -> YT-DLP (download-transcode), since the underlying test
 * (POST /api/ytdlp/test-hardware-capabilities) is a plain host/ffmpeg
 * capability probe, not scoped to either feature. Kept to hardware
 * capability only, deliberately not the streaming section's tuning
 * benchmark: that benchmark's entire premise ("fast enough for real-time
 * HLS/live streaming") and its 3-tier resolution grid are meaningless for a
 * background download transcode, which has no tuning-tier setting to
 * recommend a tier for in the first place. See YtstreamSettingsSection.tsx
 * for that streaming-specific tuning UI, kept separate and inline there.
 */
export const HardwareTestingAccordion: React.FC<HardwareTestingAccordionProps> = ({
  matrix,
  decodeMatrix,
  testing,
  error,
  onRunTest,
  onMobileTooltipClick,
}) => {
  return (
    <Accordion style={{ border: 'var(--border-weight) solid var(--border)', borderRadius: 'var(--radius-ui)' }}>
      <AccordionSummary>
        <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
          Hardware Testing
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <HardwareCapabilitiesTable
              matrix={matrix}
              decodeMatrix={decodeMatrix}
              testing={testing}
              error={error}
              onRunTest={onRunTest}
              onMobileTooltipClick={onMobileTooltipClick}
            />
          </Grid>
        </Grid>
      </AccordionDetails>
    </Accordion>
  );
};
