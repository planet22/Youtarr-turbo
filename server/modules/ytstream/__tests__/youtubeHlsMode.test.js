/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));
jest.mock('../../ytDlpRunner', () => ({ fetchMetadata: jest.fn() }));

const mockStreams = new Map();
jest.mock('../activeStreams', () => ({
  trackStream: jest.fn((entry) => { mockStreams.set(entry.streamId, entry); }),
  untrackStream: jest.fn((streamId) => { mockStreams.delete(streamId); }),
  failStreamThenUntrack: jest.fn((streamId) => { mockStreams.delete(streamId); }),
  getStream: jest.fn((streamId) => mockStreams.get(streamId)),
}));

const activeStreams = require('../activeStreams');
const {
  handleYoutubeHlsRequest,
  resolvePlaylist,
  getPlaylist,
  pickManifestUrl,
  parseMasterPlaylist,
  parseAttributes,
  chooseVariant,
  buildFilteredMaster,
  chooseRendition,
  describeRun,
  absolutizeMediaPlaylist,
  playlistDurationSeconds,
  buildStreamId,
  clearPlaylistCache,
} = require('../youtubeHlsMode');

const MASTER_URL = 'https://manifest.googlevideo.com/api/manifest/hls_variant/id/abc/index.m3u8';

const muxedMaster = [
  '#EXTM3U',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30',
  'https://manifest.googlevideo.com/api/manifest/hls_playlist/360/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2500000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30',
  'https://manifest.googlevideo.com/api/manifest/hls_playlist/720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30',
  'https://manifest.googlevideo.com/api/manifest/hls_playlist/1080/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=4600000,CODECS="vp09.00.40.08,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30',
  'https://manifest.googlevideo.com/api/manifest/hls_playlist/1080vp9/index.m3u8',
].join('\n');

const separateAudioMaster = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",NAME="Other",URI="audio/other.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="aud1"',
  'video/1080.m3u8',
].join('\n');

const vodMedia = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-TARGETDURATION:5',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:5.005,',
  'seg0.ts',
  '#EXTINF:5.005,',
  'seg1.ts',
  '#EXTINF:2.500,',
  'seg2.ts',
  '#EXT-X-ENDLIST',
].join('\n');

const infoWithManifest = { formats: [{ url: 'x', protocol: 'https' }, { protocol: 'm3u8_native', manifest_url: MASTER_URL }] };

const fakeDeps = (overrides = {}) => ({
  fetchInfo: jest.fn().mockResolvedValue(infoWithManifest),
  fetchText: jest.fn(async (url) => (url === MASTER_URL ? muxedMaster : vodMedia)),
  ...overrides,
});

