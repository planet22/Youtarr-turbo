import React from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import NzbSearchTraceDialog from '../NzbSearchTraceDialog';
import { NzbSearchTrace, NzbSearchTraceItem } from '../../../../hooks/useNzbStats';
import { renderWithProviders } from '../../../../test-utils';

const buildItem = (overrides: Partial<NzbSearchTraceItem> = {}): NzbSearchTraceItem => ({
  youtubeId: 'abc123DEF45',
  title: 'A Video Title',
  kept: true,
  reason: null,
  matchedTerm: null,
  effectiveHeightTier: 1080,
  resolutionSource: 'api',
  ...overrides,
});

const buildTrace = (overrides: Partial<NzbSearchTrace> = {}): NzbSearchTrace => ({
  timestamp: Date.now(),
  categoryName: 'tv',
  searchType: 'tvsearch',
  query: 'my show',
  newquery: null,
  season: null,
  ep: null,
  additionalLocalFilterEnabled: true,
  offset: 0,
  limit: 25,
  configuredHeightTier: 1080,
  items: [buildItem()],
  ...overrides,
});

function renderDialog(trace: NzbSearchTrace | null, onClose = jest.fn()) {
  const utils = renderWithProviders(<NzbSearchTraceDialog trace={trace} onClose={onClose} />);
  return { ...utils, onClose };
}

// Titles of the body rows, in display order
const rowTitles = () => screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent);

