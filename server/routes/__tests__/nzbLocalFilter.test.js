const { applyLocalTitleFilter, evaluateTitleFilter } = require('../nzb');

function video(title) {
  return { youtubeId: title, title };
}

describe('nzb.js applyLocalTitleFilter - season known, episode not yet (Sonarr "search missing episodes in season" style)', () => {
  test('rejects a title that only mentions the season with no episode number (e.g. a trailer/advert)', () => {
    // Regression case: Sonarr's own release parser reads "season number
    // present, episode number absent" as a season pack and grabs it
    // expecting an archive to extract - but YouTube never has real season
    // packs, so this must never pass the filter.
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice Series 4 Advert')],
      'Celebrity Juice',
      { season: 4, ep: null }
    );
    expect(filtered).toHaveLength(0);
  });

  test('still rejects a "COMPLETE"/season-pack-labeled upload with no episode number', () => {
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice S04 COMPLETE ALL EPISODES')],
      'Celebrity Juice',
      { season: 4, ep: null }
    );
    expect(filtered).toHaveLength(0);
  });

  test('keeps a real per-episode title in SxxEyy form', () => {
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice S04E01')],
      'Celebrity Juice',
      { season: 4, ep: null }
    );
    expect(filtered).toHaveLength(1);
  });

  test('keeps a real per-episode title in spelled-out form', () => {
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice Season 4 Episode 3')],
      'Celebrity Juice',
      { season: 4, ep: null }
    );
    expect(filtered).toHaveLength(1);
  });

  test('keeps a real per-episode title in NxM form', () => {
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice 4x02')],
      'Celebrity Juice',
      { season: 4, ep: null }
    );
    expect(filtered).toHaveLength(1);
  });
});

describe('nzb.js applyLocalTitleFilter - season and episode both known', () => {
  test('keeps an exact SxxEyy match', () => {
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice S04E01')],
      'Celebrity Juice',
      { season: 4, ep: 1 }
    );
    expect(filtered).toHaveLength(1);
  });

  test('rejects a different episode number in the same season', () => {
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice S04E02')],
      'Celebrity Juice',
      { season: 4, ep: 1 }
    );
    expect(filtered).toHaveLength(0);
  });
});

describe('nzb.js applyLocalTitleFilter - excludeTerms (movies, no season/episode structure to check)', () => {
  // Real-world case: a Radarr movie search for a real special returned
  // nothing but DVD-extra clips (all genuinely contain every query keyword,
  // so keyword matching alone can't distinguish them) - excludeTerms is the
  // per-category denylist a user configures in Settings for exactly this.
  const junkTitles = [
    'Celebrity Juice Too Juicy for TV 2011 Outtakes',
    'Celebrity Juice Too Juicy for TV 2011 Behind the Scenes',
    'Celebrity Juice Too Juicy for TV 2011 Unseen',
  ];
  const excludeTerms = ['outtakes', 'behind the scenes', 'unseen'];

  test('drops titles containing any excluded term, case-insensitively', () => {
    const filtered = applyLocalTitleFilter(
      junkTitles.map(video),
      'Celebrity Juice Too Juicy for TV 2011',
      { excludeTerms }
    );
    expect(filtered).toHaveLength(0);
  });

  test('keeps a title that matches the query but no excluded term', () => {
    const filtered = applyLocalTitleFilter(
      [video('Celebrity Juice Too Juicy for TV 2011 The Best Bits'), ...junkTitles.map(video)],
      'Celebrity Juice Too Juicy for TV 2011',
      { excludeTerms }
    );
    expect(filtered).toEqual([
      expect.objectContaining({ title: 'Celebrity Juice Too Juicy for TV 2011 The Best Bits' }),
    ]);
  });

  test('an empty/absent excludeTerms list filters nothing extra', () => {
    const filtered = applyLocalTitleFilter(junkTitles.map(video), 'Celebrity Juice Too Juicy for TV 2011', {});
    expect(filtered).toHaveLength(3);
  });
});

describe('nzb.js evaluateTitleFilter - reason/matchedTerm reporting (diagnostics trace)', () => {
  test('reports the specific excluded term that matched', () => {
    const verdict = evaluateTitleFilter('Celebrity Juice Series 4 Outtakes', 'Celebrity Juice', {
      excludeTerms: ['outtakes', 'behind the scenes'],
    });
    expect(verdict).toEqual({ kept: false, reason: 'excluded-term', matchedTerm: 'outtakes' });
  });

  test('reports the missing keyword when the title lacks a search term', () => {
    const verdict = evaluateTitleFilter('Some Unrelated Video', 'Celebrity Juice', {});
    expect(verdict).toMatchObject({ kept: false, reason: 'keyword' });
    expect(['celebrity', 'juice']).toContain(verdict.matchedTerm);
  });

  test('reports no-episode-marker (not the generic episode-code bucket) when the season matches but no episode number is present', () => {
    const verdict = evaluateTitleFilter('Celebrity Juice Series 4 Advert', 'Celebrity Juice', { season: 4, ep: null });
    expect(verdict).toEqual({ kept: false, reason: 'no-episode-marker', matchedTerm: 'Series 4' });
  });

  test('reports wrong-season when the title has a real episode code but for a different season', () => {
    // Regression case: a season-20 search rejecting a title that says S21
    // must say "wrong season", not the same generic message as a title with
    // no season/episode code at all - very different problems to diagnose.
    const verdict = evaluateTitleFilter('Celebrity Juice S21E05', 'Celebrity Juice', { season: 20, ep: null });
    expect(verdict).toEqual({ kept: false, reason: 'wrong-season', matchedTerm: 'S21E05' });
  });

  test('reports wrong-episode when the season matches but the episode number does not', () => {
    const verdict = evaluateTitleFilter('Celebrity Juice S04E02', 'Celebrity Juice', { season: 4, ep: 1 });
    expect(verdict).toEqual({ kept: false, reason: 'wrong-episode', matchedTerm: 'S04E02' });
  });

  test('falls back to the generic episode-code reason when nothing season/episode-shaped is present at all', () => {
    const verdict = evaluateTitleFilter('Celebrity Juice Live Tour', 'Celebrity Juice', { season: 4, ep: null });
    expect(verdict).toEqual({ kept: false, reason: 'episode-code', matchedTerm: null });
  });

  test('kept with no reason when everything passes', () => {
    const verdict = evaluateTitleFilter('Celebrity Juice S04E01', 'Celebrity Juice', { season: 4, ep: null });
    expect(verdict).toEqual({ kept: true, reason: null, matchedTerm: null });
  });
});
