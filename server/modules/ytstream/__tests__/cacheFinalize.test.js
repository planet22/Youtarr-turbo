/* eslint-env jest */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

jest.mock('../../../logger');
jest.mock('../../configModule', () => ({ getConfig: jest.fn() }));
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('../videoResolution', () => ({ resolveVideoTargetResolution: jest.fn() }));
jest.mock('../untrackedBufferCache', () => ({
  findWarmUntrackedBufferCache: jest.fn(),
  getUntrackedBufferCacheMp4Path: jest.fn(),
}));
jest.mock('../../tsRemuxCache', () => ({ findExistingSeekableMp4: jest.fn(), ensureSeekableMp4: jest.fn() }));
jest.mock('../../../models/video', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/job', () => ({ create: jest.fn() }));
jest.mock('../../videoPersistence', () => ({ upsertVideoForJob: jest.fn() }));
jest.mock('../../jobModule', () => ({ jobs: {} }));
jest.mock('../../ytstreamTapFinalizer', () => ({ recordTsToMp4Finalize: jest.fn() }));

const logger = require('../../../logger');
const configModule = require('../../configModule');
const { resolveVideoTargetResolution } = require('../videoResolution');
const { findWarmUntrackedBufferCache, getUntrackedBufferCacheMp4Path } = require('../untrackedBufferCache');
const tsRemuxCache = require('../../tsRemuxCache');
const Video = require('../../../models/video');
const Job = require('../../../models/job');
const videoPersistence = require('../../videoPersistence');
const jobModule = require('../../jobModule');
const { recordTsToMp4Finalize } = require('../../ytstreamTapFinalizer');
const {
  resolveActualServedFileInfo,
  tryServeCachedVideoFile,
  findExistingCachedVideoFilePath,
  createCacheFinalize,
} = require('../cacheFinalize');

const YT_ID = 'dQw4w9WgXcQ';
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('cacheFinalize', () => {
  let workDir;

  const writeFile = (name, contents = 'x') => {
    const filePath = path.join(workDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return filePath;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-finalize-'));
    configModule.getConfig.mockReturnValue({});
    Object.keys(jobModule.jobs).forEach((k) => delete jobModule.jobs[k]);
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('resolveActualServedFileInfo', () => {
    it('reports the file real height, container and a copy transcode', async () => {
      resolveVideoTargetResolution.mockResolvedValue({ width: 1920, height: 1080 });

      await expect(resolveActualServedFileInfo(YT_ID, '/lib/Video.MKV', {})).resolves.toEqual({ quality: '1080', container: 'mkv', transcode: 'copy' });
    });

    it('passes the models through to the resolution lookup', async () => {
      resolveVideoTargetResolution.mockResolvedValue({ height: 720 });
      const models = {};

      await resolveActualServedFileInfo(YT_ID, '/lib/v.mp4', models);

      expect(resolveVideoTargetResolution).toHaveBeenCalledWith(YT_ID, models);
    });

    it('has no quality when the height is unknown', async () => {
      resolveVideoTargetResolution.mockResolvedValue({});

      expect((await resolveActualServedFileInfo(YT_ID, '/lib/v.mp4', {})).quality).toBeNull();
    });

    it('has no container for a file with no extension', async () => {
      resolveVideoTargetResolution.mockResolvedValue({ height: 1 });

      expect((await resolveActualServedFileInfo(YT_ID, '/lib/video', {})).container).toBeNull();
    });
  });

  describe('tryServeCachedVideoFile', () => {
    function makeRes() {
      const res = new PassThrough();
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.headers = {};
      res.statusCode = 200;
      res.status = jest.fn((code) => { res.statusCode = code; return res; });
      res.set = jest.fn((h, v) => { Object.assign(res.headers, typeof h === 'string' ? { [h]: v } : h); return res; });
      res.body = () => Buffer.concat(chunks).toString('utf8');
      return res;
    }
    const req = (headers = {}, method = 'GET') => ({ headers, method });

    it('returns false and warns when the file cannot be read', async () => {
      const res = makeRes();

      await expect(tryServeCachedVideoFile(req(), res, path.join(workDir, 'missing.mp4'))).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('serves the whole file with its headers', async () => {
      const file = writeFile('v.mp4', '0123456789');
      const res = makeRes();

      await expect(tryServeCachedVideoFile(req(), res, file)).resolves.toBe(true);

      expect(res.headers).toMatchObject({ 'Content-Type': 'video/mp4', 'Content-Length': '10', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      expect(res.body()).toBe('0123456789');
    });

    it.each([
      ['v.mkv', 'video/x-matroska'],
      ['v.webm', 'video/webm'],
      ['v.ts', 'video/mp2t'],
      ['v.mp4', 'video/mp4'],
      ['v.avi', 'video/mp4'],
    ])('sends %s as %s', async (name, contentType) => {
      const res = makeRes();

      await tryServeCachedVideoFile(req(), res, writeFile(name));

      expect(res.headers['Content-Type']).toBe(contentType);
    });

    it('reports every byte sent to the counter', async () => {
      const onBytesSent = jest.fn();

      await tryServeCachedVideoFile(req(), makeRes(), writeFile('v.mp4', '0123456789'), onBytesSent);

      expect(onBytesSent.mock.calls.reduce((sum, [n]) => sum + n, 0)).toBe(10);
    });

    it('sends headers only for a HEAD request', async () => {
      const res = makeRes();

      await expect(tryServeCachedVideoFile(req({}, 'HEAD'), res, writeFile('v.mp4', 'abc'))).resolves.toBe(true);
      await tick();

      expect(res.headers['Content-Length']).toBe('3');
      expect(res.body()).toBe('');
    });

    it('prefers an existing mp4 remux over a raw .ts', async () => {
      const ts = writeFile('v.ts', 'raw-ts');
      const mp4 = writeFile('remux.mp4', 'remuxed');
      tsRemuxCache.findExistingSeekableMp4.mockReturnValue(mp4);
      const res = makeRes();

      await tryServeCachedVideoFile(req(), res, ts);

      expect(res.body()).toBe('remuxed');
      expect(res.headers['Content-Type']).toBe('video/mp4');
    });

    it('serves the .ts itself when no remux exists', async () => {
      tsRemuxCache.findExistingSeekableMp4.mockReturnValue(null);
      const res = makeRes();

      await tryServeCachedVideoFile(req(), res, writeFile('v.ts', 'raw-ts'));

      expect(res.body()).toBe('raw-ts');
    });

    describe('range requests', () => {
      let file;

      beforeEach(() => {
        file = writeFile('v.mp4', '0123456789');
      });

      it('serves an explicit range with partial-content headers', async () => {
        const res = makeRes();

        await tryServeCachedVideoFile(req({ range: 'bytes=2-5' }), res, file);

        expect(res.status).toHaveBeenCalledWith(206);
        expect(res.headers).toMatchObject({ 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' });
        expect(res.body()).toBe('2345');
      });

      it('serves from an offset to the end for an open-ended range', async () => {
        const res = makeRes();

        await tryServeCachedVideoFile(req({ range: 'bytes=7-' }), res, file);

        expect(res.headers['Content-Range']).toBe('bytes 7-9/10');
        expect(res.body()).toBe('789');
      });

      it('serves the last N bytes for a suffix range', async () => {
        const res = makeRes();

        await tryServeCachedVideoFile(req({ range: 'bytes=-3' }), res, file);

        expect(res.headers['Content-Range']).toBe('bytes 7-9/10');
        expect(res.body()).toBe('789');
      });

      it('clamps a suffix longer than the file to the whole file', async () => {
        const res = makeRes();

        await tryServeCachedVideoFile(req({ range: 'bytes=-500' }), res, file);

        expect(res.headers['Content-Range']).toBe('bytes 0-9/10');
      });

      it('clamps an end past the file size', async () => {
        const res = makeRes();

        await tryServeCachedVideoFile(req({ range: 'bytes=5-500' }), res, file);

        expect(res.headers['Content-Range']).toBe('bytes 5-9/10');
      });

      it.each(['bytes=abc', 'items=0-5', 'bytes=-', 'bytes=1-2,4-5'])('rejects the malformed range %s with 416', async (range) => {
        const res = makeRes();

        await expect(tryServeCachedVideoFile(req({ range }), res, file)).resolves.toBe(true);

        expect(res.status).toHaveBeenCalledWith(416);
        expect(res.headers['Content-Range']).toBe('bytes */10');
      });

      it.each(['bytes=10-', 'bytes=50-60', 'bytes=6-3'])('rejects the unsatisfiable range %s with 416', async (range) => {
        const res = makeRes();

        await tryServeCachedVideoFile(req({ range }), res, file);

        expect(res.status).toHaveBeenCalledWith(416);
      });

      it('sends headers only for a ranged HEAD request', async () => {
        const res = makeRes();

        await tryServeCachedVideoFile(req({ range: 'bytes=0-3' }, 'HEAD'), res, file);
        await tick();

        expect(res.status).toHaveBeenCalledWith(206);
        expect(res.body()).toBe('');
      });

      it('reports ranged bytes to the counter', async () => {
        const onBytesSent = jest.fn();

        await tryServeCachedVideoFile(req({ range: 'bytes=0-3' }), makeRes(), file, onBytesSent);

        expect(onBytesSent.mock.calls.reduce((sum, [n]) => sum + n, 0)).toBe(4);
      });
    });
  });

  describe('findExistingCachedVideoFilePath', () => {
    const models = (video) => ({ Video: { findOne: jest.fn().mockResolvedValue(video) } });

    it('prefers a warm untracked buffer cache', async () => {
      findWarmUntrackedBufferCache.mockReturnValue('/cache/x.ts');

      await expect(findExistingCachedVideoFilePath(YT_ID, models(null))).resolves.toBe('/cache/x.ts');
    });

    it('returns a real downloaded library file', async () => {
      const file = writeFile('real.mp4');
      findWarmUntrackedBufferCache.mockReturnValue(null);

      await expect(findExistingCachedVideoFilePath(YT_ID, models({ is_strm: false, filePath: file }))).resolves.toBe(file);
    });

    it.each([
      ['a STRM row', { is_strm: true, filePath: '/x.strm' }],
      ['a row with no file path', { is_strm: false, filePath: null }],
      ['no row', null],
    ])('returns null for %s', async (_label, video) => {
      findWarmUntrackedBufferCache.mockReturnValue(null);

      await expect(findExistingCachedVideoFilePath(YT_ID, models(video))).resolves.toBeNull();
    });

    it('returns null when the library file is missing on disk', async () => {
      findWarmUntrackedBufferCache.mockReturnValue(null);

      await expect(findExistingCachedVideoFilePath(YT_ID, models({ is_strm: false, filePath: path.join(workDir, 'gone.mp4') }))).resolves.toBeNull();
    });

    it('returns null without a Video model', async () => {
      findWarmUntrackedBufferCache.mockReturnValue(null);

      await expect(findExistingCachedVideoFilePath(YT_ID, undefined)).resolves.toBeNull();
      await expect(findExistingCachedVideoFilePath(YT_ID, {})).resolves.toBeNull();
    });

    it('returns null and warns when the lookup throws', async () => {
      findWarmUntrackedBufferCache.mockReturnValue(null);
      const failing = { Video: { findOne: jest.fn().mockRejectedValue(new Error('db down')) } };

      await expect(findExistingCachedVideoFilePath(YT_ID, failing)).resolves.toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('createCacheFinalize', () => {
    let hlsSessions;
    let fin;

    beforeEach(() => {
      hlsSessions = new Map();
      fin = createCacheFinalize({ hlsSessions });
    });

    describe('findLiveSessionReferencing', () => {
      it('finds a live session using the file', () => {
        const session = { key: 's1', cachedFilePath: '/c/x.ts', destroying: false };
        hlsSessions.set('s1', session);

        expect(fin.findLiveSessionReferencing('/c/x.ts')).toBe(session);
      });

      it('ignores a session being destroyed', () => {
        hlsSessions.set('s1', { key: 's1', cachedFilePath: '/c/x.ts', destroying: true });

        expect(fin.findLiveSessionReferencing('/c/x.ts')).toBeNull();
      });

      it('ignores sessions using another file', () => {
        hlsSessions.set('s1', { key: 's1', cachedFilePath: '/c/y.ts', destroying: false });

        expect(fin.findLiveSessionReferencing('/c/x.ts')).toBeNull();
      });
    });

    describe('trySafeDeleteFinalizedTs', () => {
      it('deletes the .ts when nothing references it', async () => {
        const ts = writeFile('x.ts');

        fin.trySafeDeleteFinalizedTs(ts, {});
        await tick();

        expect(fs.existsSync(ts)).toBe(false);
      });

      it('keeps it while a live session still references it', async () => {
        const ts = writeFile('x.ts');
        hlsSessions.set('s1', { key: 's1', cachedFilePath: ts, destroying: false });

        fin.trySafeDeleteFinalizedTs(ts, {});
        await tick();

        expect(fs.existsSync(ts)).toBe(true);
      });

      it('does not warn when the file is already gone', async () => {
        fin.trySafeDeleteFinalizedTs(path.join(workDir, 'gone.ts'), {});
        await tick();

        expect(logger.warn).not.toHaveBeenCalled();
      });

      it('warns when deleting fails for another reason', () => {
        jest.spyOn(fs, 'unlink').mockImplementation((_p, cb) => cb(Object.assign(new Error('busy'), { code: 'EBUSY' })));

        fin.trySafeDeleteFinalizedTs('/x.ts', {});

        expect(logger.warn).toHaveBeenCalled();
      });
    });

    describe('promoteFinalizedTsToLibraryMp4', () => {
      it('does nothing while a live session references the .ts', async () => {
        const ts = writeFile('lib/x.ts');
        const mp4 = writeFile('cache/x.mp4', 'mp4');
        hlsSessions.set('s1', { key: 's1', cachedFilePath: ts, destroying: false });

        await fin.promoteFinalizedTsToLibraryMp4(YT_ID, ts, mp4, {});

        expect(Video.findOne).not.toHaveBeenCalled();
        expect(fs.existsSync(ts)).toBe(true);
      });

      it('just deletes the .ts when no library row points at it', async () => {
        const ts = writeFile('lib/x.ts');
        const mp4 = writeFile('cache/x.mp4', 'mp4');
        Video.findOne.mockResolvedValue(null);

        await fin.promoteFinalizedTsToLibraryMp4(YT_ID, ts, mp4, {});
        await tick();

        expect(fs.existsSync(ts)).toBe(false);
        expect(fs.existsSync(mp4)).toBe(true);
      });

      it('moves the remux beside the .ts, repoints the video and removes the .ts', async () => {
        const ts = writeFile('lib/x.ts');
        const mp4 = writeFile('cache/x.mp4', 'mp4-bytes');
        const video = { update: jest.fn().mockResolvedValue(undefined) };
        Video.findOne.mockResolvedValue(video);

        await fin.promoteFinalizedTsToLibraryMp4(YT_ID, ts, mp4, {});
        await tick();

        const libraryMp4 = path.join(workDir, 'lib', 'x.mp4');
        expect(Video.findOne).toHaveBeenCalledWith({ where: { youtubeId: YT_ID, filePath: ts } });
        expect(fs.readFileSync(libraryMp4, 'utf8')).toBe('mp4-bytes');
        expect(video.update).toHaveBeenCalledWith({ filePath: libraryMp4, fileSize: 9 });
        expect(fs.existsSync(ts)).toBe(false);
      });

      it('copies across filesystems when a rename is not possible', async () => {
        const ts = writeFile('lib/x.ts');
        const mp4 = writeFile('cache/x.mp4', 'mp4-bytes');
        Video.findOne.mockResolvedValue({ update: jest.fn().mockResolvedValue(undefined) });
        jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); });

        await fin.promoteFinalizedTsToLibraryMp4(YT_ID, ts, mp4, {});

        expect(fs.readFileSync(path.join(workDir, 'lib', 'x.mp4'), 'utf8')).toBe('mp4-bytes');
        expect(fs.existsSync(mp4)).toBe(false);
      });

      it('leaves everything as it was and warns when it fails', async () => {
        const ts = writeFile('lib/x.ts');
        const mp4 = writeFile('cache/x.mp4');
        Video.findOne.mockRejectedValue(new Error('db down'));

        await fin.promoteFinalizedTsToLibraryMp4(YT_ID, ts, mp4, {});

        expect(fs.existsSync(ts)).toBe(true);
        expect(logger.warn).toHaveBeenCalled();
      });
    });

    describe('promoteHiddenMp4ToLibrary', () => {
      const setup = () => {
        const hiddenTs = writeFile('hidden/x.ts');
        const mp4 = writeFile('cache/x.mp4', 'mp4-bytes');
        return { hiddenTs, mp4 };
      };

      beforeEach(() => {
        Job.create.mockImplementation(async (data) => ({ id: 77, ...data }));
        videoPersistence.upsertVideoForJob.mockResolvedValue({ id: 5 });
      });

      it('does nothing while a live session references the hidden .ts', async () => {
        const { hiddenTs, mp4 } = setup();
        hlsSessions.set('s1', { key: 's1', cachedFilePath: hiddenTs, destroying: false });

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});

        expect(Video.findOne).not.toHaveBeenCalled();
      });

      it.each([
        ['no STRM row is left', null],
        ['the row has no file path', { filePath: null }],
      ])('does nothing when %s', async (_label, video) => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue(video);

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});

        expect(Job.create).not.toHaveBeenCalled();
        expect(fs.existsSync(hiddenTs)).toBe(true);
      });

      it('looks for the still-STRM row of this video', async () => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue(null);

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});

        expect(Video.findOne).toHaveBeenCalledWith({ where: { youtubeId: YT_ID, is_strm: true } });
      });

      it('places the mp4 beside the .strm under the same stem', async () => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue({ filePath: path.join(workDir, 'lib', 'Show', 'Ep.strm') });

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});

        expect(fs.readFileSync(path.join(workDir, 'lib', 'Show', 'Ep.mp4'), 'utf8')).toBe('mp4-bytes');
      });

      it('records a completed job and upserts the video as a real file', async () => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue({ filePath: path.join(workDir, 'lib', 'Ep.strm') });

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});

        expect(Job.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'Complete', jobType: `HLS Buffer Cache: ${YT_ID}` }));
        expect(videoPersistence.upsertVideoForJob).toHaveBeenCalledWith(
          { youtubeId: YT_ID, filePath: path.join(workDir, 'lib', 'Ep.mp4'), fileSize: 9, is_strm: false },
          expect.objectContaining({ id: 77 }),
          true
        );
      });

      it('registers the job so Download History shows it immediately', async () => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue({ filePath: path.join(workDir, 'lib', 'Ep.strm') });

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});

        expect(jobModule.jobs[77]).toMatchObject({ id: 77, data: { videos: [{ id: 5 }] } });
      });

      it('never deletes the hidden .ts', async () => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue({ filePath: path.join(workDir, 'lib', 'Ep.strm') });

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});
        await tick();

        expect(fs.existsSync(hiddenTs)).toBe(true);
      });

      it('copies across filesystems when a rename is not possible', async () => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue({ filePath: path.join(workDir, 'lib', 'Ep.strm') });
        jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); });

        await fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {});

        expect(fs.existsSync(path.join(workDir, 'lib', 'Ep.mp4'))).toBe(true);
        expect(fs.existsSync(mp4)).toBe(false);
      });

      it('warns and leaves things alone when it fails', async () => {
        const { hiddenTs, mp4 } = setup();
        Video.findOne.mockResolvedValue({ filePath: path.join(workDir, 'lib', 'Ep.strm') });
        Job.create.mockRejectedValue(new Error('db down'));

        await expect(fin.promoteHiddenMp4ToLibrary(YT_ID, hiddenTs, mp4, {})).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalled();
      });
    });

    describe('swapHiddenCacheToMp4', () => {
      let hiddenTs;
      let mp4;
      let hiddenMp4;

      beforeEach(() => {
        hiddenTs = writeFile('hidden/x.ts');
        mp4 = writeFile('cache/x.mp4', 'mp4-bytes');
        hiddenMp4 = path.join(workDir, 'hidden', 'x.mp4');
        getUntrackedBufferCacheMp4Path.mockReturnValue(hiddenMp4);
        recordTsToMp4Finalize.mockResolvedValue(true);
      });

      it('does nothing while a live session references the hidden .ts', async () => {
        hlsSessions.set('s1', { key: 's1', cachedFilePath: hiddenTs, destroying: false });

        await fin.swapHiddenCacheToMp4(YT_ID, hiddenTs, mp4, {});

        expect(fs.existsSync(mp4)).toBe(true);
      });

      it('moves the mp4 into the hidden cache and removes the .ts', async () => {
        await fin.swapHiddenCacheToMp4(YT_ID, hiddenTs, mp4, {});
        await tick();

        expect(fs.readFileSync(hiddenMp4, 'utf8')).toBe('mp4-bytes');
        expect(fs.existsSync(hiddenTs)).toBe(false);
      });

      it('records the finalize in Download History', async () => {
        await fin.swapHiddenCacheToMp4(YT_ID, hiddenTs, mp4, {});

        expect(recordTsToMp4Finalize).toHaveBeenCalledWith(YT_ID, hiddenTs, hiddenMp4, 9);
      });

      it('copies across filesystems when a rename is not possible', async () => {
        jest.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('x'), { code: 'EXDEV' }); });

        await fin.swapHiddenCacheToMp4(YT_ID, hiddenTs, mp4, {});

        expect(fs.readFileSync(hiddenMp4, 'utf8')).toBe('mp4-bytes');
        expect(fs.existsSync(mp4)).toBe(false);
      });

      it('warns and carries on when it fails', async () => {
        recordTsToMp4Finalize.mockRejectedValue(new Error('db down'));

        await expect(fin.swapHiddenCacheToMp4(YT_ID, hiddenTs, mp4, {})).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalled();
      });

      it('does not warn about a hidden .ts that was already removed', async () => {
        fs.rmSync(hiddenTs);

        await fin.swapHiddenCacheToMp4(YT_ID, hiddenTs, mp4, {});
        await tick();

        expect(logger.warn).not.toHaveBeenCalled();
      });
    });

    describe('resolveHlsBufferPromoteFn', () => {
      it.each([
        ['bufferStealth', { bufferStealth: true }, 'swapHiddenCacheToMp4'],
        ['bufferHybridPromote', { bufferHybridPromote: true }, 'promoteHiddenMp4ToLibrary'],
        ['bufferUntracked', { bufferUntracked: true }, 'swapHiddenCacheToMp4'],
        ['a plain library session', {}, 'promoteFinalizedTsToLibraryMp4'],
      ])('picks the right strategy for %s', (_label, session, expected) => {
        expect(fin.resolveHlsBufferPromoteFn(session)).toBe(fin[expected]);
      });

      it('prefers stealth over hybrid', () => {
        expect(fin.resolveHlsBufferPromoteFn({ bufferStealth: true, bufferHybridPromote: true })).toBe(fin.swapHiddenCacheToMp4);
      });
    });

    describe('maybeFinalizeTsToMp4', () => {
      beforeEach(() => {
        configModule.getConfig.mockReturnValue({ ytstream: { finalizeToMp4: true } });
        tsRemuxCache.ensureSeekableMp4.mockResolvedValue('/cache/x.mp4');
      });

      it('does nothing unless finalizeToMp4 is on', () => {
        configModule.getConfig.mockReturnValue({ ytstream: { finalizeToMp4: false } });

        fin.maybeFinalizeTsToMp4(YT_ID, '/x.ts', 'test');

        expect(tsRemuxCache.ensureSeekableMp4).not.toHaveBeenCalled();
      });

      it.each([[null], ['/x.mp4'], ['']])('does nothing for %p', (finalPath) => {
        fin.maybeFinalizeTsToMp4(YT_ID, finalPath, 'test');

        expect(tsRemuxCache.ensureSeekableMp4).not.toHaveBeenCalled();
      });

      it('remuxes a .ts in the background', () => {
        fin.maybeFinalizeTsToMp4(YT_ID, '/x.TS', 'test');

        expect(tsRemuxCache.ensureSeekableMp4).toHaveBeenCalledWith('/x.TS');
      });

      it('promotes the result when a strategy is given', async () => {
        const promote = jest.fn().mockResolvedValue(undefined);

        fin.maybeFinalizeTsToMp4(YT_ID, '/x.ts', 'test', { promote });
        await tick();

        expect(promote).toHaveBeenCalledWith('/cache/x.mp4');
      });

      it('does not promote when the remux produced nothing', async () => {
        tsRemuxCache.ensureSeekableMp4.mockResolvedValue(null);
        const promote = jest.fn();

        fin.maybeFinalizeTsToMp4(YT_ID, '/x.ts', 'test', { promote });
        await tick();

        expect(promote).not.toHaveBeenCalled();
      });

      it('swallows a failing promotion', async () => {
        const promote = jest.fn().mockRejectedValue(new Error('nope'));

        fin.maybeFinalizeTsToMp4(YT_ID, '/x.ts', 'test', { promote });
        await tick();

        expect(promote).toHaveBeenCalled();
      });

      it('warns when the remux fails', async () => {
        tsRemuxCache.ensureSeekableMp4.mockRejectedValue(new Error('ffmpeg failed'));

        fin.maybeFinalizeTsToMp4(YT_ID, '/x.ts', 'test');
        await tick();

        expect(logger.warn).toHaveBeenCalled();
      });

      it('never throws', () => {
        configModule.getConfig.mockImplementation(() => { throw new Error('config broke'); });

        expect(() => fin.maybeFinalizeTsToMp4(YT_ID, '/x.ts', 'test')).not.toThrow();
        expect(logger.warn).toHaveBeenCalled();
      });
    });

    describe('maybeRetroactivelyRemuxReusedCache', () => {
      beforeEach(() => {
        configModule.getConfig.mockReturnValue({ ytstream: { finalizeToMp4: true } });
        tsRemuxCache.ensureSeekableMp4.mockResolvedValue('/cache/x.mp4');
      });

      it('ignores a cached file that is not a .ts', () => {
        fin.maybeRetroactivelyRemuxReusedCache(YT_ID, '/c/x.mp4', {});

        expect(tsRemuxCache.ensureSeekableMp4).not.toHaveBeenCalled();
      });

      it('remuxes a warm .ts and promotes it with the strategy for the session', async () => {
        const hiddenTs = writeFile('hidden/x.ts');
        const mp4 = writeFile('cache/x.mp4', 'mp4-bytes');
        const hiddenMp4 = path.join(workDir, 'hidden', 'x.mp4');
        tsRemuxCache.ensureSeekableMp4.mockResolvedValue(mp4);
        getUntrackedBufferCacheMp4Path.mockReturnValue(hiddenMp4);
        recordTsToMp4Finalize.mockResolvedValue(true);

        fin.maybeRetroactivelyRemuxReusedCache(YT_ID, hiddenTs, { bufferStealth: true });
        await tick();

        expect(tsRemuxCache.ensureSeekableMp4).toHaveBeenCalledWith(hiddenTs);
        expect(fs.readFileSync(hiddenMp4, 'utf8')).toBe('mp4-bytes');
      });
    });
  });
});