describe('NzbSearchTraceDialog', () => {
  it('renders nothing without a trace', () => {
    renderDialog(null);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is titled with the category', () => {
    renderDialog(buildTrace({ categoryName: 'movies' }));

    expect(screen.getByText('Search detail - movies')).toBeInTheDocument();
  });

  it('closes from the Close button', async () => {
    const { onClose } = renderDialog(buildTrace());

    // the title bar has its own close control as well as the footer button
    const closeButtons = within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' });
    await userEvent.click(closeButtons[closeButtons.length - 1]);

    expect(onClose).toHaveBeenCalled();
  });

  describe('summary', () => {
    it('shows the query that was searched', () => {
      renderDialog(buildTrace());

      expect(screen.getByText(/^\s*my show$/)).toBeInTheDocument();
    });

    it('shows what was actually sent when it differs from the original request', () => {
      renderDialog(buildTrace({ query: 'my show', newquery: 'my show S01E02' }));

      expect(screen.getByText(/my show S01E02/)).toBeInTheDocument();
      expect(screen.getByText('Originally requested as: my show')).toBeInTheDocument();
    });

    it('does not mention an original request when the query was unchanged', () => {
      renderDialog(buildTrace());

      expect(screen.queryByText(/Originally requested as/)).not.toBeInTheDocument();
    });

    it('omits the season/episode line when neither was requested', () => {
      renderDialog(buildTrace());

      expect(screen.queryByText(/Season\/Episode requested/)).not.toBeInTheDocument();
    });

    it('shows the requested season and episode', () => {
      renderDialog(buildTrace({ season: 2, ep: 5 }));

      expect(screen.getByText(/2 \/ 5/)).toBeInTheDocument();
    });

    it('shows a question mark for a missing episode', () => {
      renderDialog(buildTrace({ season: 2, ep: null }));

      expect(screen.getByText(/2 \/ \?/)).toBeInTheDocument();
    });

    it('shows a question mark for a missing season', () => {
      renderDialog(buildTrace({ season: null, ep: 4 }));

      expect(screen.getByText(/\? \/ 4/)).toBeInTheDocument();
    });

    it.each([
      [true, 'On'],
      [false, 'Off'],
    ])('reports the local filter as %s', (enabled, label) => {
      renderDialog(buildTrace({ additionalLocalFilterEnabled: enabled }));

      expect(screen.getByText(new RegExp(`^\\s*${label} - `))).toBeInTheDocument();
    });

    it('counts how many candidates were kept', () => {
      renderDialog(buildTrace({ items: [buildItem(), buildItem({ kept: false, reason: 'keyword' }), buildItem({ kept: false, reason: 'keyword' })] }));

      expect(screen.getByText(/1 of 3 candidates kept/)).toBeInTheDocument();
    });
  });

  describe('reason key', () => {
    it('is hidden when nothing was rejected', () => {
      renderDialog(buildTrace());

      expect(screen.queryByText('Reason key')).not.toBeInTheDocument();
    });

    it.each([
      ['keyword', 'Missing search keyword'],
      ['excluded-term', 'Matched an excluded term'],
      ['episode-code', 'Season/episode code problem'],
      ['wrong-season', 'Season/episode code problem'],
      ['wrong-episode', 'Season/episode code problem'],
      ['no-episode-marker', 'Season/episode code problem'],
    ] as const)('explains the %s reason group', (reason, label) => {
      renderDialog(buildTrace({ items: [buildItem({ kept: false, reason })] }));

      expect(screen.getByText(label)).toBeInTheDocument();
    });

    it('lists each group in use only once', () => {
      renderDialog(buildTrace({
        items: [
          buildItem({ kept: false, reason: 'wrong-season' }),
          buildItem({ kept: false, reason: 'wrong-episode' }),
        ],
      }));

      expect(screen.getAllByText('Season/episode code problem')).toHaveLength(1);
    });

    it('only lists groups that appear', () => {
      renderDialog(buildTrace({ items: [buildItem({ kept: false, reason: 'keyword' })] }));

      expect(screen.queryByText('Matched an excluded term')).not.toBeInTheDocument();
    });
  });

  describe('candidate rows', () => {
    it('marks each candidate as kept or rejected', () => {
      renderDialog(buildTrace({ items: [buildItem({ title: 'Good' }), buildItem({ title: 'Bad', kept: false, reason: 'keyword', matchedTerm: 'show' })] }));

      expect(screen.getByText('Kept')).toBeInTheDocument();
      expect(screen.getByText('Rejected')).toBeInTheDocument();
    });

    it('links a candidate to its YouTube page', () => {
      renderDialog(buildTrace({ items: [buildItem({ title: 'Linked', youtubeId: 'abc123DEF45' })] }));

      const link = screen.getByRole('link', { name: 'Linked' });
      expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc123DEF45');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('does not link a candidate that has no video id', () => {
      renderDialog(buildTrace({ items: [buildItem({ title: 'No Id', youtubeId: '' })] }));

      expect(screen.getByText('No Id')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('highlights the excluded term inside a rejected title', () => {
      renderDialog(buildTrace({
        items: [buildItem({ title: 'Official Trailer HD', kept: false, reason: 'excluded-term', matchedTerm: 'trailer' })],
      }));

      expect(screen.getByText('Trailer')).toHaveStyle({ fontWeight: 600 });
    });

    it('does not highlight a missing keyword, since it is not in the title', () => {
      renderDialog(buildTrace({
        items: [buildItem({ title: 'Some Title', kept: false, reason: 'keyword', matchedTerm: 'title' })],
      }));

      expect(screen.getByText('Some Title')).toBeInTheDocument();
    });
  });

  describe('resolution column', () => {
    it('shows a dash for a rejected candidate', () => {
      renderDialog(buildTrace({ items: [buildItem({ kept: false, reason: 'keyword' })] }));

      expect(screen.getByText('—')).toBeInTheDocument();
    });

    it('says a kept candidate outside the returned page was not probed', () => {
      renderDialog(buildTrace({ items: [buildItem({ effectiveHeightTier: null })] }));

      expect(screen.getByText('not probed')).toBeInTheDocument();
    });

    it('shows the resolution of a probed candidate', () => {
      renderDialog(buildTrace({ items: [buildItem({ effectiveHeightTier: 1080 })] }));

      expect(screen.getByText('1080p')).toBeInTheDocument();
    });

    it('shows a candidate capped below the configured quality', () => {
      renderDialog(buildTrace({ configuredHeightTier: 1080, items: [buildItem({ effectiveHeightTier: 480, definition: 'sd' })] }));

      expect(screen.getByText('480p')).toBeInTheDocument();
    });

    it('shows the resolution when no configured tier is known', () => {
      renderDialog(buildTrace({ configuredHeightTier: undefined, items: [buildItem({ effectiveHeightTier: 720 })] }));

      expect(screen.getByText('720p')).toBeInTheDocument();
    });

    it('explains where a resolution came from in a tooltip', async () => {
      renderDialog(buildTrace({ items: [buildItem({ effectiveHeightTier: 1080, resolutionSource: 'thumb' })] }));

      await userEvent.hover(screen.getByText('1080p'));

      expect((await screen.findAllByText('From a thumbnail check')).length).toBeGreaterThan(0);
    });

    it('explains a capped resolution in a tooltip', async () => {
      renderDialog(buildTrace({ configuredHeightTier: 1080, items: [buildItem({ effectiveHeightTier: 480, resolutionSource: 'extract' })] }));

      await userEvent.hover(screen.getByText('480p'));

      expect((await screen.findAllByText(/capped down from the configured 1080p/)).length).toBeGreaterThan(0);
    });

    it('falls back to a config-derived source when none was recorded', async () => {
      renderDialog(buildTrace({ items: [buildItem({ effectiveHeightTier: 1080, resolutionSource: null })] }));

      await userEvent.hover(screen.getByText('1080p'));

      expect((await screen.findAllByText('From fixed from config')).length).toBeGreaterThan(0);
    });
  });

  describe('reason tooltips', () => {
    it.each([
      ['keyword', 'show', { season: null, ep: null }, 'Missing search keyword: "show"'],
      ['excluded-term', 'trailer', { season: null, ep: null }, 'Matched excluded term: "trailer"'],
      ['wrong-season', 'S03', { season: 1, ep: 2 }, 'Wrong season - title has "S03", wanted season 1'],
      ['wrong-episode', 'S01E09', { season: 1, ep: 2 }, 'Wrong episode - title has "S01E09", wanted S1E2'],
      ['no-episode-marker', 'S01', { season: 1, ep: 2 }, 'Season matches ("S01") but no episode number was found'],
      ['episode-code', null, { season: 1, ep: 2 }, 'No season/episode code found in the title at all'],
    ] as const)('spells out the %s reason', async (reason, matchedTerm, seasonEp, message) => {
      renderDialog(buildTrace({ ...seasonEp, items: [buildItem({ title: 'Some Title', kept: false, reason, matchedTerm })] }));
      const row = screen.getByRole('row', { name: /Some Title/ });

      for (const span of within(row).getAllByRole('generic').filter((el) => el.tagName === 'SPAN')) {
        await userEvent.hover(span);
      }

      expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    });
  });

  describe('status sorting', () => {
    const items = [
      buildItem({ title: 'first kept' }),
      buildItem({ title: 'first rejected', kept: false, reason: 'keyword', matchedTerm: 'x' }),
      buildItem({ title: 'second kept' }),
      buildItem({ title: 'second rejected', kept: false, reason: 'keyword', matchedTerm: 'x' }),
    ];

    it('starts in the original order', () => {
      renderDialog(buildTrace({ items }));

      expect(rowTitles()).toEqual(['first kept', 'first rejected', 'second kept', 'second rejected']);
    });

    it('puts kept candidates first on the first click, preserving order within each group', async () => {
      renderDialog(buildTrace({ items }));

      await userEvent.click(screen.getByText('Status'));

      expect(rowTitles()).toEqual(['first kept', 'second kept', 'first rejected', 'second rejected']);
    });

    it('puts rejected candidates first on the second click', async () => {
      renderDialog(buildTrace({ items }));
      await userEvent.click(screen.getByText('Status'));

      await userEvent.click(screen.getByText('Status'));

      expect(rowTitles()).toEqual(['first rejected', 'second rejected', 'first kept', 'second kept']);
    });

    it('returns to the original order on the third click', async () => {
      renderDialog(buildTrace({ items }));

      await userEvent.click(screen.getByText('Status'));
      await userEvent.click(screen.getByText('Status'));
      await userEvent.click(screen.getByText('Status'));

      expect(rowTitles()).toEqual(['first kept', 'first rejected', 'second kept', 'second rejected']);
    });
  });
});
