/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../playbackPlan', () => ({ getVideoDurationSeconds: jest.fn(() => Promise.resolve(null)) }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { resolveVirtualRange, serveResumeAwareRange } = require('../byteRangeServe');
const { noteStreamSize, finalizeDeclaredLength, waitForHeaderDuration, waitForDeclaredTotal } = require('../byteRangeHlsMode');

const MIB = 1024 * 1024;
const PROGRESS = (size) => `[download]  10.0% of  ${size}MiB at   5.00MiB/s ETA 00:10`;

describe('resolveVirtualRange with a declared total', () => {
  const sizes = { baseSize: 1000, streamSize: 500, declaredTotal: 10000 };

  it('reads the range against the declared total', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=100-199' })).toMatchObject({ total: 10000, start: 100, end: 199 });
  });

  it('sends only what is written when the range asks for more', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=1200-' })).toMatchObject({ source: 'stream', srcStart: 200, srcEnd: 499, end: 1499, total: 10000 });
  });

  it('has nothing for a start that is declared but not written yet', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=5000-' })).toBeNull();
  });

  it('accepts a start beyond the declared total as unsatisfiable', () => {
    expect(resolveVirtualRange({ ...sizes, rangeHeader: 'bytes=20000-' })).toBeNull();
  });

  it('behaves as before without a declared total', () => {
    expect(resolveVirtualRange({ baseSize: 1000, streamSize: 500, rangeHeader: 'bytes=1000-' })).toMatchObject({ total: 1500, end: 1499 });
  });
});

describe('serveResumeAwareRange with a declared total', () => {
  let dir;
  let basePath;
  let streamPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-declared-'));
    basePath = path.join(dir, 'base.mkv');
    streamPath = path.join(dir, 'stream.mkv');
    fs.writeFileSync(basePath, Buffer.from('B'.repeat(1000)));
    fs.writeFileSync(streamPath, Buffer.from('S'.repeat(500)));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const session = () => ({ key: 'k', streamPath, contentType: 'video/x-matroska', resumeBaseCopy: { path: basePath, size: 1000 } });

  function mockRes() {
    const chunks = [];
    const res = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    res.headers = {};
    res.statusCode = null;
    res.set = jest.fn((nameOrObj, value) => {
      if (typeof nameOrObj === 'string') res.headers[nameOrObj.toLowerCase()] = value;
      else Object.entries(nameOrObj).forEach(([k, v]) => { res.headers[k.toLowerCase()] = v; });
      return res;
    });
    res.status = jest.fn((code) => { res.statusCode = code; return res; });
    return res;
  }
  const finished = (res) => new Promise((resolve) => res.on('finish', resolve));

  it('reports the declared total in Content-Range', async () => {
    const res = mockRes();
    serveResumeAwareRange(session(), { headers: { range: 'bytes=0-9' } }, res, undefined, undefined, 10000);
    await finished(res);
    expect(res.headers['content-range']).toBe('bytes 0-9/10000');
  });

  it('serves the written part of the resume file for a range that runs past it', async () => {
    const res = mockRes();
    serveResumeAwareRange(session(), { headers: { range: 'bytes=1200-' } }, res, undefined, undefined, 10000);
    await finished(res);
    expect(res.headers['content-range']).toBe('bytes 1200-1499/10000');
  });

  it('answers 416 with the declared total for a start that is not written yet', () => {
    const res = mockRes();
    res.end = jest.fn();
    serveResumeAwareRange(session(), { headers: { range: 'bytes=5000-' } }, res, undefined, undefined, 10000);
    expect([res.statusCode, res.headers['content-range']]).toEqual([416, 'bytes */10000']);
  });

  it('still reports the growing size without a declared total', async () => {
    const res = mockRes();
    serveResumeAwareRange(session(), { headers: { range: 'bytes=0-9' } }, res);
    await finished(res);
    expect(res.headers['content-range']).toBe('bytes 0-9/1500');
  });
});

describe('noteStreamSize for resume sessions', () => {
  const resumeSession = (overrides = {}) => ({
    key: 'k', youtubeId: 'y', deliverAsFile: true, willEncode: false, declaredTotal: null, sourceBytes: { video: null, audio: null },
    resumeBaseCopy: { size: 1000 }, ...overrides,
  });

  it('declares the final size for an mkv resume, which downloads the whole stream', () => {
    const session = resumeSession({ isMkv: true });
    noteStreamSize(session, 'video', PROGRESS(100));
    noteStreamSize(session, 'audio', PROGRESS(10));
    expect(session.declaredTotal).toBeGreaterThan(110 * MIB);
  });

  it('leaves an mp4 resume without a declared total', () => {
    const session = resumeSession({ isMkv: false });
    noteStreamSize(session, 'video', PROGRESS(100));
    noteStreamSize(session, 'audio', PROGRESS(10));
    expect(session.declaredTotal).toBeNull();
  });
});

describe('waitForDeclaredTotal for resume sessions', () => {
  const base = { deliverAsFile: true, willEncode: false, declaredTotal: null, failed: false, ff: { exitCode: null }, resumeBaseCopy: { size: 1 } };

  it('waits for an mkv resume, like a fresh session', async () => {
    const session = { ...base, isMkv: true };
    setTimeout(() => { session.declaredTotal = 5; }, 30);
    await waitForDeclaredTotal(session, { timeoutMs: 1000, pollMs: 5 });
    expect(session.declaredTotal).toBe(5);
  });

  it('does not wait for an mp4 resume', async () => {
    const startedAt = Date.now();
    await waitForDeclaredTotal({ ...base, isMkv: false }, { timeoutMs: 1000, pollMs: 5 });
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});

describe('waitForHeaderDuration for resume sessions', () => {
  it('returns at once, since the header is already in the cached base', async () => {
    const startedAt = Date.now();
    await waitForHeaderDuration({ resumeBaseCopy: { size: 1 }, durationSeconds: null, headerDurationDone: false, failed: false, deliverAsFile: true }, 1000);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});

describe('finalizeDeclaredLength for an mkv resume', () => {
  let dir;
  let streamPath;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-finalize-'));
    streamPath = path.join(dir, 'stream.mkv');
    fs.writeFileSync(streamPath, Buffer.alloc(5000, 1));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const session = (overrides = {}) => ({
    key: 'k', youtubeId: 'y', isMkv: true, streamPath, declaredTotal: 9000,
    resumeBaseCopy: { size: 2000, mkv: { state: 'ok', streamSkip: 1500 } }, ...overrides,
  });

  it('pads the resume file so the virtual file (base + resume from its seam) is the declared total', () => {
    finalizeDeclaredLength(session(), 0);
    // virtual = base 2000 + (resume - skip 1500) must be 9000  ->  resume = 8500
    expect(fs.statSync(streamPath).size).toBe(8500);
  });

  it('leaves the file alone when the seam was never verified', () => {
    finalizeDeclaredLength(session({ resumeBaseCopy: { size: 2000, mkv: { state: 'pending', streamSkip: null } } }), 0);
    expect(fs.statSync(streamPath).size).toBe(5000);
  });

  it('leaves the file alone when the encode did not end cleanly', () => {
    finalizeDeclaredLength(session(), 1);
    expect(fs.statSync(streamPath).size).toBe(5000);
  });

  it('pads a fresh (non-resume) session to the declared total as before', () => {
    finalizeDeclaredLength({ key: 'k', youtubeId: 'y', isMkv: true, streamPath, declaredTotal: 7000, resumeBaseCopy: null }, 0);
    expect(fs.statSync(streamPath).size).toBe(7000);
  });
});
