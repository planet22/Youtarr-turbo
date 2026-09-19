/* eslint-env jest */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));

const {
  scanMkv, pickResumePoint, findResumeSeam, refreshLiveSeam, getServableResumeBytes, getMkvProgress, stitchMkvResume,
} = require('../mkvResume');

const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function sizeVint(n) {
  const buf = Buffer.alloc(8);
  buf[0] = 0x01;
  buf.writeUIntBE(n, 2, 6);
  return buf;
}

function element(idHex, payload) {
  return Buffer.concat([Buffer.from(idHex, 'hex'), sizeVint(payload.length), payload]);
}

function mkvHeader() {
  const ebml = element('1a45dfa3', Buffer.from([0x42, 0x86, 0x81, 0x01]));
  const info = element('1549a966', element('2ad7b1', Buffer.from([0x0f, 0x42, 0x40])));
  const tracks = element('1654ae6b', Buffer.alloc(40, 1));
  return Buffer.concat([ebml, Buffer.from('18538067', 'hex'), UNKNOWN_SIZE, info, tracks]);
}

function timecodeElement(ms) {
  const value = Buffer.alloc(4);
  value.writeUInt32BE(ms);
  return element('e7', value);
}

function simpleBlock(track, keyframe) {
  return element('a3', Buffer.concat([Buffer.from([0x80 | track, 0, 0, keyframe ? 0x80 : 0x00]), Buffer.alloc(200, 9)]));
}

// ffmpeg's muxer writes a CRC-32 element ahead of every cluster's Timecode.
function crc32Element() {
  return Buffer.concat([Buffer.from([0xbf, 0x84]), Buffer.alloc(4, 0xab)]);
}

function cluster(ms, { keyframe = true, open = false, crc = true } = {}) {
  const body = Buffer.concat([...(crc ? [crc32Element()] : []), timecodeElement(ms), simpleBlock(1, keyframe), simpleBlock(2, true)]);
  if (open) return Buffer.concat([Buffer.from('1f43b675', 'hex'), UNKNOWN_SIZE, body]);
  return element('1f43b675', body);
}

function cues() {
  return element('1c53bb6b', Buffer.alloc(64, 7));
}

