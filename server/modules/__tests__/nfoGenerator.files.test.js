/* eslint-env jest */

jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const logger = require('../../logger');
const ratingMapper = require('../ratingMapper');
const nfoGenerator = require('../nfoGenerator');

// Real files in a temp dir (rather than a mocked fs) so these tests do not
// depend on path separators and also exercise the real read/patch/write flow.
describe('nfoGenerator file output', () => {
  let dir;

  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');

  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfo-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const formats = (...heights) => heights.map((h) => ({ vcodec: 'avc1', height: h, width: Math.round(h * 16 / 9), format_note: `${h}p` }));

  describe('buildAvailableResolutionsTag', () => {
    it('summarizes the distinct tiers in ascending order', () => {
      expect(nfoGenerator.buildAvailableResolutionsTag({ formats: formats(1080, 480, 720, 720) })).toBe('Available: 480p/720p/1080p');
    });

    it('returns null without a format list', () => {
      expect(nfoGenerator.buildAvailableResolutionsTag({})).toBeNull();
    });

    it('returns null when no format is a video format', () => {
      expect(nfoGenerator.buildAvailableResolutionsTag({ formats: [{ vcodec: 'none', height: 720 }] })).toBeNull();
    });
  });

  describe('patchExistingNfoWithResolutionTag', () => {
    const nfoPath = () => path.join(dir, 'video.nfo');
    const info = { formats: formats(720, 1080) };

    it('returns false without touching the file when no tag can be computed', async () => {
      fs.writeFileSync(nfoPath(), '<movie>\n</movie>\n');

      await expect(nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), {})).resolves.toBe(false);

      expect(read('video.nfo')).toBe('<movie>\n</movie>\n');
    });

    it('returns false when the file does not exist', async () => {
      await expect(nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info)).resolves.toBe(false);
    });

    it('inserts the tag after the last existing tag or genre line', async () => {
      fs.writeFileSync(nfoPath(), '<movie>\n  <genre>Music</genre>\n  <tag>a</tag>\n  <runtime>3</runtime>\n</movie>\n');

      const changed = await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info);

      expect(changed).toBe(true);
      expect(read('video.nfo')).toBe('<movie>\n  <genre>Music</genre>\n  <tag>a</tag>\n  <tag>Available: 720p/1080p</tag>\n  <runtime>3</runtime>\n</movie>\n');
    });

    it('inserts before the closing movie element when there are no classification lines', async () => {
      fs.writeFileSync(nfoPath(), '<movie>\n  <title>T</title>\n</movie>\n');

      await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info);

      expect(read('video.nfo')).toBe('<movie>\n  <title>T</title>\n  <tag>Available: 720p/1080p</tag>\n</movie>\n');
    });

    it('inserts before the closing episodedetails element', async () => {
      fs.writeFileSync(nfoPath(), '<episodedetails>\n  <title>T</title>\n</episodedetails>\n');

      await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info);

      expect(read('video.nfo')).toContain('  <tag>Available: 720p/1080p</tag>\n</episodedetails>');
    });

    it('is a no-op when the tag is already present', async () => {
      const original = '<movie>\n  <tag>Available: 720p/1080p</tag>\n</movie>\n';
      fs.writeFileSync(nfoPath(), original);

      await expect(nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info)).resolves.toBe(false);

      expect(read('video.nfo')).toBe(original);
    });

    it('replaces an earlier resolution tag when the available tiers have changed', async () => {
      fs.writeFileSync(nfoPath(), '<movie>\n  <tag>a</tag>\n  <tag>Available: 480p</tag>\n  <tag>b</tag>\n</movie>\n');

      const changed = await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info);

      expect(changed).toBe(true);
      expect(read('video.nfo')).toBe('<movie>\n  <tag>a</tag>\n  <tag>Available: 720p/1080p</tag>\n  <tag>b</tag>\n</movie>\n');
    });

    it('does not accumulate resolution tags over repeated changes', async () => {
      fs.writeFileSync(nfoPath(), '<movie>\n  <tag>a</tag>\n</movie>\n');

      await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), { formats: formats(480) });
      await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info);

      expect(read('video.nfo').match(/Available:/g)).toHaveLength(1);
    });

    it('leaves a file with an unrecognized root untouched', async () => {
      const original = '<tvshow>\n  <title>T</title>\n</tvshow>\n';
      fs.writeFileSync(nfoPath(), original);

      await expect(nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info)).resolves.toBe(false);

      expect(read('video.nfo')).toBe(original);
    });

    it('patches an NFO produced by writeVideoNfoFile and then leaves it alone', async () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'video.mp4'), { id: 'abc', title: 'T', tags: ['x'] });

      const first = await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info);
      const second = await nfoGenerator.patchExistingNfoWithResolutionTag(nfoPath(), info);

      expect([first, second]).toEqual([true, false]);
      expect(read('video.nfo')).toContain('<tag>x</tag>\n  <tag>Available: 720p/1080p</tag>');
    });
  });

  describe('ratings block', () => {
    it('is omitted without a normalized rating', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a' });

      expect(read('v.nfo')).not.toContain('<mpaa>');
    });

    it('includes the display code and the numeric value', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', normalized_rating: 'PG' });

      const xml = read('v.nfo');
      expect(xml).toContain('<mpaa>PG</mpaa>');
      expect(xml).toContain(`<rating name="mpaa" max="10" default="true">\n      <value>${ratingMapper.mapToNumericRating('PG')}</value>`);
    });

    it('falls back to the display code when there is no numeric mapping', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', normalized_rating: 'ZZ-UNMAPPED' });

      expect(read('v.nfo')).toContain('<value>ZZ-UNMAPPED</value>');
    });

    it('includes the rating source when present', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', normalized_rating: 'PG', rating_source: 'Manual Override' });

      expect(read('v.nfo')).toContain('<rating name="source">\n      <value>Manual Override</value>');
    });

    it('omits the source rating when there is none', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', normalized_rating: 'PG' });

      expect(read('v.nfo')).not.toContain('name="source"');
    });

    it('escapes the rating values', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', normalized_rating: 'A&B', rating_source: '<src>' });

      const xml = read('v.nfo');
      expect(xml).toContain('<mpaa>A&amp;B</mpaa>');
      expect(xml).toContain('<value>&lt;src&gt;</value>');
    });
  });

  describe('writeVideoNfoFile resolution details', () => {
    it('writes the resolution tag alongside the video tags', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', tags: ['music'], formats: formats(480, 720) });

      expect(read('v.nfo')).toContain('  <tag>music</tag>\n  <tag>Available: 480p/720p</tag>\n');
    });

    it('writes width, height and aspect inside the video stream details', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', duration: 100, width: 1920, height: 1080, aspect_ratio: 1.78 });

      const xml = read('v.nfo');
      expect(xml).toContain('<durationinseconds>100</durationinseconds>');
      expect(xml).toContain('<width>1920</width>');
      expect(xml).toContain('<height>1080</height>');
      expect(xml).toContain('<aspect>1.78</aspect>');
    });

    it('omits dimensions that yt-dlp did not report', () => {
      nfoGenerator.writeVideoNfoFile(path.join(dir, 'v.mp4'), { id: 'a', duration: 100 });

      const xml = read('v.nfo');
      expect(xml).not.toContain('<width>');
      expect(xml).not.toContain('<aspect>');
    });
  });

  describe('writeEpisodeNfoFile', () => {
    const write = (info = {}, opts = {}) => nfoGenerator.writeEpisodeNfoFile(path.join(dir, 'ep.mp4'), info, { season: 2024, episode: 7, showTitle: 'My Show', ...opts });

    it('writes an episodedetails document next to the video', () => {
      expect(write({ id: 'abc', title: 'Ep' })).toBe(true);

      const xml = read('ep.nfo');
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<episodedetails>\n')).toBe(true);
      expect(xml.endsWith('</episodedetails>\n')).toBe(true);
    });

    it('writes title, show title, season and episode', () => {
      write({ id: 'abc', title: 'Ep' });

      const xml = read('ep.nfo');
      expect(xml).toContain('<title>Ep</title>');
      expect(xml).toContain('<showtitle>My Show</showtitle>');
      expect(xml).toContain('<season>2024</season>');
      expect(xml).toContain('<episode>7</episode>');
    });

    it('locks the metadata against remote providers', () => {
      write({ id: 'abc' });

      expect(read('ep.nfo')).toContain('<lockdata>true</lockdata>');
    });

    it('falls back to the studio when there is no show title', () => {
      write({ id: 'abc', uploader: 'The Channel' }, { showTitle: undefined });

      expect(read('ep.nfo')).toContain('<showtitle>The Channel</showtitle>');
    });

    it('escapes the show title', () => {
      write({ id: 'abc' }, { showTitle: 'A & B' });

      expect(read('ep.nfo')).toContain('<showtitle>A &amp; B</showtitle>');
    });

    it('writes the ids, dates and trailer when the video has them', () => {
      write({ id: 'abc', upload_date: '20240315' });

      const xml = read('ep.nfo');
      expect(xml).toContain('<uniqueid type="youtube" default="true">abc</uniqueid>');
      expect(xml).toContain('<youtubeid>abc</youtubeid>');
      expect(xml).toContain('<aired>2024-03-15</aired>');
      expect(xml).toContain('<premiered>2024-03-15</premiered>');
      expect(xml).toContain('<year>2024</year>');
      expect(xml).toContain(`<trailer>${nfoGenerator.buildYouTubeTrailerUrl('abc')}</trailer>`);
    });

    it('omits ids, dates and trailer when the video has none', () => {
      write({ title: 'No ids' });

      const xml = read('ep.nfo');
      expect(xml).not.toContain('<uniqueid');
      expect(xml).not.toContain('<aired>');
      expect(xml).not.toContain('<year>');
      expect(xml).not.toContain('<trailer>');
    });

    it('writes plot, credits, genres and tags when present', () => {
      write({ id: 'abc', description: 'About it', uploader: 'Up', categories: ['Music'], tags: ['a'] });

      const xml = read('ep.nfo');
      expect(xml).toContain('<plot>About it</plot>');
      expect(xml).toContain('<credits>Up</credits>');
      expect(xml).toContain('<genre>Music</genre>');
      expect(xml).toContain('<tag>a</tag>');
    });

    it('omits plot, credits and classification when absent', () => {
      write({ id: 'abc' });

      const xml = read('ep.nfo');
      expect(xml).not.toContain('<plot>');
      expect(xml).not.toContain('<credits>');
      expect(xml).not.toContain('<genre>');
      expect(xml).not.toContain('<!-- Classification -->');
    });

    it('includes the ratings block', () => {
      write({ id: 'abc', normalized_rating: 'PG', rating_source: 'Channel Default' });

      const xml = read('ep.nfo');
      expect(xml).toContain('<mpaa>PG</mpaa>');
      expect(xml).toContain('<value>Channel Default</value>');
    });

    it('writes runtime and stream details for a video with a duration', () => {
      write({ id: 'abc', duration: 125, width: 1280, height: 720, aspect_ratio: 1.78 });

      const xml = read('ep.nfo');
      expect(xml).toContain('<runtime>3</runtime>');
      expect(xml).toContain('<durationinseconds>125</durationinseconds>');
      expect(xml).toContain('<width>1280</width>');
      expect(xml).toContain('<height>720</height>');
      expect(xml).toContain('<aspect>1.78</aspect>');
    });

    it('omits runtime and stream details without a duration', () => {
      write({ id: 'abc' });

      expect(read('ep.nfo')).not.toContain('<runtime>');
    });

    it('omits dimensions that were not reported', () => {
      write({ id: 'abc', duration: 60 });

      const xml = read('ep.nfo');
      expect(xml).not.toContain('<width>');
      expect(xml).not.toContain('<height>');
      expect(xml).not.toContain('<aspect>');
    });

    it('points the thumb at the video\'s jpg', () => {
      write({ id: 'abc' });

      expect(read('ep.nfo')).toContain('<thumb>ep.jpg</thumb>');
    });

    it('escapes XML special characters in the thumb filename', () => {
      nfoGenerator.writeEpisodeNfoFile(path.join(dir, 'Tom & Jerry.mp4'), { id: 'abc' }, { season: 2024, episode: 7, showTitle: 'My Show' });

      expect(read('Tom & Jerry.nfo')).toContain('<thumb>Tom &amp; Jerry.jpg</thumb>');
    });

    it('includes the resolution tag', () => {
      write({ id: 'abc', formats: formats(720) });

      expect(read('ep.nfo')).toContain('<tag>Available: 720p</tag>');
    });

    it('returns false and logs when the file cannot be written', () => {
      const result = nfoGenerator.writeEpisodeNfoFile(path.join(dir, 'missing-dir', 'ep.mp4'), { id: 'abc' }, { season: 1, episode: 1, showTitle: 'S' });

      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.objectContaining({ code: 'ENOENT' }) }), 'Error creating episode NFO file');
    });
  });

  describe('writeShowNfoFile', () => {
    it('writes a tvshow.nfo with title, plot and channel id', () => {
      expect(nfoGenerator.writeShowNfoFile(dir, { title: 'Chan', plot: 'About', channelId: 'UC123' })).toBe(true);

      const xml = read('tvshow.nfo');
      expect(xml).toContain('<tvshow>');
      expect(xml).toContain('<title>Chan</title>');
      expect(xml).toContain('<plot>About</plot>');
      expect(xml).toContain('<uniqueid type="youtube" default="true">UC123</uniqueid>');
      expect(xml).toContain('<thumb aspect="poster">poster.jpg</thumb>');
    });

    it('uses a placeholder title and omits missing plot and id', () => {
      nfoGenerator.writeShowNfoFile(dir, {});

      const xml = read('tvshow.nfo');
      expect(xml).toContain('<title>Unknown Channel</title>');
      expect(xml).not.toContain('<plot>');
      expect(xml).not.toContain('<uniqueid');
    });

    it('escapes the title, plot and channel id', () => {
      nfoGenerator.writeShowNfoFile(dir, { title: 'A & B', plot: '<p>', channelId: 'U"C' });

      const xml = read('tvshow.nfo');
      expect(xml).toContain('<title>A &amp; B</title>');
      expect(xml).toContain('<plot>&lt;p&gt;</plot>');
      expect(xml).toContain('>U&quot;C<');
    });

    it('overwrites an earlier file so repeated calls are idempotent', () => {
      nfoGenerator.writeShowNfoFile(dir, { title: 'First' });
      nfoGenerator.writeShowNfoFile(dir, { title: 'Second' });

      expect(read('tvshow.nfo')).toContain('<title>Second</title>');
    });

    it('returns false and logs when the folder does not exist', () => {
      const missing = path.join(dir, 'nope');

      expect(nfoGenerator.writeShowNfoFile(missing, { title: 'X' })).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ channelFolderPath: missing }), 'Error creating tvshow.nfo');
    });
  });

  describe('writeSeasonNfoFile', () => {
    it('writes a season.nfo with title, show title and season number', () => {
      expect(nfoGenerator.writeSeasonNfoFile(dir, { showTitle: 'Chan', season: 2024 })).toBe(true);

      const xml = read('season.nfo');
      expect(xml).toContain('<season>');
      expect(xml).toContain('<title>Season 2024</title>');
      expect(xml).toContain('<showtitle>Chan</showtitle>');
      expect(xml).toContain('<seasonnumber>2024</seasonnumber>');
    });

    it('writes an empty show title when none is given', () => {
      nfoGenerator.writeSeasonNfoFile(dir, { season: 1 });

      expect(read('season.nfo')).toContain('<showtitle></showtitle>');
    });

    it('escapes the show title', () => {
      nfoGenerator.writeSeasonNfoFile(dir, { showTitle: 'A & B', season: 1 });

      expect(read('season.nfo')).toContain('<showtitle>A &amp; B</showtitle>');
    });

    it('returns false and logs when the folder does not exist', () => {
      const missing = path.join(dir, 'nope');

      expect(nfoGenerator.writeSeasonNfoFile(missing, { showTitle: 'X', season: 1 })).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ seasonFolderPath: missing }), 'Error creating season.nfo');
    });
  });
});