describe('youtubeHlsMode helpers', () => {
  describe('parseAttributes', () => {
    it('keeps a quoted value containing commas whole', () => {
      expect(parseAttributes('BANDWIDTH=100,CODECS="avc1.4d,mp4a.40.2",RESOLUTION=640x360').CODECS).toBe('avc1.4d,mp4a.40.2');
    });

    it('reads unquoted values', () => {
      expect(parseAttributes('BANDWIDTH=100,RESOLUTION=640x360').RESOLUTION).toBe('640x360');
    });
  });

  describe('pickManifestUrl', () => {
    it('returns the manifest_url of the first HLS format', () => {
      expect(pickManifestUrl(infoWithManifest)).toBe(MASTER_URL);
    });

    it('returns null when no format offers a manifest', () => {
      expect(pickManifestUrl({ formats: [{ url: 'x' }] })).toBeNull();
    });

    it('returns null for missing info', () => {
      expect(pickManifestUrl(null)).toBeNull();
    });
  });

  describe('parseMasterPlaylist', () => {
    it('finds every variant with its height', () => {
      expect(parseMasterPlaylist(muxedMaster).variants.map((v) => v.height)).toEqual([360, 720, 1080, 1080]);
    });

    it('keeps the variant URI that follows each STREAM-INF line', () => {
      expect(parseMasterPlaylist(muxedMaster).variants[0].uri).toContain('/360/');
    });

    it('collects the EXT-X-MEDIA renditions', () => {
      expect(parseMasterPlaylist(separateAudioMaster).media).toHaveLength(2);
    });

    it('reports no variants for a plain media playlist', () => {
      expect(parseMasterPlaylist(vodMedia).variants).toEqual([]);
    });
  });

  describe('chooseVariant', () => {
    const variants = parseMasterPlaylist(muxedMaster).variants;

    it('takes the tallest variant at or under the target', () => {
      expect(chooseVariant(variants, 720, 'fallback').height).toBe(720);
    });

    it('prefers H.264 over another codec at the same height', () => {
      expect(chooseVariant(variants, 1080, 'fallback').attrs.CODECS).toMatch(/avc1/);
    });

    it('takes the best available when there is no cap', () => {
      expect(chooseVariant(variants, null, 'fallback').height).toBe(1080);
    });

    it('falls back to the shortest variant above the target when none fits under it', () => {
      expect(chooseVariant(variants, 240, 'fallback').height).toBe(360);
    });

    it('gives up in fixed mode when nothing fits under the target', () => {
      expect(chooseVariant(variants, 240, 'fixed')).toBeNull();
    });

    it('returns null when there are no usable variants', () => {
      expect(chooseVariant([], 720, 'fallback')).toBeNull();
    });
  });

  describe('chooseRendition', () => {
    const rendition = (attrs) => ({
      line: `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(',')}`,
      attrs: { TYPE: 'AUDIO', 'GROUP-ID': '234', ...attrs },
    });
    const dubs = [
      rendition({ NAME: 'Bengali', LANGUAGE: 'bn', DEFAULT: 'NO' }),
      rendition({ NAME: 'Spanish (United States)', LANGUAGE: 'es-US', DEFAULT: 'NO' }),
      rendition({ NAME: 'English (United States) original', LANGUAGE: 'en-US', DEFAULT: 'NO' }),
    ];

    it('prefers the rendition marked original', () => {
      expect(chooseRendition(dubs, null).item.attrs.LANGUAGE).toBe('en-US');
    });

    it('prefers original over a DEFAULT=YES dub', () => {
      const withDefaultDub = [rendition({ NAME: 'Hindi', LANGUAGE: 'hi', DEFAULT: 'YES' }), dubs[2]];
      expect(chooseRendition(withDefaultDub, null).item.attrs.LANGUAGE).toBe('en-US');
    });

    it('recognises an original tag outside the name', () => {
      const tagged = [dubs[0], rendition({ NAME: 'English', LANGUAGE: 'en-US', 'YT-EXT-XTAGS': 'acont=original:lang=en-US' })];
      expect(chooseRendition(tagged, null).item.attrs.NAME).toBe('English');
    });

    it('uses the video language when nothing is marked original', () => {
      const plain = [dubs[0], dubs[1], rendition({ NAME: 'English', LANGUAGE: 'en-US', DEFAULT: 'NO' })];
      expect(chooseRendition(plain, 'en').item.attrs.LANGUAGE).toBe('en-US');
    });

    it('matches the video language across regions', () => {
      const plain = [dubs[0], rendition({ NAME: 'Portuguese', LANGUAGE: 'pt-BR', DEFAULT: 'NO' })];
      expect(chooseRendition(plain, 'pt').item.attrs.LANGUAGE).toBe('pt-BR');
    });

    it('falls back to DEFAULT=YES when the language is unknown', () => {
      const plain = [dubs[0], rendition({ NAME: 'Hindi', LANGUAGE: 'hi', DEFAULT: 'YES' })];
      expect(chooseRendition(plain, null).item.attrs.LANGUAGE).toBe('hi');
    });

    it('falls back to the first rendition as a last resort', () => {
      expect(chooseRendition([dubs[0], dubs[1]], null).item.attrs.LANGUAGE).toBe('bn');
    });

    it('honours the language the user asked for over the original', () => {
      const result = chooseRendition(dubs, 'en', 'es');
      expect([result.item.attrs.LANGUAGE, result.reason]).toEqual(['es-US', 'requested language es']);
    });

    it('prefers the original among several renditions in the requested language', () => {
      const twoEnglish = [rendition({ NAME: 'English dubbed-auto', LANGUAGE: 'en', DEFAULT: 'NO' }), rendition({ NAME: 'English - original', LANGUAGE: 'en-US', DEFAULT: 'NO' })];
      expect(chooseRendition(twoEnglish, null, 'en').item.attrs.NAME).toBe('English - original');
    });

    it('falls back to the normal choice when the requested language is not offered', () => {
      expect(chooseRendition(dubs, 'en', 'ja').reason).toBe('marked original');
    });

    it('reports why it chose', () => {
      expect(chooseRendition(dubs, null).reason).toBe('marked original');
    });

    it('returns null for an empty group', () => {
      expect(chooseRendition([], 'en')).toBeNull();
    });
  });

  describe('buildFilteredMaster audio renditions', () => {
    const build = (mediaLines) => {
      const master = ['#EXTM3U', ...mediaLines, '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720,AUDIO="234"', 'v.m3u8'].join('\n');
      const parsedMaster = parseMasterPlaylist(master);
      return buildFilteredMaster(parsedMaster, parsedMaster.variants[0], 'https://cdn.example.com/m.m3u8');
    };

    it('keeps only the default rendition of a group with several dubs', () => {
      const output = build([
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Spanish",LANGUAGE="es-US",DEFAULT=NO,URI="a/es.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="English",LANGUAGE="en-US",DEFAULT=YES,URI="a/en.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,URI="a/hi.m3u8"',
      ]);
      expect(output.match(/#EXT-X-MEDIA/g)).toHaveLength(1);
      expect(output).toContain('a/en.m3u8');
    });

    it('keeps the requested language when one is asked for', () => {
      const master = ['#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="German - dubbed-auto",LANGUAGE="de",DEFAULT=NO,URI="a/de.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="English - original",LANGUAGE="en-US",DEFAULT=NO,URI="a/en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720,AUDIO="234"', 'v.m3u8'].join('\n');
      const parsedMaster = parseMasterPlaylist(master);
      const output = buildFilteredMaster(parsedMaster, parsedMaster.variants[0], 'https://cdn.example.com/m.m3u8', { audioLanguage: 'en', preferredLanguage: 'de' });
      expect(output).toContain('a/de.m3u8');
    });

    it('keeps the rendition in the video language, not the first one listed', () => {
      const master = ['#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Bengali",LANGUAGE="bn",DEFAULT=NO,URI="a/bn.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="English",LANGUAGE="en-US",DEFAULT=NO,URI="a/en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720,AUDIO="234"', 'v.m3u8'].join('\n');
      const parsedMaster = parseMasterPlaylist(master);
      const output = buildFilteredMaster(parsedMaster, parsedMaster.variants[0], 'https://cdn.example.com/m.m3u8', { audioLanguage: 'en' });
      expect(output).toContain('a/en.m3u8');
      expect(output).not.toContain('a/bn.m3u8');
    });

    it('falls back to the first rendition and marks it default when none is', () => {
      const output = build([
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Spanish",DEFAULT=NO,URI="a/es.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Hindi",DEFAULT=NO,URI="a/hi.m3u8"',
      ]);
      expect(output).toContain('DEFAULT=YES');
      expect(output).toContain('a/es.m3u8');
      expect(output).not.toContain('a/hi.m3u8');
    });

    it('adds DEFAULT=YES when the fallback rendition has no DEFAULT attribute', () => {
      const output = build(['#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="Only",URI="a/only.m3u8"']);
      expect(output).toContain('URI="https://cdn.example.com/a/only.m3u8",DEFAULT=YES');
    });
  });

  describe('buildFilteredMaster subtitles', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="English",DEFAULT=YES,URI="a/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="vtt",NAME="English",URI="https://cdn.example.com/timedtext?fmt=vtt"',
      '#EXT-X-STREAM-INF:BANDWIDTH=4676912,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234",SUBTITLES="vtt"',
      'v/1080.m3u8',
    ].join('\n');
    const parsedMaster = parseMasterPlaylist(master);
    const output = buildFilteredMaster(parsedMaster, parsedMaster.variants[0], 'https://cdn.example.com/a/master.m3u8');

    it('leaves the subtitle rendition out', () => {
      expect(output).not.toContain('TYPE=SUBTITLES');
    });

    it('removes the subtitle group from the variant line', () => {
      expect(output).not.toContain('SUBTITLES=');
    });

    it('keeps the audio rendition and the audio group on the variant line', () => {
      expect(output).toContain('TYPE=AUDIO');
      expect(output).toContain('AUDIO="234"');
    });

    it('keeps the rest of the variant line intact', () => {
      expect(output).toContain('#EXT-X-STREAM-INF:BANDWIDTH=4676912,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234"\n');
    });

    it('removes a subtitle group written first in the attribute list', () => {
      const first = parseMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:SUBTITLES="vtt",BANDWIDTH=100,RESOLUTION=1280x720\nv.m3u8');
      expect(buildFilteredMaster(first, first.variants[0], 'https://cdn.example.com/m.m3u8')).toContain('#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720\n');
    });
  });

  describe('buildFilteredMaster', () => {
    const parsed = parseMasterPlaylist(separateAudioMaster);
    const output = buildFilteredMaster(parsed, parsed.variants[0], 'https://cdn.example.com/a/master.m3u8');

    it('keeps only the renditions the chosen variant references', () => {
      expect(output).toContain('GROUP-ID="aud1"');
      expect(output).not.toContain('GROUP-ID="other"');
    });

    it('makes the variant URI absolute', () => {
      expect(output).toContain('https://cdn.example.com/a/video/1080.m3u8');
    });

    it('makes the rendition URI absolute', () => {
      expect(output).toContain('URI="https://cdn.example.com/a/audio/en.m3u8"');
    });

    it('starts with the playlist header', () => {
      expect(output.startsWith('#EXTM3U')).toBe(true);
    });
  });

  describe('absolutizeMediaPlaylist', () => {
    const output = absolutizeMediaPlaylist(vodMedia, 'https://cdn.example.com/v/index.m3u8');

    it('makes segment URIs absolute', () => {
      expect(output).toContain('https://cdn.example.com/v/seg1.ts');
    });

    it('makes the init segment URI absolute', () => {
      expect(output).toContain('URI="https://cdn.example.com/v/init.mp4"');
    });

    it('keeps the ENDLIST tag', () => {
      expect(output).toContain('#EXT-X-ENDLIST');
    });
  });

  describe('playlistDurationSeconds', () => {
    it('sums the EXTINF durations', () => {
      expect(playlistDurationSeconds(vodMedia)).toBeCloseTo(12.51, 2);
    });

    it('returns null when there are no segments', () => {
      expect(playlistDurationSeconds(muxedMaster)).toBeNull();
    });
  });

  describe('buildStreamId', () => {
    it('is stable for the same video and quality', () => {
      expect(buildStreamId('abc', '1080')).toBe(buildStreamId('abc', '1080'));
    });

    it('differs by quality', () => {
      expect(buildStreamId('abc', '1080')).not.toBe(buildStreamId('abc', '720'));
    });
  });
});

