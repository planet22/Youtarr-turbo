/* eslint-env jest */

// Drives the post-process script's optional post-download transcode step end
// to end with a scripted fake ffmpeg process. The script runs at require time
// (it reads process.argv), so each test loads it in an isolated module registry.

const mockFsState = { existing: new Set() };

jest.mock('fs-extra', () => ({
  existsSync: jest.fn((p) => mockFsState.existing.has(p)),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  ensureDirSync: jest.fn(),
  moveSync: jest.fn(),
  copySync: jest.fn(),
  removeSync: jest.fn(),
  renameSync: jest.fn(),
  utimesSync: jest.fn(),
  pathExists: jest.fn(),
  stat: jest.fn(),
  move: jest.fn(),
  remove: jest.fn(),
  ensureDir: jest.fn(),
  readdir: jest.fn(),
  promises: {},
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  spawnSync: jest.fn(() => ({ status: 0, error: null })),
  spawn: jest.fn(),
  execFile: jest.fn((cmd, args, callback) => callback(null, '', '')),
  execFileSync: jest.fn(),
}));

const mockConfig = {};

jest.mock('../configModule', () => ({
  getConfig: jest.fn(() => mockConfig),
  getJobsPath: jest.fn(() => '/mock/jobs'),
  getImagePath: jest.fn(() => '/mock/images'),
  stopWatchingConfig: jest.fn(),
  getCookiesPath: jest.fn(() => null),
  getDefaultSubfolder: jest.fn(() => null),
  ffmpegPath: '/usr/bin/ffmpeg',
  atomicParsleyPath: '/usr/bin/AtomicParsley',
  directoryPath: '/library',
}));

jest.mock('../nfoGenerator', () => ({ writeVideoNfoFile: jest.fn() }));
jest.mock('../download/tempPathManager', () => ({
  isEnabled: jest.fn(() => false),
  isTempPath: jest.fn(() => false),
  convertTempToFinal: jest.fn((p) => p),
  getTempBasePath: jest.fn(() => '/tmp/youtarr-downloads'),
}));
jest.mock('../resolutionTier', () => ({
  ...jest.requireActual('../resolutionTier'),
  probeVideoDimensions: jest.fn(),
  probeVideoDuration: jest.fn(),
}));

const mockJob = { findOne: jest.fn() };
const mockRecordEvent = jest.fn();
const mockChannel = { findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() };
const mockJobVideoDownload = { update: jest.fn() };

jest.mock('../../models/channel', () => mockChannel);
jest.mock('../../models/channelvideo', () => ({ findAll: jest.fn(() => Promise.resolve([])) }));
jest.mock('../../models', () => ({ JobVideoDownload: mockJobVideoDownload, Channel: mockChannel, Job: mockJob }));
jest.mock('../jobEventLog', () => ({ record: (...args) => mockRecordEvent(...args), rememberJob: jest.fn(), isTracked: jest.fn(() => null) }));
jest.mock('../videoPersistence', () => ({ persistDownloadedVideoForJob: jest.fn(() => Promise.resolve(null)) }));
jest.mock('../../logger');
jest.mock('../filesystem', () => ({
  ...jest.requireActual('../filesystem'),
  cleanupEmptyParents: jest.fn(() => Promise.resolve()),
  moveWithRetries: jest.fn(async () => {}),
  ensureDirWithRetries: jest.fn(async () => {}),
}));

const { EventEmitter } = require('events');
const path = require('path');

const fs = require('fs-extra');
const childProcess = require('child_process');
const logger = require('../../logger');
const resolutionTier = require('../resolutionTier');
const { TRANSCODE_PROGRESS_MARKER } = require('../constants/outputMarkers');

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT = process.exit;

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitUntil(predicate, attempts = 400) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('condition was not met in time');
}

