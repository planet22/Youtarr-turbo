/* eslint-env jest */

jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));

const { EventEmitter } = require('events');

describe('processRegistry', () => {
  let registry;
  let spawnSync;
  let logger;

  // isFfmpegAvailable/isFfprobeAvailable cache a positive result at module level
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.useFakeTimers();
    ({ spawnSync } = require('child_process'));
    logger = require('../../../logger');
    registry = require('../processRegistry');
    registry.activeChildProcesses.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function fakeProc(overrides = {}) {
    const proc = new EventEmitter();
    proc.pid = 123;
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = jest.fn();
    return Object.assign(proc, overrides);
  }

  describe('registerChildProcess', () => {
    it('tracks the process', () => {
      const proc = fakeProc();

      registry.registerChildProcess(proc);

      expect(registry.activeChildProcesses.has(proc)).toBe(true);
    });

    it('forgets the process when it exits', () => {
      const proc = fakeProc();
      registry.registerChildProcess(proc);

      proc.emit('exit');

      expect(registry.activeChildProcesses.has(proc)).toBe(false);
    });

    it('forgets the process when it errors', () => {
      const proc = fakeProc();
      registry.registerChildProcess(proc);

      proc.emit('error', new Error('spawn failed'));

      expect(registry.activeChildProcesses.has(proc)).toBe(false);
    });
  });

  describe('killChildProcess', () => {
    it.each([
      ['no process', null],
      ['an already killed process', fakeProc({ killed: true })],
      ['an already exited process', fakeProc({ exitCode: 0 })],
    ])('does nothing for %s', (_label, proc) => {
      expect(registry.killChildProcess(proc, 'test')).toBe(false);
    });

    it('sends SIGTERM first so ffmpeg can release hardware encoders', () => {
      const proc = fakeProc();

      const result = registry.killChildProcess(proc, 'disconnect');

      expect(result).toBe(true);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('escalates to SIGKILL after 3 seconds if the process is still running', () => {
      const proc = fakeProc();
      registry.killChildProcess(proc, 'disconnect');

      jest.advanceTimersByTime(3000);

      expect(proc.kill).toHaveBeenLastCalledWith('SIGKILL');
    });

    it('does not escalate if the process exited in the meantime', () => {
      const proc = fakeProc();
      registry.killChildProcess(proc, 'disconnect');
      proc.exitCode = 0;

      jest.advanceTimersByTime(3000);

      expect(proc.kill).toHaveBeenCalledTimes(1);
    });

    it('does not escalate if the process was marked killed in the meantime', () => {
      const proc = fakeProc();
      registry.killChildProcess(proc, 'disconnect');
      proc.killed = true;

      jest.advanceTimersByTime(3000);

      expect(proc.kill).toHaveBeenCalledTimes(1);
    });

    it('swallows a failure while escalating to SIGKILL', () => {
      const proc = fakeProc();
      proc.kill.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('ESRCH'); });
      registry.killChildProcess(proc, 'disconnect');

      expect(() => jest.advanceTimersByTime(3000)).not.toThrow();
    });

    it('returns false and warns when SIGTERM fails', () => {
      const proc = fakeProc();
      proc.kill.mockImplementation(() => { throw new Error('EPERM'); });

      expect(registry.killChildProcess(proc, 'disconnect')).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  describe('killAllChildProcesses', () => {
    it('terminates every tracked process', () => {
      const a = fakeProc();
      const b = fakeProc();
      registry.registerChildProcess(a);
      registry.registerChildProcess(b);

      registry.killAllChildProcesses('shutdown');

      expect(a.kill).toHaveBeenCalledWith('SIGTERM');
      expect(b.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does nothing when nothing is tracked', () => {
      expect(() => registry.killAllChildProcesses('shutdown')).not.toThrow();
    });
  });

  describe.each([
    ['isFfmpegAvailable', 'ffmpeg'],
    ['isFfprobeAvailable', 'ffprobe'],
  ])('%s', (fnName, binary) => {
    it('is true when the binary reports its version', () => {
      spawnSync.mockReturnValue({ status: 0 });

      expect(registry[fnName]()).toBe(true);
      expect(spawnSync).toHaveBeenCalledWith(binary, ['-version'], { timeout: 5000 });
    });

    it('caches a positive result', () => {
      spawnSync.mockReturnValue({ status: 0 });
      registry[fnName]();

      registry[fnName]();

      expect(spawnSync).toHaveBeenCalledTimes(1);
    });

    it('is false when the binary cannot be spawned', () => {
      spawnSync.mockReturnValue({ error: new Error('ENOENT'), status: null });

      expect(registry[fnName]()).toBe(false);
    });

    it('is false on a non-zero exit', () => {
      spawnSync.mockReturnValue({ status: 1 });

      expect(registry[fnName]()).toBe(false);
    });

    it('is false when spawning throws', () => {
      spawnSync.mockImplementation(() => { throw new Error('boom'); });

      expect(registry[fnName]()).toBe(false);
    });

    it('re-checks after a negative result, so a boot-time PATH race is not permanent', () => {
      spawnSync.mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });

      expect([registry[fnName](), registry[fnName]()]).toEqual([false, true]);
    });
  });

  it('warns when ffmpeg is missing', () => {
    spawnSync.mockReturnValue({ error: new Error('ENOENT') });

    registry.isFfmpegAvailable();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ffmpeg was not found on PATH'));
  });
});
