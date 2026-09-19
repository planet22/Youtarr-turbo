import React, { useMemo } from 'react';
import { Typography } from '../../ui';
import { useConfig } from '../../../hooks/useConfig';
import { useYtstreamModeCompatibility } from '../../Configuration/hooks/useYtstreamModeCompatibility';
import { buildForcedSettingsSummary } from './settingsSummary';
import type { YtstreamSummaryInput } from './settingsSummary';

interface StreamingSettingsLineProps {
  token: string | null;
}

/**
 * One line under the streams list showing the server settings every request
 * is served with - only when "force server settings" is on (otherwise each
 * .strm URL carries its own), and only the settings the current mode uses.
 * Read-only: changes are made on the Settings page.
 */
export const StreamingSettingsLine: React.FC<StreamingSettingsLineProps> = ({ token }) => {
  const { config } = useConfig(token);
  const ytstream = config.ytstream as YtstreamSummaryInput | undefined;
  const compat = useYtstreamModeCompatibility(ytstream?.defaultMode || 'direct', ytstream?.transcode || '', token, ytstream?.container || '');
  const items = useMemo(() => buildForcedSettingsSummary(ytstream, compat), [ytstream, compat]);
  if (!items) return null;

  return (
    <div style={{ padding: '8px 16px' }}>
      <Typography variant="caption" style={{ color: 'var(--muted-foreground)', display: 'block', textAlign: 'center' }}>
        Server settings in force (they override any settings a .strm URL carries):{' '}
        {items.map((item, index) => (
          <React.Fragment key={item.label}>
            {index > 0 && ' · '}
            <span>{item.label} <strong style={{ color: 'var(--foreground)' }}>{item.value}</strong></span>
          </React.Fragment>
        ))}
      </Typography>
    </div>
  );
};
