const path = require('path');
const os = require('os');
const fs = require('fs');

// hlsEngine.js requires a large set of submodules at load time - mirrors the
// exact mock set server/routes/__tests__/ytstream.test.js already uses to
// safely require this same file transitively (via routes/ytstream.js),
// proven sufficient there (46 passing tests) to avoid real process spawns,
// config file watchers, etc.
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

jest.mock('../../../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../configModule', () => ({
  getConfig: jest.fn().mockReturnValue({}),
  getCookiesPath: jest.fn().mockReturnValue(null),
  directoryPath: '',
}));

jest.mock('../../youtubeMetadataCache', () => ({
  clearCachedEntry: jest.fn(),
  countCached: jest.fn(),
  clearAll: jest.fn(),
  YOUTUBE_METADATA_CACHE_RETENTION_DAYS: 365,
}));

const { maybeCleanupBufferDir, createBufferFinalizeHandoff } = require('../hlsEngine');

// These two functions are the fix for a real production race: hls-buffer's
// independent download-fetch used to rename/unlink session.bufferTempPath
// the instant it finished, even while the live session's own encode side
// could have a seek-restart pass already spawned with `-i bufferTempPath`
// that hadn't actually opened the file yet (ffmpeg startup lag) - confirmed
// live as an ENOENT mid-seek. The fix: finalize a hard-linked/copied
// handoff instead of the original (createBufferFinalizeHandoff), and only
// actually delete the scratch dir once both the fetch has settled and the
// session has been torn down (maybeCleanupBufferDir) - see hlsEngine.js's
// own doc comments on both functions for the full story.
describe('hlsEngine buffer-finalize race fix', () => {
  let bufferDir;
  let bufferTempPath;

  beforeEach(() => {
    bufferDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-buffer-test-'));
    bufferTempPath = path.join(bufferDir, 'buffer.ts');
    fs.writeFileSync(bufferTempPath, 'fake mpegts bytes');
  });

  afterEach(() => {
    fs.rmSync(bufferDir, { recursive: true, force: true });
  });

  describe('maybeCleanupBufferDir', () => {
    function buildSession(overrides = {}) {
      return { bufferDir, bufferFetchSettled: false, hlsTornDown: false, ...overrides };
    }

    it('does not delete bufferDir when neither the fetch nor the session has settled', () => {
      maybeCleanupBufferDir(buildSession());
      expect(fs.existsSync(bufferDir)).toBe(true);
    });

    it('does not delete bufferDir when only the fetch has settled', () => {
      maybeCleanupBufferDir(buildSession({ bufferFetchSettled: true }));
      expect(fs.existsSync(bufferDir)).toBe(true);
    });

    it('does not delete bufferDir when only the session has been torn down', () => {
      maybeCleanupBufferDir(buildSession({ hlsTornDown: true }));
      expect(fs.existsSync(bufferDir)).toBe(true);
    });

    it('deletes bufferDir once both the fetch has settled and the session has been torn down', (done) => {
      maybeCleanupBufferDir(buildSession({ bufferFetchSettled: true, hlsTornDown: true }));
      // fs.rm's callback is async - poll briefly rather than asserting
      // synchronously against a fire-and-forget deletion.
      setTimeout(() => {
        expect(fs.existsSync(bufferDir)).toBe(false);
        done();
      }, 50);
    });

    it('does nothing when the session never had a bufferDir', () => {
      expect(() => maybeCleanupBufferDir({ bufferDir: null, bufferFetchSettled: true, hlsTornDown: true })).not.toThrow();
    });
  });

  describe('createBufferFinalizeHandoff', () => {
    it('returns a handoff path (not bufferTempPath itself) whose data matches the original', async () => {
      const session = { bufferDir, bufferTempPath };
      const handoffPath = await createBufferFinalizeHandoff(session, { sessionKey: 'test', youtubeId: 'abc123' });

      expect(handoffPath).not.toBe(bufferTempPath);
      expect(fs.existsSync(handoffPath)).toBe(true);
      expect(fs.readFileSync(handoffPath, 'utf8')).toBe('fake mpegts bytes');
    });

    it('leaves the original bufferTempPath fully intact and readable', async () => {
      const session = { bufferDir, bufferTempPath };
      await createBufferFinalizeHandoff(session, { sessionKey: 'test', youtubeId: 'abc123' });

      expect(fs.existsSync(bufferTempPath)).toBe(true);
      expect(fs.readFileSync(bufferTempPath, 'utf8')).toBe('fake mpegts bytes');
    });

    it('renaming the handoff path away never affects the original (hard-link semantics)', async () => {
      const session = { bufferDir, bufferTempPath };
      const handoffPath = await createBufferFinalizeHandoff(session, { sessionKey: 'test', youtubeId: 'abc123' });

      // Simulates finalizeTapOutput renaming its `tempPath` argument to the
      // real final location - the exact operation that used to yank the
      // file out from under an in-flight seek-restart pass.
      const finalPath = path.join(bufferDir, 'finalized.ts');
      fs.renameSync(handoffPath, finalPath);

      expect(fs.existsSync(bufferTempPath)).toBe(true);
      expect(fs.readFileSync(bufferTempPath, 'utf8')).toBe('fake mpegts bytes');
      expect(fs.existsSync(finalPath)).toBe(true);
    });
  });
});