describe('youtubeHlsMode.resolvePlaylist', () => {
  const params = (overrides = {}) => ({ youtubeId: 'abc', quality: '1080', qualityStrictness: 'fallback', ...overrides });

  it('serves the muxed variant\'s media playlist directly, with every segment and the exact duration', async () => {
    const playlist = await resolvePlaylist(params(), fakeDeps());
    expect(playlistDurationSeconds(playlist)).toBeCloseTo(12.51, 2);
    expect(playlist).toContain('#EXT-X-ENDLIST');
  });

  it('asks the variant matching the configured quality for its media playlist', async () => {
    const deps = fakeDeps();
    await resolvePlaylist(params({ quality: '720' }), deps);
    expect(deps.fetchText).toHaveBeenCalledWith('https://manifest.googlevideo.com/api/manifest/hls_playlist/720/index.m3u8');
  });

  it('serves a one-variant master when the variant has separate audio', async () => {
    const deps = fakeDeps({ fetchText: jest.fn().mockResolvedValue(separateAudioMaster) });
    const playlist = await resolvePlaylist(params(), deps);
    expect(playlist).toContain('#EXT-X-STREAM-INF');
    expect(playlist).toContain('#EXT-X-MEDIA:TYPE=AUDIO');
  });

  it('falls back to a one-variant master when the media playlist is not a finished VOD playlist', async () => {
    const live = '#EXTM3U\n#EXTINF:5,\nseg0.ts\n';
    const deps = fakeDeps({ fetchText: jest.fn(async (url) => (url === MASTER_URL ? muxedMaster : live)) });
    expect(await resolvePlaylist(params(), deps)).toContain('#EXT-X-STREAM-INF');
  });

  it('serves a manifest that is already a media playlist', async () => {
    const deps = fakeDeps({ fetchText: jest.fn().mockResolvedValue(vodMedia) });
    expect(await resolvePlaylist(params(), deps)).toContain('#EXT-X-ENDLIST');
  });

  it('fails with a clear message when YouTube offers no HLS manifest', async () => {
    const deps = fakeDeps({ fetchInfo: jest.fn().mockResolvedValue({ formats: [{ url: 'x' }] }) });
    await expect(resolvePlaylist(params(), deps)).rejects.toThrow(/no HLS manifest/i);
  });

  it('fails in fixed mode when no variant fits under the requested height', async () => {
    await expect(resolvePlaylist(params({ quality: '240', qualityStrictness: 'fixed' }), fakeDeps())).rejects.toThrow(/No HLS variant/);
  });

  it('propagates a yt-dlp failure', async () => {
    const deps = fakeDeps({ fetchInfo: jest.fn().mockRejectedValue(new Error('Failed to fetch video metadata')) });
    await expect(resolvePlaylist(params(), deps)).rejects.toThrow('Failed to fetch video metadata');
  });
});

