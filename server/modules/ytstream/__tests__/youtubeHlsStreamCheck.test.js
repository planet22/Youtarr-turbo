/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));

const logger = require('../../../logger');
const { checkChosenStreams, sniffContainer, readMediaPlaylist, looksBroken } = require('../youtubeHlsStreamCheck');

const VIDEO_PLAYLIST = [
  '#EXTM3U', '#EXT-X-TARGETDURATION:5', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:5.0,', 'seg1.m4s', '#EXTINF:5.0,', 'seg2.m4s', '#EXT-X-ENDLIST',
].join('\n');

const head = (status, bytes, extra = {}) => ({ status, contentType: 'video/mp4', bytes: Buffer.from(bytes), ...extra });
const fmp4Bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.alloc(8)]);

describe('sniffContainer', () => {
  it('recognises fragmented MP4', () => {
    expect(sniffContainer(fmp4Bytes)).toBe('fmp4');
  });

  it('recognises MPEG-TS', () => {
    expect(sniffContainer(Buffer.from([0x47, 0x40, 0x00, 0x10]))).toBe('mpegts');
  });

  it('recognises an HTML error page', () => {
    expect(sniffContainer(Buffer.from('<html><body>403'))).toBe('html-or-xml');
  });

  it('recognises WebVTT', () => {
    expect(sniffContainer(Buffer.from('WEBVTT\n'))).toBe('webvtt');
  });

  it('reports empty input', () => {
    expect(sniffContainer(Buffer.alloc(0))).toBe('empty');
  });
});

describe('readMediaPlaylist', () => {
  it('finds the init segment, first segment and count, resolved against the playlist', () => {
    const media = readMediaPlaylist(VIDEO_PLAYLIST, 'https://cdn.example/a/index.m3u8');
    expect(media).toMatchObject({ segmentCount: 2, firstSegmentUrl: 'https://cdn.example/a/seg1.m4s', initUrl: 'https://cdn.example/a/init.mp4', encryption: 'NONE', endList: true });
  });

  it('reports the encryption method when segments are encrypted', () => {
    const media = readMediaPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:5,\ns.ts', 'https://cdn.example/a.m3u8');
    expect(media.encryption).toBe('AES-128');
  });
});

describe('readMediaPlaylist line checks', () => {
  it('reports the longest line and how many are over the ffmpeg limit', () => {
    const longUrl = `https://cdn.example/${'a'.repeat(4200)}`;
    const media = readMediaPlaylist(`#EXTM3U\n#EXTINF:5,\n${longUrl}\n#EXTINF:5,\nshort.ts`, 'https://cdn.example/x.m3u8');
    expect([media.maxLineBytes, media.linesOverFfmpegLimit]).toEqual([longUrl.length, 1]);
  });

  it('reports the first line and the distinct tag lines without the segment lines', () => {
    const media = readMediaPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXT-X-ENDLIST', 'https://cdn.example/x.m3u8');
    expect([media.firstLine, media.tagLines]).toEqual(['#EXTM3U', ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-ENDLIST']]);
  });
});

describe('checkChosenStreams', () => {
  const targets = [{ kind: 'video', url: 'https://cdn.example/v/index.m3u8' }, { kind: 'audio', url: 'https://cdn.example/a/index.m3u8' }];

  beforeEach(() => jest.clearAllMocks());

  it('reports each stream with its segment status and container', async () => {
    const results = await checkChosenStreams({
      youtubeId: 'vid',
      targets,
      fetchText: jest.fn(async () => VIDEO_PLAYLIST),
      fetchHead: jest.fn(async () => head(206, fmp4Bytes)),
    });
    expect(results.map((r) => [r.kind, r.firstSegment.status, r.firstSegment.container])).toEqual([['video', 206, 'fmp4'], ['audio', 206, 'fmp4']]);
  });

  it('logs a warning when the first video segment is refused', async () => {
    await checkChosenStreams({
      youtubeId: 'vid',
      targets: [targets[0]],
      fetchText: jest.fn(async () => VIDEO_PLAYLIST),
      fetchHead: jest.fn(async () => head(403, '<html>')),
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video' }), 'ytstream: youtube-hls stream check - this stream looks unplayable from the server side');
  });

  it('logs info for a stream that is reachable', async () => {
    await checkChosenStreams({
      youtubeId: 'vid', targets: [targets[0]], fetchText: jest.fn(async () => VIDEO_PLAYLIST), fetchHead: jest.fn(async () => head(206, fmp4Bytes)),
    });
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ kind: 'video' }), 'ytstream: youtube-hls stream check - stream reachable');
  });

  it('flags a playlist that cannot be fetched', async () => {
    const results = await checkChosenStreams({
      youtubeId: 'vid', targets: [targets[0]], fetchText: jest.fn(async () => { throw new Error('HTTP 403 fetching cdn.example'); }), fetchHead: jest.fn(),
    });
    expect(results[0].playlistError).toMatch(/403/);
  });

  it('keeps checking the other stream when one fails', async () => {
    const fetchText = jest.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(VIDEO_PLAYLIST);
    const results = await checkChosenStreams({ youtubeId: 'vid', targets, fetchText, fetchHead: jest.fn(async () => head(206, fmp4Bytes)) });
    expect(results).toHaveLength(2);
  });
});

describe('looksBroken', () => {
  it('flags a playlist with a line longer than ffmpeg reads', () => {
    expect(looksBroken({ segmentCount: 2, encryption: 'NONE', linesOverFfmpegLimit: 3 })).toBe(true);
  });

  it('flags a playlist that does not start with #EXTM3U', () => {
    expect(looksBroken({ segmentCount: 2, encryption: 'NONE', firstLine: '<html>' })).toBe(true);
  });

  it('treats encrypted segments as unplayable', () => {
    expect(looksBroken({ segmentCount: 2, encryption: 'AES-128' })).toBe(true);
  });

  it('accepts a normal reachable stream', () => {
    expect(looksBroken({ segmentCount: 2, encryption: 'NONE', firstSegment: { status: 206, container: 'fmp4' } })).toBe(false);
  });
});
