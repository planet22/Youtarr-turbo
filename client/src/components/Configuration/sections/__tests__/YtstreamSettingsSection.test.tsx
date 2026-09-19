import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import { YtstreamSettingsSection, DEFAULT_YTSTREAM } from '../YtstreamSettingsSection';
import { renderWithProviders } from '../../../../test-utils';
import { DEFAULT_CONFIG } from '../../../../config/configSchema';
import { ConfigState } from '../../types';

const createConfig = (ytstream: Partial<ConfigState['ytstream']>): ConfigState => ({
  ...DEFAULT_CONFIG,
  ytstream: { ...DEFAULT_YTSTREAM, ...ytstream },
});

const setupSection = (ytstream: Partial<ConfigState['ytstream']>) => {
  const onConfigChange = jest.fn();
  renderWithProviders(
    <YtstreamSettingsSection
      config={createConfig(ytstream)}
      onConfigChange={onConfigChange}
      token={null}
    />
  );
  return onConfigChange;
};

describe('YtstreamSettingsSection', () => {
  describe('Byte-range Plain file container', () => {
    const plainFile = { defaultMode: 'hls-byterange' as const, byteRangeDeliverAsFile: true };

    test('shows Matroska as the container', () => {
      setupSection({ ...plainFile, container: 'mkv' });

      expect(screen.getByRole('button', { name: 'Matroska' })).toBeInTheDocument();
    });

    test('shows Matroska even when the saved container is still mp4', () => {
      setupSection({ ...plainFile, container: 'mp4' });

      expect(screen.getByRole('button', { name: 'Matroska' })).toBeInTheDocument();
    });

    test('locks the container dropdown', () => {
      setupSection({ ...plainFile, container: 'mkv' });

      expect(screen.getByRole('button', { name: 'Matroska' })).toBeDisabled();
    });

    test('saves mkv when the stored container is not mkv', () => {
      const onConfigChange = setupSection({ ...plainFile, container: 'mp4' });

      expect(onConfigChange).toHaveBeenCalledWith({
        ytstream: expect.objectContaining({ container: 'mkv' }),
      });
    });

    test('does not rewrite the container when it is already mkv', () => {
      const onConfigChange = setupSection({ ...plainFile, container: 'mkv' });

      expect(onConfigChange).not.toHaveBeenCalled();
    });
  });

  test('does not force the container in Byte-range HLS (manifest) mode', () => {
    const onConfigChange = setupSection({
      defaultMode: 'hls-byterange',
      byteRangeDeliverAsFile: false,
      container: 'mp4',
    });

    expect(onConfigChange).not.toHaveBeenCalled();
  });

  test('does not offer a hot-swap toggle', () => {
    setupSection({ defaultMode: 'hls' });

    expect(screen.queryByLabelText(/hot-swap/i)).not.toBeInTheDocument();
  });
});