describe('youtubeHlsMode.getPlaylist', () => {
  beforeEach(() => clearPlaylistCache());
  const params = { youtubeId: 'abc', quality: '1080', qualityStrictness: 'fallback' };

  it('resolves once and serves repeat requests from the cache', async () => {
    const deps = fakeDeps();
    await getPlaylist(params, deps);
    await getPlaylist(params, deps);
    expect(deps.fetchInfo).toHaveBeenCalledTimes(1);
  });

  it('reports a cache hit on the repeat request', async () => {
    const deps = fakeDeps();
    await getPlaylist(params, deps);
    expect((await getPlaylist(params, deps)).cached).toBe(true);
  });

  it('shares a single resolve between concurrent requests for one video', async () => {
    const deps = fakeDeps();
    await Promise.all([getPlaylist(params, deps), getPlaylist(params, deps), getPlaylist(params, deps)]);
    expect(deps.fetchInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries per quality', async () => {
    const deps = fakeDeps();
    await getPlaylist(params, deps);
    await getPlaylist({ ...params, quality: '720' }, deps);
    expect(deps.fetchInfo).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed resolve', async () => {
    const deps = fakeDeps({ fetchInfo: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(infoWithManifest) });
    await expect(getPlaylist(params, deps)).rejects.toThrow('boom');
    await expect(getPlaylist(params, deps)).resolves.toBeDefined();
  });
});

describe('youtubeHlsMode.handleYoutubeHlsRequest', () => {
  const requestParams = (overrides = {}) => ({
    youtubeId: 'abc', quality: '1080', qualityStrictness: 'fallback', playerClient: undefined,
    clientIp: '10.0.0.5', userAgent: 'Lavf/62.12.102', ...overrides,
  });
  const mockRes = () => {
    const res = {};
    res.set = jest.fn(() => res);
    res.status = jest.fn(() => res);
    res.send = jest.fn(() => res);
    return res;
  };
  const req = { headers: {}, originalUrl: '/api/ytstream/abc?mode=youtube-hls' };

  beforeEach(() => {
    clearPlaylistCache();
    mockStreams.clear();
    jest.clearAllMocks();
  });
  afterAll(() => clearPlaylistCache());

  it('answers 200 with an HLS content type', async () => {
    const res = mockRes();
    await handleYoutubeHlsRequest(req, res, requestParams(), fakeDeps());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'application/vnd.apple.mpegurl' }));
  });

  it('sends the resolved playlist', async () => {
    const res = mockRes();
    await handleYoutubeHlsRequest(req, res, requestParams(), fakeDeps());
    expect(res.send.mock.calls[0][0]).toContain('#EXT-X-ENDLIST');
  });

  it('shows the video on Live Streams as a youtube-hls row', async () => {
    await handleYoutubeHlsRequest(req, mockRes(), requestParams(), fakeDeps());
    expect(activeStreams.trackStream).toHaveBeenCalledWith(expect.objectContaining({ mode: 'youtube-hls', youtubeId: 'abc', quality: '1080' }));
  });

  it('starts the row as resolving and leaves it active once the playlist is served', async () => {
    const seenStates = [];
    activeStreams.trackStream.mockImplementationOnce((entry) => { seenStates.push(entry.state); mockStreams.set(entry.streamId, entry); });
    await handleYoutubeHlsRequest(req, mockRes(), requestParams(), fakeDeps());
    expect(seenStates).toEqual(['resolving']);
    expect(mockStreams.get(buildStreamId('abc', '1080')).state).toBe('active');
  });

  it('counts the playlist bytes against the row', async () => {
    await handleYoutubeHlsRequest(req, mockRes(), requestParams(), fakeDeps());
    expect(mockStreams.get(buildStreamId('abc', '1080')).bytesTransferred).toBeGreaterThan(0);
  });

  it('shares one row between two viewers of the same video and counts both', async () => {
    await handleYoutubeHlsRequest(req, mockRes(), requestParams({ clientIp: '10.0.0.5' }), fakeDeps());
    await handleYoutubeHlsRequest(req, mockRes(), requestParams({ clientIp: '10.0.0.9' }), fakeDeps());
    expect(activeStreams.trackStream).toHaveBeenCalledTimes(1);
    expect(mockStreams.get(buildStreamId('abc', '1080')).viewers.size).toBe(2);
  });

  it('offers a Stop that removes the row', async () => {
    await handleYoutubeHlsRequest(req, mockRes(), requestParams(), fakeDeps());
    mockStreams.get(buildStreamId('abc', '1080')).stop();
    expect(activeStreams.untrackStream).toHaveBeenCalledWith(buildStreamId('abc', '1080'), 'manual-stop', null);
  });

  it('answers 502 with the reason when the playlist cannot be resolved', async () => {
    const res = mockRes();
    const deps = fakeDeps({ fetchInfo: jest.fn().mockRejectedValue(new Error('no manifest here')) });
    await handleYoutubeHlsRequest(req, res, requestParams(), deps);
    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.send.mock.calls[0][0]).toContain('no manifest here');
  });

  it('marks the row failed when the request that created it fails', async () => {
    const deps = fakeDeps({ fetchInfo: jest.fn().mockRejectedValue(new Error('boom')) });
    await handleYoutubeHlsRequest(req, mockRes(), requestParams(), deps);
    expect(activeStreams.failStreamThenUntrack).toHaveBeenCalledWith(buildStreamId('abc', '1080'), 'failed', 'boom');
  });

  it('leaves another viewer\'s active row alone when a later request fails', async () => {
    await handleYoutubeHlsRequest(req, mockRes(), requestParams(), fakeDeps());
    clearPlaylistCache();
    const deps = fakeDeps({ fetchInfo: jest.fn().mockRejectedValue(new Error('boom')) });
    await handleYoutubeHlsRequest(req, mockRes(), requestParams({ clientIp: '10.0.0.9' }), deps);
    expect(activeStreams.failStreamThenUntrack).not.toHaveBeenCalled();
  });
});

