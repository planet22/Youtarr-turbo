import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import NzbSettingsIcons from '../NzbSettingsIcons';
import HighlightedTitle from '../HighlightedTitle';
import { NzbSearchSettings } from '../../../../hooks/useNzbStats';
import { renderWithProviders } from '../../../../test-utils';

const ytdlp = (overrides: Partial<NzbSearchSettings> = {}): NzbSearchSettings => ({
  backend: 'yt-dlp',
  cookiesEnabled: false,
  proxy: null,
  ipFamily: null,
  hasCustomArgs: false,
  ...overrides,
});

// Every icon sits in its own span, whose tooltip text appears on hover.
const iconSlots = () => screen.getAllByRole('generic').filter((el) => el.tagName === 'SPAN');

describe('NzbSettingsIcons', () => {
  it('renders nothing without settings', () => {
    const { container } = renderWithProviders(<NzbSettingsIcons settings={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('always renders five icon slots', () => {
    renderWithProviders(<NzbSettingsIcons settings={ytdlp()} />);

    expect(iconSlots()).toHaveLength(5);
  });

  it('keeps five slots for the YouTube API backend too', () => {
    renderWithProviders(<NzbSettingsIcons settings={ytdlp({ backend: 'youtube-api' })} />);

    expect(iconSlots()).toHaveLength(5);
  });

  it.each([
    [ytdlp(), 'Search engine: yt-dlp'],
    [ytdlp({ backend: 'youtube-api' }), 'Search engine: YouTube Data API'],
    [ytdlp({ cookiesEnabled: true }), 'Cookies: enabled'],
    [ytdlp({ cookiesEnabled: false }), 'Cookies: not enabled'],
    [ytdlp({ proxy: 'http://proxy:3128' }), 'Proxy: http://proxy:3128'],
    [ytdlp({ proxy: null }), 'Proxy: none'],
    [ytdlp({ ipFamily: 'ipv6' }), 'IP version: IPv6'],
    [ytdlp({ ipFamily: 'auto' }), 'IP version: Auto'],
    [ytdlp({ ipFamily: 'ipv4' }), 'IP version: IPv4 (default)'],
    [ytdlp({ ipFamily: null }), 'IP version: IPv4 (default)'],
    [ytdlp({ hasCustomArgs: true }), 'Custom yt-dlp args: set'],
    [ytdlp({ hasCustomArgs: false }), 'Custom yt-dlp args: none'],
  ])('describes %j as "%s"', async (settings, tooltip) => {
    renderWithProviders(<NzbSettingsIcons settings={settings} />);
    for (const icon of iconSlots()) {
      await userEvent.hover(icon);
    }

    expect((await screen.findAllByText(tooltip)).length).toBeGreaterThan(0);
  });

  it.each([
    ['cookies', { cookiesEnabled: true }, 'Cookies: not enabled'],
    ['proxy', { proxy: 'http://p' }, 'Proxy: none'],
    ['custom args', { hasCustomArgs: true }, 'Custom yt-dlp args: none'],
  ])('ignores %s when the YouTube API backend is in use', async (_label, extra, wrongTooltip) => {
    renderWithProviders(<NzbSettingsIcons settings={ytdlp({ backend: 'youtube-api', ...extra })} />);
    for (const icon of iconSlots()) {
      await userEvent.hover(icon);
    }

    expect((await screen.findAllByText(wrongTooltip)).length).toBeGreaterThan(0);
  });
});

describe('HighlightedTitle', () => {
  it('shows the title unchanged without a matched term', () => {
    renderWithProviders(<HighlightedTitle title="Plain Title" matchedTerm={null} />);

    expect(screen.getByText('Plain Title')).toBeInTheDocument();
  });

  it('highlights the matched text', () => {
    renderWithProviders(<HighlightedTitle title="Official Trailer HD" matchedTerm="Trailer" />);

    expect(screen.getByText('Trailer')).toHaveStyle({ fontWeight: 600 });
  });

  it('matches case-insensitively while keeping the title casing', () => {
    renderWithProviders(<HighlightedTitle title="Official TRAILER HD" matchedTerm="trailer" />);

    expect(screen.getByText('TRAILER')).toBeInTheDocument();
  });

  it('keeps the text around the highlight', () => {
    const { container } = renderWithProviders(<HighlightedTitle title="Official Trailer HD" matchedTerm="Trailer" />);

    expect(container).toHaveTextContent('Official Trailer HD');
  });

  it('only highlights the first occurrence', () => {
    renderWithProviders(<HighlightedTitle title="ad and ad" matchedTerm="ad" />);

    expect(screen.getAllByText('ad')).toHaveLength(1);
  });

  it('shows the title unchanged when the term is not in it', () => {
    renderWithProviders(<HighlightedTitle title="Something Else" matchedTerm="missing" />);

    expect(screen.getByText('Something Else')).toBeInTheDocument();
  });
});
