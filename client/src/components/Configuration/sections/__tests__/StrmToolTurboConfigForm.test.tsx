import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import StrmToolTurboConfigForm from '../StrmToolTurboConfigForm';
import { renderWithProviders } from '../../../../test-utils';

const CONFIG = {
  enableAutoExtract: false,
  enableMediaInfoCache: true,
  importExistingCacheWhenMissing: true,
  forceRefreshIgnoreExisting: false,
  forceRefreshIgnoreCache: false,
  refreshDelayMs: 5000,
  metadataRestoreTimeoutMinutes: 5,
  maxConcurrentExtract: 5,
};

describe('StrmToolTurboConfigForm', () => {
  const onSave = jest.fn().mockResolvedValue(true);

  beforeEach(() => jest.clearAllMocks());

  test('starts with Save disabled because nothing changed', () => {
    renderWithProviders(<StrmToolTurboConfigForm config={CONFIG} saving={false} onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Save to Jellyfin' })).toBeDisabled();
  });

  test('saves only the fields that changed', async () => {
    renderWithProviders(<StrmToolTurboConfigForm config={CONFIG} saving={false} onSave={onSave} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Automatically extract media info for new strm files' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save to Jellyfin' }));
    expect(onSave).toHaveBeenCalledWith({ enableAutoExtract: true });
  });

  test('saves an edited number', async () => {
    renderWithProviders(<StrmToolTurboConfigForm config={CONFIG} saving={false} onSave={onSave} />);
    const field = screen.getByLabelText('Maximum concurrent extractions');
    await userEvent.clear(field);
    await userEvent.type(field, '12');
    await userEvent.click(screen.getByRole('button', { name: 'Save to Jellyfin' }));
    expect(onSave).toHaveBeenCalledWith({ maxConcurrentExtract: 12 });
  });

  test('disables Save when a number is out of range', async () => {
    renderWithProviders(<StrmToolTurboConfigForm config={CONFIG} saving={false} onSave={onSave} />);
    const field = screen.getByLabelText('Maximum concurrent extractions');
    await userEvent.clear(field);
    await userEvent.type(field, '99');
    expect(screen.getByRole('button', { name: 'Save to Jellyfin' })).toBeDisabled();
  });

  test('discard reverts edits', async () => {
    renderWithProviders(<StrmToolTurboConfigForm config={CONFIG} saving={false} onSave={onSave} />);
    const toggle = screen.getByRole('checkbox', { name: 'Enable media info caching' });
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(toggle).toBeChecked();
  });

  test('shows a saving state', () => {
    renderWithProviders(<StrmToolTurboConfigForm config={CONFIG} saving onSave={onSave} />);
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });
});
