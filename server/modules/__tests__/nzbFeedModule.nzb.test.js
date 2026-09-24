/* eslint-env jest */

jest.mock('../../logger');

const logger = require('../../logger');
const nzbFeedModule = require('../nzbFeedModule');

const baseOpts = {
  categoryName: 'My Category',
  newznabCategoryIds: ['5040', '5000'],
  baseUrl: 'http://localhost:3011',
  apikey: 'key&secret',
  quality: '1080',
};

describe('nzbFeedModule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('escapeXml', () => {
    it.each([
      ['&', '&amp;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['"', '&quot;'],
      ['\'', '&apos;'],
    ])('escapes %s', (input, expected) => {
      expect(nzbFeedModule.escapeXml(input)).toBe(expected);
    });

    it('returns an empty string for null and undefined', () => {
      expect([nzbFeedModule.escapeXml(null), nzbFeedModule.escapeXml(undefined)]).toEqual(['', '']);
    });

    it('coerces numbers to strings', () => {
      expect(nzbFeedModule.escapeXml(42)).toBe('42');
    });

    it('does not double escape ampersands from other replacements', () => {
      expect(nzbFeedModule.escapeXml('<a>')).toBe('&lt;a&gt;');
    });
  });

  describe('resolveQualityTier', () => {
    it.each([
      ['best', 2160],
      ['MAX', 2160],
      ['maximum', 2160],
      ['2160', 2160],
      ['1440', 1440],
      ['1080', 1080],
      ['720', 720],
      ['480', 480],
      ['360', 360],
    ])('maps %s to %i', (quality, expected) => {
      expect(nzbFeedModule.resolveQualityTier(quality)).toBe(expected);
    });

    it('snaps an in-between value down to the tier at or below it', () => {
      expect(nzbFeedModule.resolveQualityTier('900')).toBe(720);
    });

    it('snaps a value below the smallest tier up to 360', () => {
      expect(nzbFeedModule.resolveQualityTier('144')).toBe(360);
    });

    it('caps a value above the largest tier at 2160', () => {
      expect(nzbFeedModule.resolveQualityTier('4320')).toBe(2160);
    });

    it('trims whitespace', () => {
      expect(nzbFeedModule.resolveQualityTier(' 720 ')).toBe(720);
    });

    it.each([undefined, null, '', 'garbage', '-5', '0'])('defaults %p to 1080', (quality) => {
      expect(nzbFeedModule.resolveQualityTier(quality)).toBe(1080);
    });
  });

  describe('resolveEffectiveHeightTier', () => {
    it('uses the exact known height when it is lower than the configured tier', () => {
      expect(nzbFeedModule.resolveEffectiveHeightTier(1080, { actualHeightTier: 720 })).toBe(720);
    });

    it('never exceeds the configured tier', () => {
      expect(nzbFeedModule.resolveEffectiveHeightTier(720, { actualHeightTier: 2160 })).toBe(720);
    });

    it('prefers the exact height over the coarse definition flag', () => {
      expect(nzbFeedModule.resolveEffectiveHeightTier(1080, { actualHeightTier: 1080, definition: 'sd' })).toBe(1080);
    });

    it('caps a known SD result at 480', () => {
      expect(nzbFeedModule.resolveEffectiveHeightTier(1080, { definition: 'sd' })).toBe(480);
    });

    it('leaves an HD result at the configured tier', () => {
      expect(nzbFeedModule.resolveEffectiveHeightTier(1080, { definition: 'hd' })).toBe(1080);
    });

    it.each([null, undefined, {}, { actualHeightTier: 0 }, { actualHeightTier: 'x' }])('falls back to the configured tier for %p', (result) => {
      expect(nzbFeedModule.resolveEffectiveHeightTier(1080, result)).toBe(1080);
    });
  });

  describe('buildCapsXml', () => {
    it('is a caps document identifying the server', () => {
      const xml = nzbFeedModule.buildCapsXml();

      expect(xml).toContain('<caps>');
      expect(xml).toContain('<server title="Youtarr Turbo"');
    });

    it('advertises search, tv-search and movie-search', () => {
      const xml = nzbFeedModule.buildCapsXml();

      expect(xml).toContain('<search available="yes"');
      expect(xml).toContain('<tv-search available="yes"');
      expect(xml).toContain('<movie-search available="yes"');
    });

    it('includes the base Other, Movies and TV categories', () => {
      const xml = nzbFeedModule.buildCapsXml();

      expect(xml).toContain('<category id="0" name="Other">');
      expect(xml).toContain('<category id="2000" name="Movies">');
      expect(xml).toContain('<category id="5000" name="TV">');
    });

    it('includes the standard subcategories', () => {
      const xml = nzbFeedModule.buildCapsXml();

      expect(xml).toContain('<subcat id="2040" name="HD"/>');
      expect(xml).toContain('<subcat id="5040" name="HD"/>');
    });

    it('adds a configured category with a non-standard id under its parent', () => {
      const xml = nzbFeedModule.buildCapsXml([{ name: 'Documentaries', newznabCategoryIds: ['5045'] }]);

      expect(xml).toContain('<subcat id="5045" name="Documentaries"/>');
    });

    it('does not duplicate an id already in the base tree', () => {
      const xml = nzbFeedModule.buildCapsXml([{ name: 'Mine', newznabCategoryIds: ['5040'] }]);

      expect(xml).not.toContain('name="Mine"');
    });

    it('drops an id whose parent category is not in the base tree', () => {
      const xml = nzbFeedModule.buildCapsXml([{ name: 'Odd', newznabCategoryIds: ['77'] }]);

      expect(xml).not.toContain('<category id="77"');
    });

    it('ignores empty ids and categories without any', () => {
      expect(() => nzbFeedModule.buildCapsXml([{ name: 'None' }, { name: 'Blank', newznabCategoryIds: ['', null] }])).not.toThrow();
    });

    it('escapes category names', () => {
      const xml = nzbFeedModule.buildCapsXml([{ name: 'A & B <x>', newznabCategoryIds: ['5045'] }]);

      expect(xml).toContain('name="A &amp; B &lt;x&gt;"');
    });
  });

  describe('buildSearchXml', () => {
    const result = { youtubeId: 'abc123DEF45', title: 'A & B', duration: 600, publishedAt: '2026-03-01T12:00:00Z' };

    it('wraps items in an RSS channel with the newznab namespace', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      expect(xml).toContain('<rss version="2.0" xmlns:newznab=');
      expect(xml).toContain('<channel>');
    });

    it('produces an empty channel for no results', () => {
      const xml = nzbFeedModule.buildSearchXml([], baseOpts);

      expect(xml).not.toContain('<item>');
    });

    it('uses the watch URL as the guid', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      expect(xml).toContain('<guid isPermaLink="false">https://www.youtube.com/watch?v=abc123DEF45</guid>');
    });

    it('escapes the title and appends the quality label', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      expect(xml).toContain('<title>A &amp; B [1080p]</title>');
    });

    it('passes the size estimate on in the download link', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);
      const size = xml.match(/<size>(\d+)<\/size>/)[1];

      expect(xml).toContain(`&amp;size=${size}`);
    });

    it('falls back to the video id when there is no title', () => {
      const xml = nzbFeedModule.buildSearchXml([{ youtubeId: 'abc123DEF45' }], baseOpts);

      expect(xml).toContain('<title>abc123DEF45 [1080p]</title>');
    });

    it('builds an encoded download link carrying the api key', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      expect(xml).toContain('http://localhost:3011/nzb/download/My%20Category/abc123DEF45.nzb?title=A%20%26%20B&amp;apikey=key%26secret');
    });

    it('passes season and episode through to the download link when both are set', () => {
      const xml = nzbFeedModule.buildSearchXml([result], { ...baseOpts, season: 2, ep: 5 });

      expect(xml).toContain('&amp;season=2&amp;ep=5');
    });

    it.each([{ season: 2 }, { ep: 5 }])('omits season and episode unless both are set (%p)', (extra) => {
      const xml = nzbFeedModule.buildSearchXml([result], { ...baseOpts, ...extra });

      expect(xml).not.toContain('season=');
    });

    it('formats the publish date as an RFC 822 string', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      expect(xml).toContain('<pubDate>Sun, 01 Mar 2026 12:00:00 GMT</pubDate>');
    });

    it('uses a valid date when the published date is unusable', () => {
      const xml = nzbFeedModule.buildSearchXml([{ ...result, publishedAt: 'not a date' }], baseOpts);

      expect(xml).toMatch(/<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} /);
    });

    it('uses the flat placeholder size when the duration is unknown', () => {
      const xml = nzbFeedModule.buildSearchXml([{ youtubeId: 'abc123DEF45' }], baseOpts);

      expect(xml).toContain('<size>2147483648</size>');
    });

    it('estimates size from duration and tier', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      // (5000 + 192) kbps * 1000 * 600s / 8
      expect(xml).toContain(`<size>${Math.ceil((5192 * 1000 * 600) / 8)}</size>`);
    });

    it('lists every category id as an attribute and uses the first as the primary category', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      expect(xml).toContain('<category>5040</category>');
      expect(xml).toContain('<newznab:attr name="category" value="5040"/>');
      expect(xml).toContain('<newznab:attr name="category" value="5000"/>');
    });

    it('emits an empty category when none are configured', () => {
      const xml = nzbFeedModule.buildSearchXml([result], { ...baseOpts, newznabCategoryIds: [] });

      expect(xml).toContain('<category></category>');
    });

    it('describes the enclosure as an nzb', () => {
      const xml = nzbFeedModule.buildSearchXml([result], baseOpts);

      expect(xml).toContain('type="application/x-nzb"');
    });

    it('emits one item per result', () => {
      const xml = nzbFeedModule.buildSearchXml([result, { ...result, youtubeId: 'zzzzzzzzzzz' }], baseOpts);

      expect(xml.match(/<item>/g)).toHaveLength(2);
    });
  });

  describe('buildNzbXml', () => {
    const input = { youtubeId: 'abc123DEF45', categoryName: 'Cat', title: 'My <Video>' };

    it('is an NZB document', () => {
      const xml = nzbFeedModule.buildNzbXml(input);

      expect(xml).toContain('<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">');
    });

    it('carries the video id and category as meta tags', () => {
      const xml = nzbFeedModule.buildNzbXml(input);

      expect(xml).toContain('<meta type="youtubeId">abc123DEF45</meta>');
      expect(xml).toContain('<meta type="category">Cat</meta>');
    });

    it('escapes the title and suffixes it with the bracketed id', () => {
      const xml = nzbFeedModule.buildNzbXml(input);

      expect(xml).toContain('<meta type="title">My &lt;Video&gt; [abc123DEF45]</meta>');
    });

    it('titles the file after the id when there is no title', () => {
      const xml = nzbFeedModule.buildNzbXml({ youtubeId: 'abc123DEF45', categoryName: 'Cat' });

      expect(xml).toContain('abc123DEF45 [abc123DEF45]');
    });

    it('encodes the id and category in a fake segment message-id', () => {
      const xml = nzbFeedModule.buildNzbXml(input);

      expect(xml).toContain('>abc123DEF45@Cat.youtarr.local</segment>');
    });

    it('includes season and episode only when both are given', () => {
      const withBoth = nzbFeedModule.buildNzbXml({ ...input, season: 3, ep: 7 });
      const seasonOnly = nzbFeedModule.buildNzbXml({ ...input, season: 3 });

      expect(withBoth).toContain('<meta type="season">3</meta>');
      expect(withBoth).toContain('<meta type="episode">7</meta>');
      expect(seasonOnly).not.toContain('type="season"');
    });

    it('includes the size estimate only when given', () => {
      expect(nzbFeedModule.buildNzbXml({ ...input, size: 5000 })).toContain('<meta type="size">5000</meta>');
      expect(nzbFeedModule.buildNzbXml(input)).not.toContain('type="size"');
    });
  });

  describe('parseNzbXml', () => {
    const roundTrip = (input) => nzbFeedModule.parseNzbXml(nzbFeedModule.buildNzbXml(input));

    it('recovers the video id and category from a file Youtarr wrote', () => {
      expect(roundTrip({ youtubeId: 'abc123DEF45', categoryName: 'Cat', title: 'T' })).toMatchObject({
        youtubeId: 'abc123DEF45',
        categoryName: 'Cat',
      });
    });

    it('recovers the release name', () => {
      expect(roundTrip({ youtubeId: 'abc123DEF45', categoryName: 'Cat', title: 'My Video' }).nzbName).toBe('My Video [abc123DEF45]');
    });

    it('recovers the size estimate as a number', () => {
      expect(roundTrip({ youtubeId: 'abc123DEF45', categoryName: 'Cat', size: 5000 }).size).toBe(5000);
    });

    it('has no size when the file carries none', () => {
      expect(roundTrip({ youtubeId: 'abc123DEF45', categoryName: 'Cat' }).size).toBeNull();
    });

    it('recovers season and episode as numbers', () => {
      expect(roundTrip({ youtubeId: 'abc123DEF45', categoryName: 'Cat', season: 4, ep: 12 })).toMatchObject({ season: 4, ep: 12 });
    });

    it('reports null season and episode when absent', () => {
      expect(roundTrip({ youtubeId: 'abc123DEF45', categoryName: 'Cat' })).toMatchObject({ season: null, ep: null });
    });

    it('reports null for a non-numeric season', () => {
      const xml = '<meta type="youtubeId">abc123DEF45</meta><meta type="season">x</meta>';

      expect(nzbFeedModule.parseNzbXml(xml).season).toBeNull();
    });

    it('accepts a Buffer', () => {
      const buffer = Buffer.from(nzbFeedModule.buildNzbXml({ youtubeId: 'abc123DEF45', categoryName: 'Cat' }));

      expect(nzbFeedModule.parseNzbXml(buffer).youtubeId).toBe('abc123DEF45');
    });

    it('matches meta tags case-insensitively and with single quotes', () => {
      expect(nzbFeedModule.parseNzbXml('<META TYPE=\'youtubeId\'>abc123DEF45</META>').youtubeId).toBe('abc123DEF45');
    });

    it('falls back to the bracketed id at the end of the title when a client strips the meta tag', () => {
      const xml = '<head><meta type="title">Some Video [abc123DEF45]</meta></head>';

      expect(nzbFeedModule.parseNzbXml(xml).youtubeId).toBe('abc123DEF45');
    });

    it('falls back to a plain <title> element', () => {
      expect(nzbFeedModule.parseNzbXml('<title>Video [abc123DEF45]</title>').youtubeId).toBe('abc123DEF45');
    });

    it('falls back to the fake segment id for both id and category', () => {
      const xml = '<segment bytes="1" number="1">abc123DEF45@Cat.youtarr.local</segment>';

      expect(nzbFeedModule.parseNzbXml(xml)).toMatchObject({ youtubeId: 'abc123DEF45', categoryName: 'Cat' });
    });

    it('prefers meta values over the segment fallback', () => {
      const xml = '<meta type="youtubeId">metaId12345</meta><meta type="category">MetaCat</meta>'
        + '<segment>segId123456@SegCat.youtarr.local</segment>';

      expect(nzbFeedModule.parseNzbXml(xml)).toMatchObject({ youtubeId: 'metaId12345', categoryName: 'MetaCat' });
    });

    it('fills a missing category from the segment while keeping the meta id', () => {
      const xml = '<meta type="youtubeId">metaId12345</meta><segment>segId123456@SegCat.youtarr.local</segment>';

      expect(nzbFeedModule.parseNzbXml(xml)).toMatchObject({ youtubeId: 'metaId12345', categoryName: 'SegCat' });
    });

    it('returns nulls and warns when nothing can be recovered', () => {
      expect(nzbFeedModule.parseNzbXml('<nzb></nzb>')).toEqual({ youtubeId: null, categoryName: null, nzbName: null, season: null, ep: null, size: null });
      expect(logger.warn).toHaveBeenCalled();
    });

    it.each([undefined, null, ''])('does not throw for %p input', (input) => {
      expect(nzbFeedModule.parseNzbXml(input).youtubeId).toBeNull();
    });
  });
});