describe('mkvResume', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkvresume-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (name, ...parts) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, Buffer.concat(parts));
    return filePath;
  };
  const range = (fromMs, toMs, stepMs = 5000, options = {}) => {
    const out = [];
    for (let ms = fromMs; ms <= toMs; ms += stepMs) out.push(cluster(ms, options));
    return out;
  };

  describe('scanMkv', () => {
    it('lists the complete clusters with their timecodes', () => {
      const file = write('a.mkv', mkvHeader(), ...range(0, 20000));
      const scan = scanMkv(file);
      expect(scan.clusters.map((c) => c.timecode)).toEqual([0, 5000, 10000, 15000, 20000]);
    });

    it('reads clusters that start with a CRC-32 element, as ffmpeg writes them', () => {
      const file = write('a.mkv', mkvHeader(), ...range(0, 10000));
      expect(scanMkv(file).clusters.map((c) => c.timecode)).toEqual([0, 5000, 10000]);
    });

    it('reads clusters that have no CRC-32 element', () => {
      const file = write('a.mkv', mkvHeader(), ...range(0, 10000, 5000, { crc: false }));
      expect(scanMkv(file).clusters.map((c) => c.timecode)).toEqual([0, 5000, 10000]);
    });

    it('does not count an open (unknown-size) last cluster', () => {
      const file = write('a.mkv', mkvHeader(), ...range(0, 10000), cluster(15000, { open: true }));
      expect(scanMkv(file).clusters).toHaveLength(3);
    });

    it('does not count a truncated last cluster', () => {
      const whole = cluster(15000);
      const file = write('a.mkv', mkvHeader(), ...range(0, 10000), whole.subarray(0, whole.length - 30));
      expect(scanMkv(file).clusters).toHaveLength(3);
    });

    it('stops at the Cues element after the clusters', () => {
      const file = write('a.mkv', mkvHeader(), ...range(0, 10000), cues(), cluster(99000));
      expect(scanMkv(file).clusters).toHaveLength(3);
    });

    it('flags whether each cluster starts on a video keyframe', () => {
      const file = write('a.mkv', mkvHeader(), cluster(0), cluster(5000, { keyframe: false }));
      expect(scanMkv(file).clusters.map((c) => c.startsWithKeyframe)).toEqual([true, false]);
    });

    it('rejects a file that is not Matroska', () => {
      expect(scanMkv(write('a.mkv', Buffer.alloc(100, 5))).ok).toBe(false);
    });
  });

  describe('pickResumePoint', () => {
    it('cuts at the last keyframe cluster at least 12 s before the end', () => {
      const scan = scanMkv(write('a.mkv', mkvHeader(), ...range(0, 60000)));
      expect(pickResumePoint(scan)).toMatchObject({ ok: true, seamMs: 45000, keptClusters: 9 });
    });

    it('starts the resume pass a hair after the seam keyframe', () => {
      const scan = scanMkv(write('a.mkv', mkvHeader(), ...range(0, 60000)));
      expect(pickResumePoint(scan).resumeFromSeconds).toBeCloseTo(45.05, 3);
    });

    it('skips clusters that do not start on a keyframe', () => {
      const file = write('a.mkv', mkvHeader(), ...range(0, 40000), cluster(45000, { keyframe: false }), ...range(50000, 60000));
      expect(pickResumePoint(scanMkv(file)).seamMs).toBe(40000);
    });

    it('is not resumable when the partial is shorter than the minimum', () => {
      const scan = scanMkv(write('a.mkv', mkvHeader(), ...range(0, 25000)));
      expect(pickResumePoint(scan).ok).toBe(false);
    });

    it('is not resumable with fewer than two clusters', () => {
      expect(pickResumePoint(scanMkv(write('a.mkv', mkvHeader(), cluster(0)))).ok).toBe(false);
    });
  });

  describe('findResumeSeam', () => {
    it('asks to retry while the resume file has no cluster yet', () => {
      expect(findResumeSeam(write('r.mkv', mkvHeader()))).toMatchObject({ ok: false, retry: true });
    });

    it('reports the first cluster offset and timecode, even while it is still open', () => {
      const header = mkvHeader();
      const file = write('r.mkv', header, cluster(45000, { open: true }));
      expect(findResumeSeam(file)).toEqual({ ok: true, clusterOffset: header.length, timecodeMs: 45000 });
    });
  });

  describe('live seam', () => {
    const sessionFor = (streamPath, seamMs) => ({
      key: 'k', youtubeId: 'y', streamPath, resumeBaseCopy: { size: 1000, mkv: { seamMs, streamSkip: null, state: 'pending' } },
    });

    it('serves nothing of the resume file until its first cluster has been checked', () => {
      const session = sessionFor(write('r.mkv', mkvHeader()), 45000);
      expect(getServableResumeBytes(session, 500)).toBe(0);
    });

    it('serves the resume file from its first cluster once the seam lines up', () => {
      const header = mkvHeader();
      const streamPath = write('r.mkv', header, cluster(45000), cluster(50000));
      const session = sessionFor(streamPath, 45000);
      expect(getServableResumeBytes(session, fs.statSync(streamPath).size)).toBe(fs.statSync(streamPath).size - header.length);
    });

    it('accepts a first cluster a few ms off the seam', () => {
      const session = sessionFor(write('r.mkv', mkvHeader(), cluster(45020)), 45000);
      expect(refreshLiveSeam(session)).toBe('ok');
    });

    it('flags a mismatch when the resume pass began a whole GOP away', () => {
      const session = sessionFor(write('r.mkv', mkvHeader(), cluster(40000)), 45000);
      expect(refreshLiveSeam(session)).toBe('mismatch');
    });

    it('serves nothing after a mismatch', () => {
      const session = sessionFor(write('r.mkv', mkvHeader(), cluster(40000)), 45000);
      expect(getServableResumeBytes(session, 5000)).toBe(0);
    });
  });

  describe('incremental scan and progress', () => {
    it('continues a scan from the previous nextOffset without re-reading earlier clusters', () => {
      const first = write('a.mkv', mkvHeader(), ...range(0, 10000), cluster(15000, { open: true }));
      const firstScan = scanMkv(first);
      const header = mkvHeader();
      const grown = write('b.mkv', header, ...range(0, 20000));
      const next = scanMkv(grown, { startOffset: firstScan.nextOffset });
      expect(next.clusters.map((c) => c.timecode)).toEqual([15000, 20000]);
    });

    it('reports no next offset until a cluster has been seen', () => {
      expect(scanMkv(write('a.mkv', mkvHeader())).nextOffset).toBeNull();
    });

    it('lists each cluster start and size for the popup', () => {
      const streamPath = write('s.mkv', mkvHeader(), ...range(0, 10000));
      const progress = getMkvProgress({ streamPath, durationSeconds: 100, declaredTotal: 5000 });
      expect(progress).toMatchObject({ clusterStartsMs: [0, 5000, 10000], encodedSeconds: 10, durationSeconds: 100, declaredTotalBytes: 5000 });
    });

    it('adds newly written clusters on the next call, keeping the earlier ones', () => {
      const streamPath = path.join(dir, 's.mkv');
      const session = { streamPath, durationSeconds: 100, declaredTotal: null };
      fs.writeFileSync(streamPath, Buffer.concat([mkvHeader(), ...range(0, 5000)]));
      getMkvProgress(session);
      fs.writeFileSync(streamPath, Buffer.concat([mkvHeader(), ...range(0, 15000)]));
      expect(getMkvProgress(session).clusterStartsMs).toEqual([0, 5000, 10000, 15000]);
    });

    it('reports the cached base for a resume session', () => {
      const streamPath = write('r.mkv', mkvHeader(), ...range(45000, 55000));
      const session = { key: 'k', youtubeId: 'y', streamPath, durationSeconds: 100, declaredTotal: null, resumeBaseCopy: { size: 4321, mkv: { seamMs: 45000, streamSkip: null, state: 'pending' } } };
      expect(getMkvProgress(session)).toMatchObject({ cachedBytes: 4321, resumeSeamMs: 45000, resumeState: 'ok', clusterStartsMs: [45000, 50000, 55000] });
    });

    it('holds back the resume file clusters while its seam is unverified', () => {
      const session = { key: 'k', youtubeId: 'y', streamPath: write('r.mkv', mkvHeader(), ...range(30000, 40000)), durationSeconds: 100, declaredTotal: null, resumeBaseCopy: { size: 10, mkv: { seamMs: 45000, streamSkip: null, state: 'pending' } } };
      expect(getMkvProgress(session)).toMatchObject({ resumeState: 'mismatch', clusterStartsMs: [] });
    });
  });

  describe('stitchMkvResume', () => {
    const baseParts = () => [mkvHeader(), ...range(0, 40000)];
    const args = (overrides = {}) => ({
      basePath: path.join(dir, 'base.mkv'),
      resumePath: path.join(dir, 'resume.mkv'),
      outPath: path.join(dir, 'out.mkv'),
      seamMs: 45000,
      previousDurationSeconds: 60,
      ...overrides,
    });

    it('splices the resume clusters onto the base, leaving out the resume header and Cues', async () => {
      write('base.mkv', ...baseParts());
      write('resume.mkv', mkvHeader(), ...range(45000, 90000), cues());
      const result = await stitchMkvResume(args());
      const scan = scanMkv(path.join(dir, 'out.mkv'));
      expect(result).toMatchObject({ ok: true, durationSeconds: 90, clusters: 19 });
      expect(scan.clusters.map((c) => c.timecode)).toEqual(Array.from({ length: 19 }, (_, i) => i * 5000));
    });

    it('drops a truncated last resume cluster', async () => {
      const whole = cluster(95000);
      write('base.mkv', ...baseParts());
      write('resume.mkv', mkvHeader(), ...range(45000, 90000), whole.subarray(0, whole.length - 10));
      const result = await stitchMkvResume(args());
      expect(result).toMatchObject({ ok: true, durationSeconds: 90 });
    });

    it('rejects a resume that began away from the seam, as permanent', async () => {
      write('base.mkv', ...baseParts());
      write('resume.mkv', mkvHeader(), ...range(30000, 90000));
      expect(await stitchMkvResume(args())).toMatchObject({ ok: false, permanent: true });
    });

    it('rejects a resume that did not get any further than the cache, as not permanent', async () => {
      write('base.mkv', ...baseParts());
      write('resume.mkv', mkvHeader(), ...range(45000, 50000));
      expect(await stitchMkvResume(args({ previousDurationSeconds: 60 }))).toMatchObject({ ok: false, permanent: false });
    });

    it('leaves nothing at the output path when it rejects', async () => {
      write('base.mkv', ...baseParts());
      write('resume.mkv', mkvHeader(), ...range(30000, 90000));
      await stitchMkvResume(args());
      expect(fs.existsSync(path.join(dir, 'out.mkv'))).toBe(false);
    });

    it('rejects a resume file with no complete cluster', async () => {
      write('base.mkv', ...baseParts());
      write('resume.mkv', mkvHeader());
      expect(await stitchMkvResume(args())).toMatchObject({ ok: false, permanent: false });
    });
  });
});
