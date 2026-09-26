/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));

const {
  normalizeProxyMode, buildProxyKey, proxyBasePath, buildKindEntry, segmentExtension, register, get, has, createProxyHandlers, clearRegistry,
} = require('../youtubeHlsProxy');

const KEY = buildProxyKey('vid00000001|1080|fallback||serve');
const BASE = proxyBasePath('vid00000001', KEY);
const PLAYLIST_URL = 'https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/270/index.m3u8';
const SEG1 = 'https://rr2---sn-x.googlevideo.com/videoplayback/begin/0/len/5000/file/seg.ts';
const SEG2 = 'https://rr2---sn-x.googlevideo.com/videoplayback/begin/5000/len/2500/file/seg.ts';
const MEDIA = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:5', '#EXTINF:5.0,', SEG1, '#EXTINF:2.5,', SEG2, '#EXT-X-ENDLIST'].join('\n');

const entryFor = (mode = 'serve') => ({
  youtubeId: 'vid00000001',
  quality: '1080',
  mode,
  kinds: { video: buildKindEntry({ kind: 'video', playlistUrl: PLAYLIST_URL, text: MEDIA, bandwidthBps: 4000000, basePath: BASE }) },
});

function mockRes() {
  const res = { headers: {}, statusCode: null, body: null, redirected: null };
  res.set = jest.fn((nameOrObj, value) => {
    if (typeof nameOrObj === 'string') res.headers[nameOrObj.toLowerCase()] = value;
    else Object.entries(nameOrObj).forEach(([k, v]) => { res.headers[k.toLowerCase()] = v; });
    return res;
  });
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.redirect = jest.fn((code, url) => { res.statusCode = code; res.redirected = url; return res; });
  return res;
}

const requestFor = (params) => ({ params, headers: { 'user-agent': 'Lavf/62' } });

describe('normalizeProxyMode', () => {
  it('accepts the three modes', () => {
    expect(['off', 'proxy', 'serve'].map(normalizeProxyMode)).toEqual(['off', 'proxy', 'serve']);
  });

  it('is case and whitespace tolerant', () => {
    expect(normalizeProxyMode(' Serve ')).toBe('serve');
  });

  it('falls back to off for anything else', () => {
    expect([normalizeProxyMode(undefined), normalizeProxyMode('yes'), normalizeProxyMode('')]).toEqual(['off', 'off', 'off']);
  });
});

describe('buildProxyKey / proxyBasePath', () => {
  it('is stable for the same cache key and differs for another', () => {
    expect(buildProxyKey('a')).toBe(buildProxyKey('a'));
    expect(buildProxyKey('a')).not.toBe(buildProxyKey('b'));
  });

  it('produces a key the handlers accept', () => {
    expect(buildProxyKey('anything')).toMatch(/^ythp-[a-f0-9]{20}$/);
  });

  it('builds a root-relative path under the ytstream API', () => {
    expect(proxyBasePath('vid00000001', 'ythp-abc')).toBe('/api/ytstream/vid00000001/yth/ythp-abc');
  });
});

describe('segmentExtension', () => {
  it('reads the extension from the URL path', () => {
    expect(segmentExtension(SEG1)).toBe('.ts');
  });

  it('ignores a query string', () => {
    expect(segmentExtension('https://cdn.example/a/seg.M4S?x=1')).toBe('.m4s');
  });

  it('defaults to .ts when there is none', () => {
    expect(segmentExtension('https://cdn.example/a/segment')).toBe('.ts');
  });
});

