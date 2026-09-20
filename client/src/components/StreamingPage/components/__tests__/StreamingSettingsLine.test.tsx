import React from 'react';
import { render, screen } from '@testing-library/react';
import { StreamingSettingsLine } from '../StreamingSettingsLine';

const mockUseConfig = jest.fn();
const mockUseCompat = jest.fn();

jest.mock('../../../../hooks/useConfig', () => ({ useConfig: (...args: unknown[]) => mockUseConfig(...args) }));
jest.mock('../../../Configuration/hooks/useYtstreamModeCompatibility', () => ({
  useYtstreamModeCompatibility: (...args: unknown[]) => mockUseCompat(...args),
}));

const configWith = (ytstream: Record<string, unknown>) => ({ config: { ytstream } });

describe('StreamingSettingsLine', () => {
  beforeEach(() => {
    mockUseCompat.mockReturnValue({ container: { status: 'optional' }, transcode: { status: 'optional' } });
  });

  it('renders nothing when server settings are not forced', () => {
    mockUseConfig.mockReturnValue(configWith({ forceServerSettings: false, defaultMode: 'hls' }));
    const { container } = render(<StreamingSettingsLine token="t" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says the settings override any a .strm URL carries', () => {
    mockUseConfig.mockReturnValue(configWith({ forceServerSettings: true, defaultMode: 'hls', quality: '1080', qualityStrictness: 'fallback', container: 'mp4', transcode: 'copy' }));
    render(<StreamingSettingsLine token="t" />);
    expect(screen.getByText(/override any settings a \.strm URL carries/)).toBeInTheDocument();
  });

  it('shows the mode and quality in force', () => {
    mockUseConfig.mockReturnValue(configWith({ forceServerSettings: true, defaultMode: 'hls', quality: '1080', qualityStrictness: 'fallback', container: 'mp4', transcode: 'copy' }));
    render(<StreamingSettingsLine token="t" />);
    expect(screen.getByText('HLS')).toBeInTheDocument();
    expect(screen.getByText('1080p (fallback)')).toBeInTheDocument();
  });

  it('shows the plain file mode with its container', () => {
    mockUseConfig.mockReturnValue(configWith({ forceServerSettings: true, defaultMode: 'hls-byterange', byteRangeDeliverAsFile: true, container: 'mkv', quality: '1080', transcode: 'copy' }));
    render(<StreamingSettingsLine token="t" />);
    expect(screen.getByText('Byte-range Plain file')).toBeInTheDocument();
    expect(screen.getByText('Matroska')).toBeInTheDocument();
  });

  it('asks the compatibility table about the configured mode', () => {
    mockUseConfig.mockReturnValue(configWith({ forceServerSettings: true, defaultMode: 'youtube-hls', transcode: '', container: 'mp4' }));
    render(<StreamingSettingsLine token="t" />);
    expect(mockUseCompat).toHaveBeenCalledWith('youtube-hls', '', 't', 'mp4');
  });
});
