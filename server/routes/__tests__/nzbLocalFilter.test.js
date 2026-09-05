const { applyLocalTitleFilter } = require('../nzb');

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