describe('buildKindEntry', () => {
  const entry = buildKindEntry({ kind: 'video', playlistUrl: PLAYLIST_URL, text: MEDIA, bandwidthBps: 4000000, basePath: BASE });

  it('lists each segment with its duration and start time', () => {
    expect(entry.segments).toEqual([
      { url: SEG1, durationSeconds: 5, startSeconds: 0 },
      { url: SEG2, durationSeconds: 2.5, startSeconds: 5 },
    ]);
  });

  it('adds up the length of the stream', () => {
    expect(entry.totalSeconds).toBe(7.5);
  });

  it('keeps the segments pointing at YouTube in the proxy text', () => {
    expect(entry.texts.proxy).toContain(SEG1);
  });

  it('points every segment at Youtarr in the serve text', () => {
    expect(entry.texts.serve).toContain(`${BASE}/video/s0.ts`);
    expect(entry.texts.serve).toContain(`${BASE}/video/s1.ts`);
    expect(entry.texts.serve).not.toContain('googlevideo.com');
  });

  it('keeps the other tags in both texts', () => {
    expect(entry.texts.serve).toContain('#EXT-X-ENDLIST');
    expect(entry.texts.proxy).toContain('#EXT-X-TARGETDURATION:5');
  });

  it('makes relative segment URLs absolute against the playlist', () => {
    const relative = buildKindEntry({ kind: 'audio', playlistUrl: 'https://cdn.example/a/index.m3u8', text: '#EXTM3U\n#EXTINF:5,\nseg0.ts', bandwidthBps: 0, basePath: BASE });
    expect(relative.segments[0].url).toBe('https://cdn.example/a/seg0.ts');
  });

  it('routes an init segment through Youtarr in the serve text and remembers the real one', () => {
    const withInit = buildKindEntry({ kind: 'video', playlistUrl: 'https://cdn.example/v/index.m3u8', text: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\ns0.m4s', bandwidthBps: 0, basePath: BASE });
    expect(withInit.texts.serve).toContain(`URI="${BASE}/video/init.mp4"`);
    expect(withInit.initUrl).toBe('https://cdn.example/v/init.mp4');
    expect(withInit.texts.serve).toContain(`${BASE}/video/s0.m4s`);
  });
});

describe('registry', () => {
  beforeEach(() => { clearRegistry(); jest.useFakeTimers(); });
  afterEach(() => jest.useRealTimers());

  it('returns what was registered', () => {
    register(KEY, entryFor());
    expect(get(KEY).youtubeId).toBe('vid00000001');
  });

  it('forgets an entry after its lifetime', () => {
    register(KEY, entryFor());
    jest.advanceTimersByTime(31 * 60 * 1000);
    expect(has(KEY)).toBe(false);
  });

  it('knows nothing about an unregistered key', () => {
    expect(has('ythp-00000000000000000000')).toBe(false);
  });
});

describe('proxy handlers', () => {
  const onActivity = jest.fn();
  const handlers = createProxyHandlers({ resolveClientIp: () => '10.0.0.9', onActivity });
  const playlist = (params) => { const res = mockRes(); handlers.handlePlaylist(requestFor(params), res); return res; };
  const segment = (params) => { const res = mockRes(); handlers.handleSegment(requestFor(params), res); return res; };

  beforeEach(() => { clearRegistry(); onActivity.mockClear(); });

  describe('playlists', () => {
    it('serves the segment-redirecting text in serve mode', () => {
      register(KEY, entryFor('serve'));
      expect(playlist({ youtubeId: 'vid00000001', key: KEY, file: 'video.m3u8' }).body).toContain(`${BASE}/video/s0.ts`);
    });

    it('serves the YouTube-segment text in proxy mode', () => {
      register(KEY, entryFor('proxy'));
      expect(playlist({ youtubeId: 'vid00000001', key: KEY, file: 'video.m3u8' }).body).toContain(SEG1);
    });

    it('answers as an HLS playlist that is never cached', () => {
      register(KEY, entryFor());
      const res = playlist({ youtubeId: 'vid00000001', key: KEY, file: 'video.m3u8' });
      expect([res.headers['content-type'], res.headers['cache-control']]).toEqual(['application/vnd.apple.mpegurl', 'no-store']);
    });

    it('reports the served bytes and the client', () => {
      register(KEY, entryFor());
      playlist({ youtubeId: 'vid00000001', key: KEY, file: 'video.m3u8' });
      expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'playlist', kind: 'video', quality: '1080', clientIp: '10.0.0.9', userAgent: 'Lavf/62', mode: 'serve' }));
    });

    it('answers 404 for a playlist that expired', () => {
      expect(playlist({ youtubeId: 'vid00000001', key: KEY, file: 'video.m3u8' }).statusCode).toBe(404);
    });

    it('answers 404 for a kind the stream does not have', () => {
      register(KEY, entryFor());
      expect(playlist({ youtubeId: 'vid00000001', key: KEY, file: 'audio.m3u8' }).statusCode).toBe(404);
    });

    it('does not serve a stream under another video id', () => {
      register(KEY, entryFor());
      expect(playlist({ youtubeId: 'otherVideo1', key: KEY, file: 'video.m3u8' }).statusCode).toBe(404);
    });

    it('rejects a malformed key or file name with 400', () => {
      register(KEY, entryFor());
      expect(playlist({ youtubeId: 'vid00000001', key: '../etc', file: 'video.m3u8' }).statusCode).toBe(400);
      expect(playlist({ youtubeId: 'vid00000001', key: KEY, file: '..%2f..%2fpasswd' }).statusCode).toBe(400);
    });

    it('reports nothing for a request it rejected', () => {
      playlist({ youtubeId: 'vid00000001', key: KEY, file: 'video.m3u8' });
      expect(onActivity).not.toHaveBeenCalled();
    });
  });

  describe('segments', () => {
    beforeEach(() => register(KEY, entryFor()));

    it('redirects to the real YouTube segment with a 302', () => {
      const res = segment({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's1.ts' });
      expect([res.statusCode, res.redirected]).toEqual([302, SEG2]);
    });

    it('never lets the redirect be cached', () => {
      expect(segment({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's0.ts' }).headers['cache-control']).toBe('no-store');
    });

    it('reports the position, duration and an estimated size from the playlist bitrate', () => {
      segment({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's1.ts' });
      expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'segment', index: 1, positionSeconds: 5, durationSeconds: 2.5, estimatedBytes: 1250000, totalSeconds: 7.5 }));
    });

    it('estimates nothing for a stream with no known bitrate', () => {
      register(KEY, { ...entryFor(), kinds: { audio: buildKindEntry({ kind: 'audio', playlistUrl: PLAYLIST_URL, text: MEDIA, bandwidthBps: 0, basePath: BASE }) } });
      segment({ youtubeId: 'vid00000001', key: KEY, kind: 'audio', file: 's0.ts' });
      expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ estimatedBytes: 0 }));
    });

    it('answers 404 for a segment number that is not in the playlist', () => {
      expect(segment({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's99.ts' }).statusCode).toBe(404);
    });

    it('answers 404 for an unregistered key, so it can never redirect anywhere else', () => {
      const res = segment({ youtubeId: 'vid00000001', key: 'ythp-00000000000000000000', kind: 'video', file: 's0.ts' });
      expect([res.statusCode, res.redirected]).toEqual([404, null]);
    });

    it('rejects malformed names with 400', () => {
      expect(segment({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 'evil.sh' }).statusCode).toBe(400);
      expect(segment({ youtubeId: 'vid00000001', key: KEY, kind: 'other', file: 's0.ts' }).statusCode).toBe(400);
    });

    it('redirects an init request to the real init segment', () => {
      register(KEY, { ...entryFor(), kinds: { video: buildKindEntry({ kind: 'video', playlistUrl: 'https://cdn.example/v/index.m3u8', text: '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\ns0.m4s', bandwidthBps: 0, basePath: BASE }) } });
      const res = segment({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 'init.mp4' });
      expect(res.redirected).toBe('https://cdn.example/v/init.mp4');
      expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'init' }));
    });
  });

  describe('byteProxy segments', () => {
    const segmentAsync = async (params) => {
      const res = mockRes();
      await handlers.handleSegment(requestFor(params), res);
      return res;
    };
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    it('fetches the real segment itself and sends its bytes, not a redirect', async () => {
      register(KEY, { ...entryFor(), byteProxy: true });
      const body = Buffer.from('fake segment bytes');
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        headers: { get: (name) => (name === 'content-type' ? 'video/mp2t' : null) },
      });

      const res = await segmentAsync({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's0.ts' });

      expect(global.fetch).toHaveBeenCalledWith(SEG1, expect.objectContaining({ signal: expect.anything() }));
      expect(res.redirected).toBeNull();
      expect(res.statusCode).toBe(200);
      expect(Buffer.isBuffer(res.body) ? res.body.toString() : res.body).toBe('fake segment bytes');
      expect(res.headers['content-type']).toBe('video/mp2t');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('still reports segment activity when proxying bytes', async () => {
      register(KEY, { ...entryFor(), byteProxy: true });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      });

      await segmentAsync({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's1.ts' });

      expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'segment', index: 1, positionSeconds: 5 }));
    });

    it('answers with the upstream status when YouTube rejects the fetch', async () => {
      register(KEY, { ...entryFor(), byteProxy: true });
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, headers: { get: () => null } });

      const res = await segmentAsync({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's0.ts' });

      expect(res.statusCode).toBe(403);
    });

    it('answers 502 when the fetch to YouTube itself fails', async () => {
      register(KEY, { ...entryFor(), byteProxy: true });
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

      const res = await segmentAsync({ youtubeId: 'vid00000001', key: KEY, kind: 'video', file: 's0.ts' });

      expect(res.statusCode).toBe(502);
    });
  });
});
