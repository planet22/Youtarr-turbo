/* eslint-env jest */

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}));

jest.mock('../configModule', () => ({
  ffmpegPath: '/usr/bin/ffmpeg',
}));

const { execFileSync } = require('child_process');
const { resizeImageWithFfmpeg } = require('../imageResizer');

describe('imageResizer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invokes ffmpeg via execFileSync with no shell, passing paths as discrete args', () => {
    resizeImageWithFfmpeg('/in/image.jpg', '/out/image-small.jpg', 0.4);

    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/bin/ffmpeg',
      ['-loglevel', 'error', '-y', '-i', '/in/image.jpg', '-vf', 'scale=iw*0.4:ih*0.4', '-q:v', '2', '/out/image-small.jpg'],
      { stdio: 'inherit' }
    );
  });

  it('applies the given scale factor to both dimensions', () => {
    resizeImageWithFfmpeg('/in.jpg', '/out.jpg', 0.5);

    const [, args] = execFileSync.mock.calls[0];
    expect(args).toContain('scale=iw*0.5:ih*0.5');
  });

  it('defaults stdio to inherit when not specified', () => {
    resizeImageWithFfmpeg('/in.jpg', '/out.jpg', 0.4);

    const [, , options] = execFileSync.mock.calls[0];
    expect(options).toEqual({ stdio: 'inherit' });
  });

  it('respects a custom stdio option', () => {
    resizeImageWithFfmpeg('/in.jpg', '/out.jpg', 0.4, { stdio: 'pipe' });

    const [, , options] = execFileSync.mock.calls[0];
    expect(options).toEqual({ stdio: 'pipe' });
  });

  it('propagates errors from execFileSync (e.g. ffmpeg failure)', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('ffmpeg failed');
    });

    expect(() => resizeImageWithFfmpeg('/in.jpg', '/out.jpg', 0.4)).toThrow('ffmpeg failed');
  });
});
