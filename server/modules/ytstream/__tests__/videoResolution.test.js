/* eslint-env jest */

jest.mock('../../../logger');
jest.mock('../streamDebug', () => ({ streamDebug: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../../logger');
const { resolveVideoTargetResolution } = require('../videoResolution');

const FALLBACK = { width: 1280, height: 720 };

describe('resolveVideoTargetResolution', () => {
  let workDir;
  const findOne = jest.fn();
  const models = { Video: { findOne } };

  beforeEach(() => {
    jest.clearAllMocks();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-resolution-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function writeSidecar(name, contents) {
    fs.writeFileSync(path.join(workDir, `${name}.strmtool.json`), typeof contents === 'string' ? contents : JSON.stringify(contents));
  }

  it('falls back to 16:9 when no models are injected', async () => {
    await expect(resolveVideoTargetResolution('vid', null)).resolves.toEqual(FALLBACK);
  });

  it('falls back when the Video model is missing', async () => {
    await expect(resolveVideoTargetResolution('vid', {})).resolves.toEqual(FALLBACK);
  });

  it('falls back for a video with no row', async () => {
    findOne.mockResolvedValue(null);

    await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
  });

  it('looks the video up by youtube id', async () => {
    findOne.mockResolvedValue(null);

    await resolveVideoTargetResolution('abc123', models);

    expect(findOne).toHaveBeenCalledWith({ where: { youtubeId: 'abc123' }, attributes: ['filePath', 'video_resolution'] });
  });

  it('uses the probed video_resolution', async () => {
    findOne.mockResolvedValue({ video_resolution: '1920x1080', filePath: '/x.mp4' });

    await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual({ width: 1920, height: 1080 });
  });

  it('supports portrait resolutions', async () => {
    findOne.mockResolvedValue({ video_resolution: '1080x1920', filePath: '/x.mp4' });

    await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual({ width: 1080, height: 1920 });
  });

  it('trims whitespace around the stored resolution', async () => {
    findOne.mockResolvedValue({ video_resolution: ' 640x360 ', filePath: '/x.mp4' });

    await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual({ width: 640, height: 360 });
  });

  it.each(['0x0', '1920x0', '0x1080', 'garbage', '1920*1080', ''])('ignores the unusable resolution %p', async (video_resolution) => {
    findOne.mockResolvedValue({ video_resolution, filePath: '/x.mp4' });

    await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
  });

  describe('STRM sidecar', () => {
    const strmVideo = (name = 'Video') => ({ video_resolution: null, filePath: path.join(workDir, `${name}.strm`) });

    it('reads the video stream size from the .strmtool.json next to the .strm', async () => {
      writeSidecar('Video', { mediaStreams: [{ Type: 2 }, { Type: 1, Width: 2560, Height: 1440 }] });
      findOne.mockResolvedValue(strmVideo());

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual({ width: 2560, height: 1440 });
    });

    it('matches the .strm extension case-insensitively', async () => {
      writeSidecar('Video', { mediaStreams: [{ Type: 1, Width: 800, Height: 600 }] });
      findOne.mockResolvedValue({ video_resolution: null, filePath: path.join(workDir, 'Video.STRM') });

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual({ width: 800, height: 600 });
    });

    it('prefers video_resolution over the sidecar', async () => {
      writeSidecar('Video', { mediaStreams: [{ Type: 1, Width: 800, Height: 600 }] });
      findOne.mockResolvedValue({ ...strmVideo(), video_resolution: '1280x720' });

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual({ width: 1280, height: 720 });
    });

    it('falls back when the sidecar does not exist', async () => {
      findOne.mockResolvedValue(strmVideo());

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
    });

    it('falls back when the sidecar has no video stream', async () => {
      writeSidecar('Video', { mediaStreams: [{ Type: 2 }] });
      findOne.mockResolvedValue(strmVideo());

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
    });

    it('falls back when the video stream has no dimensions', async () => {
      writeSidecar('Video', { mediaStreams: [{ Type: 1 }] });
      findOne.mockResolvedValue(strmVideo());

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
    });

    it('falls back when mediaStreams is not an array', async () => {
      writeSidecar('Video', { mediaStreams: 'nope' });
      findOne.mockResolvedValue(strmVideo());

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
    });

    it('falls back and warns when the sidecar is corrupt', async () => {
      writeSidecar('Video', '{not json');
      findOne.mockResolvedValue(strmVideo());

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not look for a sidecar next to a non-STRM file', async () => {
      writeSidecar('Video', { mediaStreams: [{ Type: 1, Width: 800, Height: 600 }] });
      findOne.mockResolvedValue({ video_resolution: null, filePath: path.join(workDir, 'Video.mp4') });

      await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
    });
  });

  it('falls back and warns when the database lookup throws', async () => {
    findOne.mockRejectedValue(new Error('db down'));

    await expect(resolveVideoTargetResolution('vid', models)).resolves.toEqual(FALLBACK);
    expect(logger.warn).toHaveBeenCalled();
  });
});
