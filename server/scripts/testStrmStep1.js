/**
 * Manual STRM test (no HTTP server required for file write; needs yt-dlp).
 *
 * From Youtarr project root (or container workdir that contains server/):
 *   node server/scripts/testStrmStep1.js <youtubeId> [outputDir]
 *
 * Example:
 *   node server/scripts/testStrmStep1.js dQw4w9WgXcQ /tmp/youtarr-strm-test
 */

const path = require('path');
const fs = require('fs');

const strmMaterializer = require('../modules/strmMaterializer');

async function main() {
  const youtubeId = process.argv[2];
  const outputRoot = process.argv[3];

  if (!youtubeId) {
    console.error('Usage: node server/scripts/testStrmStep1.js <youtubeId> [outputDir]');
    process.exit(1);
  }

  // If a custom output dir is given, temporarily point directoryPath via env is hard;
  // materializer uses configModule.directoryPath. Prefer running with DATA_PATH set,
  // or pass nothing and inspect under the configured downloads root.
  if (outputRoot) {
    process.env.DATA_PATH = outputRoot;
    // configModule may already be cached; materializer reads directoryPath at call time
    const configModule = require('../modules/configModule');
    configModule.directoryPath = outputRoot;
  }

  console.log('Materializing STRM for', youtubeId);
  const result = await strmMaterializer.materializeOne(youtubeId, {
    skipVideoFolder: false,
  });

  console.log(JSON.stringify({
    youtubeId: result.youtubeId,
    strmPath: result.strmPath,
    nfoPath: result.nfoPath,
    thumbPath: result.thumbPath,
    videoDir: result.videoDir,
  }, null, 2));

  if (result.strmPath && fs.existsSync(result.strmPath)) {
    console.log('STRM content:', fs.readFileSync(result.strmPath, 'utf8').trim());
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
