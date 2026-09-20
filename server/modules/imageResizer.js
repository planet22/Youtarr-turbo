const { execFileSync } = require('child_process');
const configModule = require('./configModule');

// -q:v 2 is a fixed "near-lossless" JPEG quality setting shared by every
// caller; no caller has ever needed a different value.
const JPEG_QUALITY = '2';

/**
 * Downscale an image via ffmpeg. Uses execFileSync (no shell), so paths are
 * passed as-is with no shell-quoting/injection concerns.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {number} scaleFactor - e.g. 0.4 to scale to 40% of original size
 * @param {{ stdio?: string }} [options]
 */
function resizeImageWithFfmpeg(inputPath, outputPath, scaleFactor, options = {}) {
  execFileSync(
    configModule.ffmpegPath,
    [
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vf', `scale=iw*${scaleFactor}:ih*${scaleFactor}`,
      '-q:v', JPEG_QUALITY,
      outputPath,
    ],
    { stdio: options.stdio || 'inherit' }
  );
}

module.exports = { resizeImageWithFfmpeg };
