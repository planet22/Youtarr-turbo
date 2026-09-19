/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../playbackPlan', () => ({ getVideoDurationSeconds: jest.fn(() => Promise.resolve(null)) }));
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));
jest.mock('../paths', () => ({
  YTSTREAM_CACHE_DIR: require('path').join(require('os').tmpdir(), 'byterange-persist-test-fixed'),
}));
jest.mock('../byteRangeResume', () => ({
  RESUME_OVERLAP_SECONDS: 12,
  computeResumeFromSeconds: jest.fn(),
  probeDurationSeconds: jest.fn(),
  findCompleteBoxEnd: jest.fn(),
  stitchResumeFiles: jest.fn(),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { probeDurationSeconds } = require('../byteRangeResume');
const { PERSISTENT_CACHE_DIR } = require('../byteRangeCacheIndex');
const { persistFreshEncode, buildSessionKey, computeIdleTimeoutMs } = require('../byteRangeHlsMode');

const cacheParams = { youtubeId: 'vid00000001', quality: '1080', qualityStrictness: 'fallback', transcode: 'copy', hardwareMode: 'none', tuning: 'fast' };
const cachePath = path.join(PERSISTENT_CACHE_DIR, `${buildSessionKey(cacheParams)}.mp4`);
const metaPath = path.join(PERSISTENT_CACHE_DIR, `${buildSessionKey(cacheParams)}.json`);

describe('byteRangeHlsMode stealth cache persistence', () => {
  let sessionDir;

  const makeSession = (overrides = {}) => ({
    key: 'k',
    youtubeId: cacheParams.youtubeId,
    deliverAsFile: true,
    cacheParams,
    streamPath: path.join(sessionDir, 'stream.mp4'),
    ff: { exitCode: 0 },
    ytVideo: { exitCode: 0 },
    ytAudio: { exitCode: 0 },
    startedAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(path.dirname(PERSISTENT_CACHE_DIR), { recursive: true, force: true });
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-persist-session-'));
    fs.writeFileSync(path.join(sessionDir, 'stream.mp4'), Buffer.alloc(2048));
    probeDurationSeconds.mockResolvedValue(120);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(path.dirname(PERSISTENT_CACHE_DIR), { recursive: true, force: true });
  });

  it('installs the cache file together with a complete sidecar recording the youtubeId and duration', async () => {
    await persistFreshEncode(makeSession());
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toMatchObject({ complete: true, durationSeconds: 120, youtubeId: 'vid00000001' });
  });

  it('does not expose the cache file while the copy and duration probe are still in flight', async () => {
    let releaseProbe;
    probeDurationSeconds.mockReturnValue(new Promise((resolve) => { releaseProbe = () => resolve(120); }));
    const persisting = persistFreshEncode(makeSession());
    await new Promise((resolve) => { const poll = () => (probeDurationSeconds.mock.calls.length ? resolve() : setTimeout(poll, 5)); poll(); });
    expect(fs.existsSync(cachePath)).toBe(false);
    releaseProbe();
    await persisting;
    expect(fs.existsSync(cachePath)).toBe(true);
  });

  it('leaves no temp files behind', async () => {
    await persistFreshEncode(makeSession());
    expect(fs.readdirSync(PERSISTENT_CACHE_DIR).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  describe('when the encode was written in place (hlsStorageLocation=cache)', () => {
    let partialPath;

    const makeInPlaceSession = (overrides = {}) => {
      partialPath = path.join(PERSISTENT_CACHE_DIR, `${buildSessionKey(cacheParams)}.partial-1234abcd.mp4`);
      fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
      fs.writeFileSync(partialPath, Buffer.alloc(4096));
      return makeSession({ streamPath: partialPath, streamInCache: true, ...overrides });
    };

    it('renames the partial into the cache with its sidecar instead of copying it', async () => {
      await persistFreshEncode(makeInPlaceSession());
      expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toMatchObject({ complete: true, durationSeconds: 120, sizeBytes: 4096 });
    });

    it('leaves no in-progress file behind once installed', async () => {
      await persistFreshEncode(makeInPlaceSession());
      expect(fs.existsSync(partialPath)).toBe(false);
    });

    it('keeps the session serving from the cache file at its new path', async () => {
      const session = makeInPlaceSession();
      await persistFreshEncode(session);
      expect(session.streamPath).toBe(cachePath);
    });

    it('stops treating the session file as an in-progress partial once installed', async () => {
      const session = makeInPlaceSession();
      await persistFreshEncode(session);
      expect(session.streamInCache).toBe(false);
    });

    it('does not expose the file as a cache entry while the duration probe is still running', async () => {
      let releaseProbe;
      probeDurationSeconds.mockReturnValue(new Promise((resolve) => { releaseProbe = () => resolve(120); }));
      const persisting = persistFreshEncode(makeInPlaceSession());
      await new Promise((resolve) => { const poll = () => (probeDurationSeconds.mock.calls.length ? resolve() : setTimeout(poll, 5)); poll(); });
      expect(fs.existsSync(cachePath)).toBe(false);
      releaseProbe();
      await persisting;
    });

    it('does not overwrite a bigger existing cache entry, leaving the partial for teardown to remove', async () => {
      fs.mkdirSync(PERSISTENT_CACHE_DIR, { recursive: true });
      fs.writeFileSync(cachePath, Buffer.alloc(10000));
      const session = makeInPlaceSession();
      await persistFreshEncode(session);
      expect(fs.statSync(cachePath).size).toBe(10000);
      expect(fs.existsSync(partialPath)).toBe(true);
    });

    it('records a session cut off early as partial in the sidecar', async () => {
      await persistFreshEncode(makeInPlaceSession({ ytVideo: { exitCode: null } }));
      expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).complete).toBe(false);
    });
  });

  it('marks a cleanly finished session as persistedComplete', async () => {
    const session = makeSession();
    await persistFreshEncode(session);
    expect(session.persistedComplete).toBe(true);
  });

  it('does not mark a session whose yt-dlp child failed as persistedComplete', async () => {
    const session = makeSession({ ytVideo: { exitCode: 1 } });
    await persistFreshEncode(session);
    expect(session.persistedComplete).toBe(false);
  });

  it('does not recreate a cache entry that was cleared after the session already persisted it', async () => {
    const session = makeSession();
    await persistFreshEncode(session);
    fs.rmSync(cachePath);
    fs.rmSync(metaPath);
    await persistFreshEncode(session);
    expect(fs.existsSync(cachePath)).toBe(false);
  });
});

describe('byteRangeHlsMode.computeIdleTimeoutMs', () => {
  const finished = (extra = {}) => ({ ff: { exitCode: 0 }, startedAt: Date.now() - 60 * 60 * 1000, ...extra });

  it('reaps a finished session whose file is already in the stealth cache after a minute', () => {
    expect(computeIdleTimeoutMs(finished({ persistedComplete: true }))).toBe(60 * 1000);
  });

  it('keeps a finished session that is NOT safely cached for the long grace period', () => {
    expect(computeIdleTimeoutMs(finished())).toBe(30 * 60 * 1000);
  });

  it('gives a long-running unfinished session the base grace period', () => {
    expect(computeIdleTimeoutMs({ ff: { exitCode: null }, startedAt: Date.now() - 10 * 60 * 1000 })).toBe(2 * 60 * 1000);
  });
});

describe('byteRangeHlsMode declared length', () => {
  const { noteStreamSize, finalizeDeclaredLength, waitForDeclaredTotal, waitForSessionRange } = require('../byteRangeHlsMode');
  const MIB = 1024 * 1024;

  const newSession = (overrides = {}) => ({
    key: 'k',
    youtubeId: 'v',
    deliverAsFile: true,
    willEncode: false,
    resumeBaseCopy: null,
    failed: false,
    ff: { exitCode: null },
    sourceBytes: { video: null, audio: null },
    declaredTotal: null,
    lengthFinal: false,
    ...overrides,
  });

  describe('noteStreamSize', () => {
    it('does nothing until both stream sizes are known', () => {
      const session = newSession();
      noteStreamSize(session, 'video', '[download]   1.0% of  479.48MiB at 2MiB/s');
      expect(session.declaredTotal).toBeNull();
    });

    it('declares a total slightly above video + audio once both are known', () => {
      const session = newSession();
      noteStreamSize(session, 'video', '[download]   1.0% of  100.00MiB at 2MiB/s');
      noteStreamSize(session, 'audio', '[download]   1.0% of  10.00MiB at 2MiB/s');
      expect(session.declaredTotal).toBeGreaterThan(110 * MIB);
      expect(session.declaredTotal).toBeLessThan(113 * MIB);
    });

    it('ignores an estimated size (a ~ marks a fragmented format)', () => {
      const session = newSession();
      noteStreamSize(session, 'video', '[download]   1.0% of ~  100.00MiB at 2MiB/s');
      noteStreamSize(session, 'audio', '[download]   1.0% of  10.00MiB at 2MiB/s');
      expect(session.declaredTotal).toBeNull();
    });

    it('keeps the first exact size it saw for a stream', () => {
      const session = newSession();
      noteStreamSize(session, 'video', 'of  100.00MiB');
      noteStreamSize(session, 'video', 'of  999.00MiB');
      expect(session.sourceBytes.video).toBe(100 * MIB);
    });

    it('never declares a total for a re-encode (output size is unpredictable)', () => {
      const session = newSession({ willEncode: true });
      noteStreamSize(session, 'video', 'of  100.00MiB');
      noteStreamSize(session, 'audio', 'of  10.00MiB');
      expect(session.declaredTotal).toBeNull();
    });

    it('never declares a total for a resumed session', () => {
      const session = newSession({ resumeBaseCopy: { size: 10 } });
      noteStreamSize(session, 'video', 'of  100.00MiB');
      noteStreamSize(session, 'audio', 'of  10.00MiB');
      expect(session.declaredTotal).toBeNull();
    });

    it('never declares a total when the file is not served directly (manifest mode)', () => {
      const session = newSession({ deliverAsFile: false });
      noteStreamSize(session, 'video', 'of  100.00MiB');
      noteStreamSize(session, 'audio', 'of  10.00MiB');
      expect(session.declaredTotal).toBeNull();
    });
  });

  describe('finalizeDeclaredLength', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-declared-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    const sessionWithFile = (bytes, declaredTotal) => {
      const streamPath = path.join(dir, 'stream.mp4');
      fs.writeFileSync(streamPath, Buffer.alloc(bytes));
      return newSession({ streamPath, declaredTotal });
    };

    it('pads a cleanly finished file to exactly the declared size', () => {
      const session = sessionWithFile(1000, 5000);
      finalizeDeclaredLength(session, 0);
      expect(fs.statSync(session.streamPath).size).toBe(5000);
    });

    it('leaves a file alone when the encode did not finish cleanly', () => {
      const session = sessionWithFile(1000, 5000);
      finalizeDeclaredLength(session, 255);
      expect(fs.statSync(session.streamPath).size).toBe(1000);
    });

    it('leaves a session without a declared total alone', () => {
      const session = sessionWithFile(1000, null);
      finalizeDeclaredLength(session, 0);
      expect(fs.statSync(session.streamPath).size).toBe(1000);
    });

    it('does not shrink a file that turned out bigger than declared', () => {
      const session = sessionWithFile(6000, 5000);
      finalizeDeclaredLength(session, 0);
      expect(fs.statSync(session.streamPath).size).toBe(6000);
    });
  });

  describe('waitForSessionRange', () => {
    const growing = (dir) => {
      const streamPath = path.join(dir, 'stream.mp4');
      fs.writeFileSync(streamPath, Buffer.alloc(1000));
      return newSession({ streamPath, declaredTotal: 100 * MIB, ff: { exitCode: null } });
    };
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-wait-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('returns at once for an end-of-file probe even though the encode is far from the end', async () => {
      const startedAt = Date.now();
      await waitForSessionRange(growing(dir), { headers: { range: `bytes=${100 * MIB - 4}-` } });
      expect(Date.now() - startedAt).toBeLessThan(400);
    });

    it('does not short-circuit the end of the file for the growing-file view (declared total not passed)', async () => {
      const session = growing(dir);
      const outcome = await Promise.race([
        waitForSessionRange(session, { headers: { range: `bytes=${100 * MIB - 4}-` } }, null).then(() => 'returned'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 700)),
      ]);
      expect(outcome).toBe('still waiting');
    });

    it('returns at once for a suffix-range end-of-file probe', async () => {
      const startedAt = Date.now();
      await waitForSessionRange(growing(dir), { headers: { range: 'bytes=-4096' } });
      expect(Date.now() - startedAt).toBeLessThan(400);
    });

    it('still waits for a range in the middle of the file that is not written yet', async () => {
      const outcome = await Promise.race([
        waitForSessionRange(growing(dir), { headers: { range: `bytes=${50 * MIB}-` } }).then(() => 'returned'),
        new Promise((resolve) => setTimeout(() => resolve('still waiting'), 700)),
      ]);
      expect(outcome).toBe('still waiting');
    });
  });

  describe('waitForDeclaredTotal', () => {
    it('returns once the total has been declared', async () => {
      const session = newSession();
      setTimeout(() => { session.declaredTotal = 123; }, 20);
      await waitForDeclaredTotal(session, { timeoutMs: 2000, pollMs: 5 });
      expect(session.declaredTotal).toBe(123);
    });

    it('gives up at the timeout without a declared total', async () => {
      const session = newSession();
      await waitForDeclaredTotal(session, { timeoutMs: 30, pollMs: 5 });
      expect(session.declaredTotal).toBeNull();
    });

    it('does not wait at all for a re-encode', async () => {
      const startedAt = Date.now();
      await waitForDeclaredTotal(newSession({ willEncode: true }), { timeoutMs: 2000, pollMs: 5 });
      expect(Date.now() - startedAt).toBeLessThan(500);
    });

    it('stops waiting when the session fails', async () => {
      const startedAt = Date.now();
      await waitForDeclaredTotal(newSession({ failed: true }), { timeoutMs: 2000, pollMs: 5 });
      expect(Date.now() - startedAt).toBeLessThan(500);
    });
  });
});

describe('byteRangeHlsMode header duration', () => {
  const { applyHeaderDuration, waitForHeaderDuration, noteFfmpegDuration } = require('../byteRangeHlsMode');
  const { parseInitBoxes } = require('../byteRangeHeaderDuration');

  const box = (type, payload) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
  };
  const initSegment = () => {
    const mvhdPayload = Buffer.alloc(100);
    mvhdPayload.writeUInt32BE(1000, 12);
    const mehdPayload = Buffer.alloc(12);
    mehdPayload[0] = 1;
    const mvex = box('mvex', Buffer.concat([box('mehd', mehdPayload), box('trex', Buffer.alloc(24))]));
    return Buffer.concat([box('ftyp', Buffer.from('iso5....')), box('moov', Buffer.concat([box('mvhd', mvhdPayload), mvex]))]);
  };

  let dir;
  let streamPath;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-hdrdur-'));
    streamPath = path.join(dir, 'stream.mp4');
    fs.writeFileSync(streamPath, initSegment());
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const session = (overrides = {}) => ({
    key: 'k', youtubeId: 'v', deliverAsFile: true, resumeBaseCopy: null, streamPath,
    durationSeconds: 120, durationPromise: null, headerDurationDone: false, ...overrides,
  });

  it('writes the known duration into the file header', () => {
    applyHeaderDuration(session());
    const head = fs.readFileSync(streamPath);
    expect(head.readUInt32BE(parseInitBoxes(head).mvhd.durationOffset)).toBe(120000);
  });

  it('marks the session done so the header is only written once', () => {
    const s = session();
    applyHeaderDuration(s);
    expect(s.headerDurationDone).toBe(true);
  });

  it('does nothing until the duration is known', () => {
    const s = session({ durationSeconds: null });
    applyHeaderDuration(s);
    expect(s.headerDurationDone).toBe(false);
  });

  it('leaves the session open to retry while the init segment is not written yet', () => {
    fs.writeFileSync(streamPath, initSegment().subarray(0, 30));
    const s = session();
    applyHeaderDuration(s);
    expect(s.headerDurationDone).toBe(false);
  });

  it('never touches a resume session', () => {
    const s = session({ resumeBaseCopy: { size: 1 } });
    applyHeaderDuration(s);
    expect(s.headerDurationDone).toBe(false);
  });

  it('waits for a duration to arrive before patching', async () => {
    const s = session({ durationSeconds: null });
    setTimeout(() => { s.durationSeconds = 60; }, 20);
    await waitForHeaderDuration(s, 2000);
    expect(s.headerDurationDone).toBe(true);
  });

  it('gives up waiting after the timeout when no duration arrives', async () => {
    const s = session({ durationSeconds: null });
    const startedAt = Date.now();
    await waitForHeaderDuration(s, 40);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  describe('noteFfmpegDuration', () => {
    const inputs = (a, b) => `Input #0, mov,mp4, from 'pipe:3':\n  Duration: ${a}, start: 0.0\nInput #1, mov,mp4, from 'pipe:4':\n  Duration: ${b}, start: 0.0\n`;
    const fresh = (overrides = {}) => session({ durationSeconds: null, ffDurations: [], durationSource: null, ...overrides });

    it('takes the longer of the two inputs as the duration', () => {
      const s = fresh();
      noteFfmpegDuration(s, inputs('00:00:10.00', '00:00:10.50'));
      expect(s.durationSeconds).toBe(10.5);
    });

    it('records that the duration came from ffmpeg', () => {
      const s = fresh();
      noteFfmpegDuration(s, inputs('00:00:10.00', '00:00:10.50'));
      expect(s.durationSource).toBe('ffmpeg');
    });

    it('writes the header as soon as both inputs have reported', () => {
      const s = fresh();
      noteFfmpegDuration(s, inputs('00:02:00.00', '00:02:00.00'));
      expect(s.headerDurationDone).toBe(true);
    });

    it('waits for the second input when they arrive in separate chunks', () => {
      const s = fresh();
      noteFfmpegDuration(s, 'Input #0:\n  Duration: 00:02:00.00, start: 0\n');
      expect(s.durationSeconds).toBeNull();
      noteFfmpegDuration(s, 'Input #1:\n  Duration: 00:02:00.10, start: 0\n');
      expect(s.durationSeconds).toBe(120.1);
    });

    it('does not override a duration that is already known', () => {
      const s = fresh({ durationSeconds: 99, durationSource: 'metadata' });
      noteFfmpegDuration(s, inputs('00:00:10.00', '00:00:10.50'));
      expect(s.durationSeconds).toBe(99);
    });

    it('ignores a resume session', () => {
      const s = fresh({ resumeBaseCopy: { size: 1 } });
      noteFfmpegDuration(s, inputs('00:00:10.00', '00:00:10.50'));
      expect(s.durationSeconds).toBeNull();
    });
  });
});
