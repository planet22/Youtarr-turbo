/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../playbackPlan', () => ({ getVideoDurationSeconds: jest.fn(() => Promise.resolve(null)) }));
// byteRangeHlsMode.js transitively requires configModule (via
// ytdlpArgs->streamDebug) - the real configModule constructor reads
// config.json and calls logger.setLevel at module-load time, neither of
// which the plain logger mock above provides.
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));
const { EventEmitter } = require('events');
const { buildSessionKey, isSessionComplete, waitForChildExit, trackSessionRequest, CLIENT_CLOSE_GRACE_MS } = require('../byteRangeHlsMode');

describe('byteRangeHlsMode.buildSessionKey', () => {
  const baseParams = {
    youtubeId: 'dQw4w9WgXcQ',
    quality: '1080',
    qualityStrictness: 'fallback',
    transcode: 'h264',
    hardwareMode: 'vaapi',
    tuning: 'fast',
  };

  it('is deterministic for the same params', () => {
    expect(buildSessionKey({ ...baseParams })).toBe(buildSessionKey({ ...baseParams }));
  });

  it('differs when the youtubeId differs', () => {
    expect(buildSessionKey(baseParams)).not.toBe(buildSessionKey({ ...baseParams, youtubeId: 'otherId12345' }));
  });

  it('differs when transcode differs (copy vs h264 must not collide)', () => {
    expect(buildSessionKey(baseParams)).not.toBe(buildSessionKey({ ...baseParams, transcode: 'copy' }));
  });

  it('differs for mkv so a Matroska encode never collides with the mp4 one', () => {
    expect(buildSessionKey(baseParams)).not.toBe(buildSessionKey({ ...baseParams, container: 'mkv' }));
  });

  it('keeps the same key for mp4 as when no container is given (existing cache entries stay valid)', () => {
    expect(buildSessionKey({ ...baseParams, container: 'mp4' })).toBe(buildSessionKey(baseParams));
  });
});

describe('byteRangeHlsMode.trackSessionRequest', () => {
  const makeSession = () => ({ key: 'k', youtubeId: 'y', ff: { exitCode: 0 }, tearingDown: false });
  const makeRes = () => Object.assign(new EventEmitter(), { writableFinished: false });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('frees a finished session once the last request has closed and the grace has passed', () => {
    const onClosed = jest.fn();
    const session = makeSession();
    const res = makeRes();
    trackSessionRequest(session, res, onClosed);
    res.emit('close');
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS + 1);
    expect(onClosed).toHaveBeenCalledWith(session);
  });

  it('does not tear down before the grace has passed', () => {
    const onClosed = jest.fn();
    const res = makeRes();
    trackSessionRequest(makeSession(), res, onClosed);
    res.emit('close');
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS - 1000);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('does not tear down while another request is still open', () => {
    const onClosed = jest.fn();
    const session = makeSession();
    const first = makeRes();
    trackSessionRequest(session, first, onClosed);
    trackSessionRequest(session, makeRes(), onClosed);
    first.emit('close');
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS * 3);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('cancels the teardown when a new request arrives within the grace (a seek reconnecting)', () => {
    const onClosed = jest.fn();
    const session = makeSession();
    const first = makeRes();
    trackSessionRequest(session, first, onClosed);
    first.emit('close');
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS - 1000);
    trackSessionRequest(session, makeRes(), onClosed);
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS * 3);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('tears down after the reconnected request closes too', () => {
    const onClosed = jest.fn();
    const session = makeSession();
    const first = makeRes();
    const second = makeRes();
    trackSessionRequest(session, first, onClosed);
    first.emit('close');
    trackSessionRequest(session, second, onClosed);
    second.emit('close');
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS + 1);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('leaves a session whose encode is still running to the idle timeout', () => {
    const onClosed = jest.fn();
    const session = { ...makeSession(), ff: { exitCode: null } };
    const res = makeRes();
    trackSessionRequest(session, res, onClosed);
    res.emit('close');
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS * 3);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('does nothing for a session that is already being torn down', () => {
    const onClosed = jest.fn();
    const session = { ...makeSession(), tearingDown: true };
    const res = makeRes();
    trackSessionRequest(session, res, onClosed);
    res.emit('close');
    jest.advanceTimersByTime(CLIENT_CLOSE_GRACE_MS * 2);
    expect(onClosed).not.toHaveBeenCalled();
  });
});

describe('byteRangeHlsMode.isSessionComplete', () => {
  const cleanSession = () => ({
    ff: { exitCode: 0 },
    ytVideo: { exitCode: 0 },
    ytAudio: { exitCode: 0 },
  });

  it('is complete only when ffmpeg AND both yt-dlp children all exited 0', () => {
    expect(isSessionComplete(cleanSession())).toBe(true);
  });

  it('is NOT complete when ffmpeg exited 0 but the video yt-dlp child did not (the confirmed bug this fixes)', () => {
    const session = cleanSession();
    session.ytVideo.exitCode = 1;
    expect(isSessionComplete(session)).toBe(false);
  });

  it('is NOT complete when ffmpeg exited 0 but the audio yt-dlp child did not', () => {
    const session = cleanSession();
    session.ytAudio.exitCode = 1;
    expect(isSessionComplete(session)).toBe(false);
  });

  it('is NOT complete when ffmpeg itself has not exited yet (still encoding)', () => {
    const session = cleanSession();
    session.ff.exitCode = null;
    expect(isSessionComplete(session)).toBe(false);
  });

  it('is NOT complete when ffmpeg exited with a nonzero code', () => {
    const session = cleanSession();
    session.ff.exitCode = 1;
    expect(isSessionComplete(session)).toBe(false);
  });
});

describe('byteRangeHlsMode.waitForChildExit', () => {
  const fakeChild = (props = {}) => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }, props);

  afterEach(() => { jest.useRealTimers(); });

  it('resolves immediately when the child already exited with a code', async () => {
    await expect(waitForChildExit(fakeChild({ exitCode: 0 }))).resolves.toBeUndefined();
  });

  it('resolves immediately when the child was already killed by a signal', async () => {
    await expect(waitForChildExit(fakeChild({ signalCode: 'SIGTERM' }))).resolves.toBeUndefined();
  });

  it('resolves once the child emits exit', async () => {
    const child = fakeChild();
    const waiting = waitForChildExit(child);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await expect(waiting).resolves.toBeUndefined();
  });

  it('gives up after the timeout when the child never exits', async () => {
    jest.useFakeTimers();
    const waiting = waitForChildExit(fakeChild());
    jest.advanceTimersByTime(5000);
    await expect(waiting).resolves.toBeUndefined();
  });

  it('removes its exit listener once resolved', async () => {
    const child = fakeChild();
    const waiting = waitForChildExit(child);
    child.emit('exit', 0, null);
    await waiting;
    expect(child.listenerCount('exit')).toBe(0);
  });
});