describe('describeRun (dry run)', () => {
  const params = { youtubeId: 'vid00000001', quality: '1080', qualityStrictness: 'fallback', playerClient: null, audioLanguage: 'de' };
  const info = { language: 'en', formats: [{ manifest_url: 'https://manifest.googlevideo.com/m.m3u8' }] };
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="English - original",LANGUAGE="en-US",DEFAULT=NO,URI="a/en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="German - dubbed-auto",LANGUAGE="de",DEFAULT=NO,URI="a/de.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=4500000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234"',
    'v/1080.m3u8',
  ].join('\n');
  const deps = () => ({
    fetchInfo: jest.fn(async () => info),
    fetchText: jest.fn(async () => master),
    fetchHead: jest.fn(async () => ({ status: 200, bytes: Buffer.alloc(0) })),
  });

  beforeEach(() => clearPlaylistCache());

  it('reports the settings and what it would call without any network work', async () => {
    const d = deps();
    const result = await describeRun(params, {}, d);
    expect(result.wouldCall).toMatch(/getPlaylist/);
    expect(d.fetchInfo).not.toHaveBeenCalled();
  });

  it('lists the settings youtube-hls ignores', async () => {
    expect((await describeRun(params, {}, deps())).ignoredSettings).toContain('transcode');
  });

  it('says whether the playlist is already cached', async () => {
    const d = deps();
    await getPlaylist({ ...params, preferredLanguage: 'de' }, d);
    expect((await describeRun(params, {}, d)).playlistCached).toBe(true);
  });

  it('with probe, reports the variant and the audio track it would choose', async () => {
    const result = await describeRun(params, { probe: true }, deps());
    expect(result.choice).toMatchObject({ chosenHeight: 1080, servedAs: 'one-variant master (separate audio playlist)' });
    expect(result.choice.audio.chosen).toMatchObject({ language: 'de', reason: 'requested language de' });
  });

  it('with probe and no requested language, chooses the original', async () => {
    const result = await describeRun({ ...params, audioLanguage: '' }, { probe: true }, deps());
    expect(result.choice.audio.chosen.reason).toBe('marked original');
  });

  it('with probe, reports a failed lookup as an error instead of throwing', async () => {
    const d = { ...deps(), fetchInfo: jest.fn(async () => { throw new Error('yt-dlp exploded'); }) };
    expect((await describeRun(params, { probe: true }, d)).error).toMatch(/yt-dlp exploded/);
  });

  it('with probe, does not add the playlist to the cache', async () => {
    await describeRun(params, { probe: true }, deps());
    expect((await describeRun(params, {}, deps())).playlistCached).toBe(false);
  });
});