describe('videoDownloadPostProcessFiles post-download transcode', () => {
  const dir = path.join('/library', 'Channel', 'Video Title [abc123]');
  const inputPath = path.join(dir, 'Video Title [abc123].mkv');
  const jsonPath = path.join(dir, 'Video Title [abc123].info.json');
  const tmpOutput = path.join(dir, 'Video Title [abc123].transcode-tmp.mp4');
  const finalMp4 = path.join(dir, 'Video Title [abc123].mp4');

  let stdoutSpy;
  let attempts;

  // Scripts each ffmpeg attempt: { stdout: [chunks], stderr, code, error, writesOutput }
  function scriptFfmpeg(...plans) {
    attempts = [];
    childProcess.spawn.mockImplementation((cmd, args) => {
      const plan = plans[attempts.length] || plans[plans.length - 1];
      attempts.push({ cmd, args, plan });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = jest.fn();
      setImmediate(() => {
        if (plan.error) {
          proc.emit('error', plan.error);
          return;
        }
        (plan.stdout || []).forEach((chunk) => proc.stdout.emit('data', Buffer.from(chunk)));
        if (plan.stderr) proc.stderr.emit('data', Buffer.from(plan.stderr));
        if (plan.writesOutput) mockFsState.existing.add(tmpOutput);
        proc.emit('close', plan.code ?? 0);
      });
      return proc;
    });
  }

  async function run(ext = '.mkv') {
    const source = ext === '.mkv' ? inputPath : inputPath.replace(/\.mkv$/, ext);
    process.argv = ['node', 'script', source];
    jest.isolateModules(() => {
      require('../videoDownloadPostProcessFiles');
    });
    await waitUntil(() => mockJobVideoDownload.update.mock.calls.length > 0 || process.exit.mock.calls.length > 0);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockFsState.existing = new Set([jsonPath, inputPath]);
    fs.existsSync.mockImplementation((p) => mockFsState.existing.has(p));
    fs.removeSync.mockReset();
    Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
    Object.assign(mockConfig, { downloadTranscodeVideoCodec: 'hevc', writeVideoNfoFiles: false, writeChannelPosters: false });

    process.env.YOUTARR_JOB_ID = 'job-1';
    process.exit = jest.fn();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    fs.readFileSync.mockReturnValue(JSON.stringify({ id: 'abc123', upload_date: '20240131', title: 'Video Title', uploader: 'Channel', channel_id: 'channel123' }));
    fs.pathExists.mockResolvedValue(false);
    fs.stat.mockResolvedValue({ size: 1000 });
    fs.move.mockResolvedValue();
    fs.remove.mockResolvedValue();
    fs.ensureDir.mockResolvedValue();
    fs.readdir.mockResolvedValue([]);

    mockChannel.findOne.mockResolvedValue(null);
    mockChannel.findAll.mockResolvedValue([]);
    mockChannel.update.mockResolvedValue([1]);
    mockJobVideoDownload.update.mockResolvedValue([1]);
    mockJob.findOne.mockResolvedValue(null);
    resolutionTier.probeVideoDimensions.mockResolvedValue('1920x1080');
    resolutionTier.probeVideoDuration.mockResolvedValue(100);
    childProcess.spawnSync.mockReturnValue({ status: 0, error: null });
    scriptFfmpeg({ writesOutput: true });
  });

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    process.exit = ORIGINAL_EXIT;
    stdoutSpy.mockRestore();
    delete process.env.YOUTARR_JOB_ID;
  });

  const completedPath = () => mockJobVideoDownload.update.mock.calls[0][0].file_path;

  describe('when it does not apply', () => {
    it('leaves the file alone when transcoding is off', async () => {
      mockConfig.downloadTranscodeVideoCodec = 'off';

      await run();

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('leaves the file alone when no codec is configured', async () => {
      delete mockConfig.downloadTranscodeVideoCodec;

      await run();

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('never transcodes audio-only downloads', async () => {
      const mp3 = inputPath.replace(/\.mkv$/, '.mp3');
      mockFsState.existing = new Set([jsonPath, mp3]);

      await run('.mp3');

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('never transcodes STRM cache-on-play downloads', async () => {
      process.env.YOUTARR_STRM_CACHE_TARGET_DIR = dir;
      try {
        await run();
      } finally {
        delete process.env.YOUTARR_STRM_CACHE_TARGET_DIR;
      }

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('skips and warns when the input file is missing', async () => {
      mockFsState.existing = new Set([jsonPath]);

      await run();

      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith({ inputPath }, expect.stringContaining('Transcode requested but input file not found'));
    });
  });

  describe('NZB category gating', () => {
    const nzbJob = (categoryName) => ({ jobType: 'Sonarr/Radarr: x', aux_data: JSON.stringify({ nzb: { categoryName } }) });

    it('skips when the NZB category is missing from the config', async () => {
      mockJob.findOne.mockResolvedValue(nzbJob('movies'));
      mockConfig.nzb = { categories: [] };

      await run();

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('skips when the NZB category has post-encode off', async () => {
      mockJob.findOne.mockResolvedValue(nzbJob('movies'));
      mockConfig.nzb = { categories: [{ name: 'movies', postEncode: false }] };

      await run();

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it('transcodes when the NZB category enables post-encode', async () => {
      mockJob.findOne.mockResolvedValue(nzbJob('movies'));
      mockConfig.nzb = { categories: [{ name: 'movies', postEncode: true }] };

      await run();

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    });

    it('uses the global setting for non-NZB jobs', async () => {
      mockJob.findOne.mockResolvedValue({ jobType: 'Channel Downloads', aux_data: null });

      await run();

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    });

    it('falls back to the global setting when the job lookup fails', async () => {
      mockJob.findOne.mockRejectedValue(new Error('db down'));

      await run();

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ activeJobId: 'job-1' }), expect.stringContaining('NZB category lookup failed'));
    });
  });

  describe('the ffmpeg command', () => {
    it('runs the configured ffmpeg on the input and writes a temporary mp4', async () => {
      await run();

      expect(attempts[0].cmd).toBe('/usr/bin/ffmpeg');
      const args = attempts[0].args;
      expect(args.slice(0, 6)).toEqual(['-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1']);
      expect(args).toContain(inputPath);
      expect(args[args.length - 1]).toBe(tmpOutput);
    });

    it('preserves metadata and adds faststart', async () => {
      await run();

      expect(attempts[0].args.slice(-5, -1)).toEqual(['-map_metadata', '0', '-movflags', '+faststart']);
    });

    it('uses the software encoder for the configured codec by default', async () => {
      await run();

      expect(attempts[0].args).toContain('libx265');
    });

    it('copies the audio by default', async () => {
      await run();

      expect(attempts[0].args).toEqual(expect.arrayContaining(['-c:a', 'copy']));
    });

    it('re-encodes audio when configured', async () => {
      mockConfig.downloadTranscodeAudioCodec = 'aac';

      await run();

      expect(attempts[0].args).toEqual(expect.arrayContaining(['-c:a', 'aac', '-b:a', '192k']));
    });

    it('tries the configured hardware encoder first', async () => {
      mockConfig.downloadTranscodeHardwareMode = 'nvenc';

      await run();

      expect(attempts).toHaveLength(1);
      expect(attempts[0].args).toContain('hevc_nvenc');
    });

    it('adds the encoder\'s video filters and pixel format when it has them', async () => {
      mockConfig.downloadTranscodeHardwareMode = 'vaapi';

      await run();

      expect(attempts[0].args).toEqual(expect.arrayContaining(['-vf']));
    });

    it('removes a stale temporary output before encoding', async () => {
      mockFsState.existing.add(tmpOutput);

      await run();

      expect(fs.removeSync).toHaveBeenCalledWith(tmpOutput);
    });

    it('carries on when the stale temporary output cannot be removed', async () => {
      mockFsState.existing.add(tmpOutput);
      fs.removeSync.mockImplementation((p) => {
        if (p === tmpOutput) throw new Error('locked');
      });

      await run();

      expect(childProcess.spawn).toHaveBeenCalled();
    });

    it('proceeds when the resolution probe fails', async () => {
      resolutionTier.probeVideoDimensions.mockRejectedValue(new Error('no ffprobe'));

      await run();

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    });

    it('proceeds when the duration probe fails', async () => {
      resolutionTier.probeVideoDuration.mockRejectedValue(new Error('no ffprobe'));

      await run();

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    });

    it('proceeds when the resolution probe reports nothing', async () => {
      resolutionTier.probeVideoDimensions.mockResolvedValue(null);

      await run();

      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('a successful encode', () => {
    it('replaces the original with the transcoded mp4', async () => {
      await run();

      expect(fs.removeSync).toHaveBeenCalledWith(inputPath);
      expect(fs.moveSync).toHaveBeenCalledWith(tmpOutput, finalMp4, { overwrite: true });
    });

    it('removes the original only after the transcoded file is in place', async () => {
      await run();

      const removeOrder = fs.removeSync.mock.calls.findIndex(([p]) => p === inputPath);
      const moveOrder = fs.moveSync.mock.invocationCallOrder[0];
      expect(fs.removeSync.mock.invocationCallOrder[removeOrder]).toBeGreaterThan(moveOrder);
    });

    it('keeps the original when the transcoded file cannot be moved into place', async () => {
      fs.moveSync.mockImplementationOnce(() => { throw new Error('disk full'); });

      await run();

      expect(fs.removeSync).not.toHaveBeenCalledWith(inputPath);
    });

    it('carries the transcoded path through the rest of post-processing', async () => {
      await run();

      expect(completedPath()).toBe(finalMp4);
    });

    it('carries on when the original cannot be removed', async () => {
      fs.removeSync.mockImplementation((p) => {
        if (p === inputPath) throw new Error('busy');
      });

      await run();

      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ inputPath }), expect.stringContaining('Could not remove pre-transcode original file'));
      expect(completedPath()).toBe(finalMp4);
    });

    it('does not move the output when the source was already an mp4 of the same name', async () => {
      const mp4 = inputPath.replace(/\.mkv$/, '.mp4');
      mockFsState.existing = new Set([jsonPath, mp4]);
      scriptFfmpeg({ writesOutput: true });
      process.argv = ['node', 'script', mp4];

      jest.isolateModules(() => {
        require('../videoDownloadPostProcessFiles');
      });
      await waitUntil(() => mockJobVideoDownload.update.mock.calls.length > 0);

      expect(fs.moveSync).toHaveBeenCalledWith(tmpOutput, mp4, { overwrite: true });
    });

    it('does not try to remove a same-named mp4 original, since the move overwrites it', async () => {
      const mp4 = inputPath.replace(/\.mkv$/, '.mp4');
      mockFsState.existing = new Set([jsonPath, mp4]);
      scriptFfmpeg({ writesOutput: true });
      process.argv = ['node', 'script', mp4];

      jest.isolateModules(() => {
        require('../videoDownloadPostProcessFiles');
      });
      await waitUntil(() => mockJobVideoDownload.update.mock.calls.length > 0);

      expect(fs.removeSync).not.toHaveBeenCalledWith(mp4);
    });
  });

  describe('progress reporting', () => {
    const block = (outTimeUs, speed, state) => `out_time_us=${outTimeUs}\nspeed=${speed}\nprogress=${state}\n`;
    const emitted = () => stdoutSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith(TRANSCODE_PROGRESS_MARKER))
      .map((line) => JSON.parse(line.slice(TRANSCODE_PROGRESS_MARKER.length)));

    it('reports percent, eta and speed as JSON markers', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: [block(25_000_000, '2.5x', 'end')] });

      await run();

      expect(emitted()).toEqual([{ percent: 25, etaSeconds: 30, speedFactor: 2.5 }]);
    });

    it('reports the final block even when it arrives inside the throttle window', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: [block(10_000_000, '1x', 'continue'), block(100_000_000, '1x', 'end')] });

      await run();

      expect(emitted().map((e) => e.percent)).toEqual([10, 100]);
    });

    it('throttles intermediate blocks', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: [block(10_000_000, '1x', 'continue'), block(20_000_000, '1x', 'continue'), block(30_000_000, '1x', 'continue')] });

      await run();

      expect(emitted()).toHaveLength(1);
    });

    it('caps the percentage at 100', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: [block(500_000_000, '1x', 'end')] });

      await run();

      expect(emitted()[0].percent).toBe(100);
    });

    it('reports a zero eta and speed when the speed is not a number', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: [block(10_000_000, 'N/A', 'end')] });

      await run();

      expect(emitted()).toEqual([{ percent: 10, etaSeconds: 0, speedFactor: 0 }]);
    });

    it('reassembles lines split across chunks', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: ['out_time_us=50000', '000\nspeed=1x\nprog', 'ress=end\n'] });

      await run();

      expect(emitted()).toEqual([{ percent: 50, etaSeconds: 50, speedFactor: 1 }]);
    });

    it('skips lines that are not key=value', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: ['garbage line\n', block(10_000_000, '1x', 'end')] });

      await run();

      expect(emitted()).toHaveLength(1);
    });

    it('ignores a block without a numeric encoded time', async () => {
      scriptFfmpeg({ writesOutput: true, stdout: ['out_time_us=N/A\nspeed=1x\nprogress=end\n'] });

      await run();

      expect(emitted()).toEqual([]);
    });

    it('emits no progress when the source duration is unknown', async () => {
      resolutionTier.probeVideoDuration.mockResolvedValue(null);
      scriptFfmpeg({ writesOutput: true, stdout: [block(10_000_000, '1x', 'end')] });

      await run();

      expect(emitted()).toEqual([]);
    });
  });

  describe('when encoding fails', () => {
    it('retries with the software encoder when the hardware encoder fails', async () => {
      mockConfig.downloadTranscodeHardwareMode = 'nvenc';
      scriptFfmpeg({ code: 1, stderr: 'no device' }, { writesOutput: true });

      await run();

      expect(attempts.map((a) => (a.args.includes('hevc_nvenc') ? 'hw' : 'sw'))).toEqual(['hw', 'sw']);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ hardwareMode: 'nvenc', stderr: 'no device' }), expect.stringContaining('retrying with software encoder'));
      expect(completedPath()).toBe(finalMp4);
    });

    it('keeps the original when the software encode fails', async () => {
      scriptFfmpeg({ code: 1, stderr: 'bad input' });

      await run();

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stderr: 'bad input' }), expect.stringContaining('keeping original file'));
      expect(completedPath()).toBe(inputPath);
      expect(fs.removeSync).not.toHaveBeenCalledWith(inputPath);
    });

    it('keeps the original when both encoders fail', async () => {
      mockConfig.downloadTranscodeHardwareMode = 'nvenc';
      scriptFfmpeg({ code: 1, stderr: 'x' });

      await run();

      expect(attempts).toHaveLength(2);
      expect(completedPath()).toBe(inputPath);
    });

    it('cleans up a partial temporary output', async () => {
      scriptFfmpeg({ code: 1, stderr: 'x' });
      fs.removeSync.mockImplementation(() => {});
      const originalExists = fs.existsSync.getMockImplementation();
      fs.existsSync.mockImplementation((p) => p === tmpOutput || originalExists(p));

      await run();

      expect(fs.removeSync).toHaveBeenCalledWith(tmpOutput);
    });

    it('carries on when the partial output cannot be removed', async () => {
      scriptFfmpeg({ code: 1, stderr: 'x' });
      fs.removeSync.mockImplementation(() => { throw new Error('locked'); });
      const originalExists = fs.existsSync.getMockImplementation();
      fs.existsSync.mockImplementation((p) => p === tmpOutput || originalExists(p));

      await run();

      expect(completedPath()).toBe(inputPath);
    });

    it('treats a clean exit that wrote no output as a failure', async () => {
      scriptFfmpeg({ code: 0, writesOutput: false });

      await run();

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stderr: 'ffmpeg exited with status 0' }), expect.any(String));
    });

    it('reports the exit status when ffmpeg printed nothing', async () => {
      scriptFfmpeg({ code: 3 });

      await run();

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stderr: 'ffmpeg exited with status 3' }), expect.any(String));
    });

    it('treats a spawn error as a failed attempt', async () => {
      scriptFfmpeg({ error: new Error('spawn ENOENT') });

      await run();

      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ stderr: 'spawn ENOENT' }), expect.any(String));
      expect(completedPath()).toBe(inputPath);
    });

    it('keeps only the tail of very long stderr output', async () => {
      scriptFfmpeg({ code: 1, stderr: `${'a'.repeat(60000)}TAIL` });

      await run();

      const stderr = logger.error.mock.calls.find(([, msg]) => String(msg).includes('keeping original file'))[0].stderr;
      expect(stderr.length).toBeLessThanOrEqual(4000);
      expect(stderr.endsWith('TAIL')).toBe(true);
    });
  });

  describe('video/events log', () => {
    const eventsOfType = (type) => mockRecordEvent.mock.calls.filter(([t]) => t === type);

    it('records video.transcoded with the codec and the original file name', async () => {
      await run();

      expect(eventsOfType('video.transcoded')[0][1]).toMatchObject({
        jobId: 'job-1',
        youtubeId: 'abc123',
        videoTitle: 'Video Title',
        channelName: 'Channel',
        detail: { from: 'Video Title [abc123].mkv', to: 'Video Title [abc123].mp4', codec: 'hevc' },
      });
    });

    it('stamps the transcode with the time it happened, not the time of the later finalize', async () => {
      await run();

      expect(eventsOfType('video.transcoded')[0][1].occurredAt).toBeInstanceOf(Date);
    });

    it('records the transcode before the file is finalized', async () => {
      await run();

      const transcodedOrder = mockRecordEvent.mock.invocationCallOrder[mockRecordEvent.mock.calls.findIndex(([t]) => t === 'video.transcoded')];
      const finalizedOrder = mockRecordEvent.mock.invocationCallOrder[mockRecordEvent.mock.calls.findIndex(([t]) => t === 'video.file_finalized')];
      expect(transcodedOrder).toBeLessThan(finalizedOrder);
    });

    it('records no transcode when transcoding is off', async () => {
      mockConfig.downloadTranscodeVideoCodec = 'off';

      await run();

      expect(eventsOfType('video.transcoded')).toHaveLength(0);
    });

    it('records no transcode for an audio-only download', async () => {
      const mp3 = inputPath.replace(/\.mkv$/, '.mp3');
      mockFsState.existing = new Set([jsonPath, mp3]);

      await run('.mp3');

      expect(eventsOfType('video.transcoded')).toHaveLength(0);
    });
  });
});
