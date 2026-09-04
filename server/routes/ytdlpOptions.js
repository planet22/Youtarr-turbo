const express = require('express');
const customArgsParser = require('../modules/download/customArgsParser');
const ytdlpValidator = require('../modules/download/ytdlpValidator');
const hardwareCapabilityTester = require('../modules/hardwareCapabilityTester');
const streamTuningBenchmark = require('../modules/streamTuningBenchmark');
const streamEncoderTuning = require('../modules/streamEncoderTuning');

// Matches the numeric values in the Ytstream Settings "Stream quality" dropdown.
const TUNING_BENCHMARK_HEIGHTS = [480, 720, 1080, 1440, 2160];

/**
 * @swagger
 * /api/ytdlp/validate-args:
 *   post:
 *     summary: Validate custom yt-dlp arguments
 *     description: Tokenize, denylist-check, and dry-run user-supplied yt-dlp args via `yt-dlp ... --help`. Argparse runs first; help text is discarded and no network calls are made.
 *     tags: [Configuration]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [args]
 *             properties:
 *               args:
 *                 type: string
 *                 description: Raw command-line args, max 2000 characters
 *     responses:
 *       200:
 *         description: Validation result. `ok=true` means args parsed cleanly; `ok=false` means yt-dlp rejected them and `stderr` contains the message.
 *       400:
 *         description: Input failed local checks (not a string, too long, parse error, or denylisted flag).
 *       401:
 *         description: Missing or invalid auth token.
 *       429:
 *         description: Rate limit exceeded.
 */
function createYtdlpOptionsRoutes({ verifyToken, ytdlpValidationRateLimiter }) {
  const router = express.Router();

  router.post(
    '/api/ytdlp/validate-args',
    verifyToken,
    ytdlpValidationRateLimiter,
    async (req, res) => {
      const { args } = req.body || {};
      if (typeof args !== 'string') {
        return res.status(400).json({ error: 'args must be a string' });
      }
      if (args.length > customArgsParser.MAX_CUSTOM_ARGS_LENGTH) {
        return res.status(400).json({
          error: `args exceed ${customArgsParser.MAX_CUSTOM_ARGS_LENGTH} character limit`,
        });
      }

      let tokens;
      try {
        tokens = customArgsParser.tokenize(args);
      } catch (err) {
        return res.status(400).json({ error: `Parse error: ${err.message}` });
      }

      const validation = customArgsParser.validate(tokens);
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error });
      }

      const result = await ytdlpValidator.dryRun(tokens);
      if (result.ok) {
        return res.json({ ok: true, message: 'Arguments parsed successfully' });
      }
      return res.json({ ok: false, stderr: result.stderr });
    }
  );

  /**
   * @swagger
   * /api/ytdlp/test-hardware-capabilities:
   *   post:
   *     summary: Test which hardware/software encoder+codec combinations actually work on this host
   *     description: For every hardwareMode (none/qsv/nvenc/vaapi/amf) x videoCodec (h264/hevc/av1) combination, runs a real 1-second ffmpeg encode against a synthetic test pattern (no video file needed) using the exact same args the real download-transcode would use, and reports whether it actually succeeded - not just whether the arguments parse. Sequential, so this can take up to ~15-120 seconds depending on how many combinations fail (each failing attempt still waits out its own timeout).
   *     tags: [Configuration]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Support matrix - { [hardwareMode]{ [videoCodec]{ ok, error? } } }.
   *       401:
   *         description: Missing or invalid auth token.
   *       429:
   *         description: Rate limit exceeded.
   */
  router.post(
    '/api/ytdlp/test-hardware-capabilities',
    verifyToken,
    ytdlpValidationRateLimiter,
    async (req, res) => {
      try {
        const matrix = await hardwareCapabilityTester.testAllCapabilities();
        res.json({ ok: true, matrix });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message || 'Hardware capability test failed' });
      }
    }
  );

  /**
   * @swagger
   * /api/ytdlp/test-tuning-benchmark:
   *   post:
   *     summary: Benchmark real-time encode speed for one hardware encoder's tuning tiers, at every Stream quality resolution
   *     description: Scoped to the single hardwareMode passed in the body (the one actually selected in Settings - not every possible encoder). For every tuning tier (fast/balanced/quality) x resolution (480/720/1080/1440/2160), runs a real timed ffmpeg encode using the exact args ytstream.js's live playback path would use, and reports whether it ran fast enough (with safety margin) to be safe for real-time HLS/live-pipe streaming at that resolution. Broadcasts tuningBenchmarkProgress WebSocket messages as it goes. Sequential; 3 x 5 = 15 short encodes, typically well under a minute.
   *     tags: [Configuration]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [hardwareMode]
   *             properties:
   *               hardwareMode:
   *                 type: string
   *                 enum: [none, qsv, nvenc, vaapi, amf]
   *               vaapiQuality:
   *                 type: integer
   *                 nullable: true
   *                 description: VAAPI-only -quality (compression_level) override, 1-7. Ignored for every other hardwareMode. Sent so the benchmark measures exactly what a real vaapi stream would use, including this setting.
   *     responses:
   *       200:
   *         description: '{ hardwareMode, matrix: { [height]: { [tuning]: { ok, wallSeconds?, realtimeFactor?, realtime?, error? } } }, recommended: { [height]: tuningTierId|null } }'
   *       400:
   *         description: Missing or invalid hardwareMode.
   *       401:
   *         description: Missing or invalid auth token.
   *       409:
   *         description: A tuning benchmark is already running.
   *       429:
   *         description: Rate limit exceeded.
   */
  router.post(
    '/api/ytdlp/test-tuning-benchmark',
    verifyToken,
    ytdlpValidationRateLimiter,
    async (req, res) => {
      const { hardwareMode, vaapiQuality } = req.body || {};
      if (!streamEncoderTuning.VALID_HARDWARE.includes(hardwareMode)) {
        return res.status(400).json({
          ok: false,
          error: `hardwareMode must be one of: ${streamEncoderTuning.VALID_HARDWARE.join(', ')}`,
        });
      }
      if (streamTuningBenchmark.isBenchmarkRunning()) {
        return res.status(409).json({ ok: false, error: 'A tuning benchmark is already running' });
      }
      try {
        const { matrix, recommended } = await streamTuningBenchmark.runBenchmark(hardwareMode, TUNING_BENCHMARK_HEIGHTS, {
          vaapiQuality: streamEncoderTuning.normalizeVaapiQuality(vaapiQuality),
        });
        res.json({ ok: true, hardwareMode, matrix, recommended });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message || 'Encoding tuning benchmark failed' });
      }
    }
  );

  return router;
}

module.exports = createYtdlpOptionsRoutes;