describe('youtube-hls routing through Youtarr (youtubeHlsProxy)', () => {
  const proxyModule = require('../youtubeHlsProxy');
  const { recordProxyActivity } = require('../youtubeHlsMode');
  const PROXY_KEY = 'ythp-aaaaaaaaaaaaaaaaaaaa';
  const VARIANT_URL = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/270/index.m3u8';
  const AUDIO_URL = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/234/index.m3u8';
  const VIDEO_SEGMENT = 'https://rr2---sn-x.googlevideo.com/videoplayback/begin/0/len/5000/file/seg.ts';
  const AUDIO_SEGMENT = 'https://rr2---sn-x.googlevideo.com/videoplayback/itag/234/begin/0/len/5000/file/seg.ts';
  const mediaOf = (segment) => ['#EXTM3U', '#EXT-X-TARGETDURATION:5', '#EXTINF:5.0,', segment, '#EXTINF:5.0,', segment, '#EXT-X-ENDLIST'].join('\n');

  const separateMaster = [
    '#EXTM3U',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="234",NAME="English - original",LANGUAGE="en-US",DEFAULT=YES,URI="${AUDIO_URL}"`,
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="234"',
    VARIANT_URL,
  ].join('\n');
  const mutedMaster = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080',
    VARIANT_URL,
  ].join('\n');

  const depsFor = (master) => ({
    fetchInfo: jest.fn(async () => ({ language: 'en', formats: [{ manifest_url: MASTER_URL }] })),
    fetchText: jest.fn(async (url) => {
      if (url === MASTER_URL) return master;
      if (url === AUDIO_URL) return mediaOf(AUDIO_SEGMENT);
      return mediaOf(VIDEO_SEGMENT);
    }),
    fetchHead: jest.fn(async () => ({ status: 206, bytes: Buffer.alloc(0) })),
  });
  const params = { youtubeId: 'abc', quality: '1080', qualityStrictness: 'fallback', playerClient: undefined };

  beforeEach(() => {
    clearPlaylistCache();
    proxyModule.clearRegistry();
    mockStreams.clear();
    jest.clearAllMocks();
  });

  describe('separate audio playlist', () => {
    it('puts Youtarr URLs for the video and audio playlists in the master', async () => {
      const master = await resolvePlaylist({ ...params, proxyMode: 'proxy', proxyKey: PROXY_KEY }, depsFor(separateMaster));
      expect(master).toContain(`/api/ytstream/abc/yth/${PROXY_KEY}/video.m3u8`);
      expect(master).toContain(`URI="/api/ytstream/abc/yth/${PROXY_KEY}/audio.m3u8"`);
      expect(master).not.toContain('googlevideo.com');
    });

    it('registers both playlists so Youtarr can serve them', async () => {
      await resolvePlaylist({ ...params, proxyMode: 'proxy', proxyKey: PROXY_KEY }, depsFor(separateMaster));
      expect(Object.keys(proxyModule.get(PROXY_KEY).kinds)).toEqual(['video', 'audio']);
    });

    it('fetches the media playlists itself when routing them', async () => {
      const deps = depsFor(separateMaster);
      await resolvePlaylist({ ...params, proxyMode: 'proxy', proxyKey: PROXY_KEY }, deps);
      expect(deps.fetchText).toHaveBeenCalledWith(VARIANT_URL);
      expect(deps.fetchText).toHaveBeenCalledWith(AUDIO_URL);
    });

    it('remembers the routing mode with the registered playlists', async () => {
      await resolvePlaylist({ ...params, proxyMode: 'serve', proxyKey: PROXY_KEY }, depsFor(separateMaster));
      expect(proxyModule.get(PROXY_KEY).mode).toBe('serve');
    });

    it('bases the estimate on the chosen variant bitrate for video and none for audio', async () => {
      await resolvePlaylist({ ...params, proxyMode: 'serve', proxyKey: PROXY_KEY }, depsFor(separateMaster));
      const { kinds } = proxyModule.get(PROXY_KEY);
      expect([kinds.video.bandwidthBps, kinds.audio.bandwidthBps]).toEqual([4000000, 0]);
    });

    it('leaves the master pointing at YouTube and registers nothing when routing is off', async () => {
      const master = await resolvePlaylist({ ...params, proxyMode: 'off', proxyKey: null }, depsFor(separateMaster));
      expect(master).toContain(VARIANT_URL);
      expect(proxyModule.has(PROXY_KEY)).toBe(false);
    });

    it('does not register anything without a registry key (a dry run)', async () => {
      const master = await resolvePlaylist({ ...params, proxyMode: 'serve' }, depsFor(separateMaster));
      expect(master).toContain(VARIANT_URL);
    });

    it('fails the resolve when a media playlist cannot be fetched', async () => {
      const deps = depsFor(separateMaster);
      deps.fetchText.mockImplementation(async (url) => {
        if (url === MASTER_URL) return separateMaster;
        throw new Error('HTTP 403 fetching manifest.googlevideo.com');
      });
      await expect(resolvePlaylist({ ...params, proxyMode: 'proxy', proxyKey: PROXY_KEY }, deps)).rejects.toThrow(/403/);
    });

    it('skips the reachability check, since the playlists were just fetched', async () => {
      const deps = depsFor(separateMaster);
      await resolvePlaylist({ ...params, proxyMode: 'proxy', proxyKey: PROXY_KEY }, deps);
      expect(deps.fetchHead).not.toHaveBeenCalled();
    });
  });

  describe('audio muxed into the segments', () => {
    it('in serve mode returns the media playlist with Youtarr segment URLs', async () => {
      const playlist = await resolvePlaylist({ ...params, proxyMode: 'serve', proxyKey: PROXY_KEY }, depsFor(mutedMaster));
      expect(playlist).toContain(`/api/ytstream/abc/yth/${PROXY_KEY}/media/s0.ts`);
      expect(proxyModule.get(PROXY_KEY).kinds.media.segments).toHaveLength(2);
    });

    it('in proxy mode returns the media playlist itself, unchanged from before', async () => {
      const playlist = await resolvePlaylist({ ...params, proxyMode: 'proxy', proxyKey: PROXY_KEY }, depsFor(mutedMaster));
      expect(playlist).toContain(VIDEO_SEGMENT);
      expect(proxyModule.has(PROXY_KEY)).toBe(false);
    });
  });

  describe('getPlaylist', () => {
    it('resolves again when the registered playlists have gone but the master is still cached', async () => {
      const deps = depsFor(separateMaster);
      await getPlaylist({ ...params, proxyMode: 'proxy' }, deps);
      proxyModule.clearRegistry();
      await getPlaylist({ ...params, proxyMode: 'proxy' }, deps);
      expect(deps.fetchInfo).toHaveBeenCalledTimes(2);
    });

    it('serves the cached master while its playlists are still registered', async () => {
      const deps = depsFor(separateMaster);
      await getPlaylist({ ...params, proxyMode: 'proxy' }, deps);
      const second = await getPlaylist({ ...params, proxyMode: 'proxy' }, deps);
      expect([second.cached, deps.fetchInfo.mock.calls.length]).toEqual([true, 1]);
    });

    it('keeps a separate cache entry per routing mode', async () => {
      const deps = depsFor(separateMaster);
      const direct = await getPlaylist({ ...params, proxyMode: 'off' }, deps);
      const routed = await getPlaylist({ ...params, proxyMode: 'proxy' }, deps);
      expect(direct.playlist).not.toBe(routed.playlist);
    });
  });

  describe('handleYoutubeHlsRequest', () => {
    const req = { headers: {}, originalUrl: '/api/ytstream/abc?mode=youtube-hls' };
    const mockRes = () => {
      const res = {};
      res.set = jest.fn(() => res);
      res.status = jest.fn(() => res);
      res.send = jest.fn(() => res);
      return res;
    };

    it('serves the routed master when hlsProxy is set', async () => {
      const res = mockRes();
      await handleYoutubeHlsRequest(req, res, { ...params, clientIp: '10.0.0.5', userAgent: 'Lavf/62', hlsProxy: 'serve' }, depsFor(separateMaster));
      expect(res.send.mock.calls[0][0]).toContain('/yth/');
    });

    it('serves the plain master when hlsProxy is off', async () => {
      const res = mockRes();
      await handleYoutubeHlsRequest(req, res, { ...params, clientIp: '10.0.0.5', userAgent: 'Lavf/62', hlsProxy: 'off' }, depsFor(separateMaster));
      expect(res.send.mock.calls[0][0]).not.toContain('/yth/');
    });
  });

  describe('recordProxyActivity', () => {
    const base = { youtubeId: 'abc', quality: '1080', clientIp: '10.0.0.5', userAgent: 'Lavf/62', mode: 'serve' };
    const rowId = buildStreamId('abc', '1080');

    it('creates the Live Streams row when the first request through Youtarr is a segment', () => {
      recordProxyActivity({ ...base, type: 'segment', kind: 'video', index: 0, positionSeconds: 0, durationSeconds: 5, estimatedBytes: 100 });
      expect(mockStreams.get(rowId)).toMatchObject({ mode: 'youtube-hls', state: 'active' });
    });

    it('adds a playlist size to the total as real bytes', () => {
      recordProxyActivity({ ...base, type: 'playlist', kind: 'video', bytes: 5000 });
      expect(mockStreams.get(rowId).bytesTransferred).toBe(5000);
      expect(mockStreams.get(rowId).bytesEstimated).toBeUndefined();
    });

    it('adds a segment estimate to the total and marks the total as estimated', () => {
      recordProxyActivity({ ...base, type: 'segment', kind: 'video', index: 0, positionSeconds: 0, durationSeconds: 5, estimatedBytes: 2500000 });
      expect([mockStreams.get(rowId).bytesTransferred, mockStreams.get(rowId).bytesEstimated]).toEqual([2500000, true]);
    });

    it('keeps the playback position and counts the segments', () => {
      recordProxyActivity({ ...base, type: 'segment', kind: 'video', index: 0, positionSeconds: 0, durationSeconds: 5, estimatedBytes: 1 });
      recordProxyActivity({ ...base, type: 'segment', kind: 'video', index: 1, positionSeconds: 5, durationSeconds: 5, estimatedBytes: 1 });
      expect([mockStreams.get(rowId).playbackSeconds, mockStreams.get(rowId).segmentsServed]).toEqual([5, 2]);
    });

    it('does not count an init request as a segment', () => {
      recordProxyActivity({ ...base, type: 'init', kind: 'video' });
      expect(mockStreams.get(rowId).segmentsServed).toBeUndefined();
    });

    describe('segment grid', () => {
      const segmentEvent = (index, overrides = {}) => ({ ...base, type: 'segment', kind: 'video', index, positionSeconds: index * 5, durationSeconds: 5, estimatedBytes: 1, segmentCount: 4, averageSegmentSeconds: 5, ...overrides });

      it('starts a grid sized to the video stream on the first segment request', () => {
        recordProxyActivity(segmentEvent(1));
        expect(mockStreams.get(rowId).segmentGrid).toMatchObject({ total: 4, durationSeconds: 5, requested: [false, true, false, false], current: 1 });
      });

      it('marks each requested segment and remembers the latest', () => {
        recordProxyActivity(segmentEvent(0));
        recordProxyActivity(segmentEvent(1));
        recordProxyActivity(segmentEvent(3));
        expect(mockStreams.get(rowId).segmentGrid).toMatchObject({ requested: [true, true, false, true], current: 3 });
      });

      it('keeps earlier requests when the player seeks back', () => {
        recordProxyActivity(segmentEvent(2));
        recordProxyActivity(segmentEvent(0));
        expect(mockStreams.get(rowId).segmentGrid.requested).toEqual([true, false, true, false]);
      });

      it('leaves the grid alone for audio segments', () => {
        recordProxyActivity(segmentEvent(0, { kind: 'audio' }));
        expect(mockStreams.get(rowId).segmentGrid).toBeUndefined();
      });

      it('does not start a grid from a playlist request', () => {
        recordProxyActivity({ ...base, type: 'playlist', kind: 'video', bytes: 10 });
        expect(mockStreams.get(rowId).segmentGrid).toBeUndefined();
      });

      it('ignores a segment number beyond the stream', () => {
        recordProxyActivity(segmentEvent(9));
        expect(mockStreams.get(rowId).segmentGrid.requested).toEqual([false, false, false, false]);
      });
    });

    it('records a second client as a viewer of the same row', () => {
      recordProxyActivity({ ...base, type: 'playlist', kind: 'video', bytes: 1 });
      recordProxyActivity({ ...base, clientIp: '10.0.0.6', type: 'playlist', kind: 'audio', bytes: 1 });
      expect(mockStreams.get(rowId).viewers.size).toBe(2);
    });
  });

  describe('describeRun', () => {
    const dryParams = { ...params, audioLanguage: '', hlsProxy: 'serve' };

    it('shows the routing mode in the settings and in what it would call', async () => {
      const result = await describeRun(dryParams, {}, depsFor(separateMaster));
      expect(result.settings.hlsProxy).toBe('serve');
      expect(result.wouldCall).toMatch(/redirects \(302\)/);
    });

    it('with probe, reports the routing without registering anything', async () => {
      const result = await describeRun(dryParams, { probe: true }, depsFor(separateMaster));
      expect(result.choice.servedAs).toMatch(/one-variant master/);
      expect(proxyModule.has(PROXY_KEY)).toBe(false);
    });
  });
});
