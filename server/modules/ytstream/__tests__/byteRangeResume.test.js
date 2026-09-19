/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('child_process', () => ({ execFile: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const {
  computeResumeFromSeconds,
  parsePacketScan,
  planSeam,
  findCompleteBoxEnd,
  quoteConcatPath,
  stitchResumeFiles,
} = require('../byteRangeResume');

/** Builds a minimal MP4 box: 4-byte size, 4-char type, zero-filled payload. */
function box(type, payloadBytes) {
  const buf = Buffer.alloc(8 + payloadBytes);
  buf.writeUInt32BE(buf.length, 0);
  buf.write(type, 4, 'latin1');
  return buf;
}

describe('byteRangeResume.computeResumeFromSeconds', () => {
  it('resumes 12 seconds before the cached duration', () => {
    expect(computeResumeFromSeconds(100)).toBe(88);
  });

  it('returns null for a duration too short to be worth resuming', () => {
    expect(computeResumeFromSeconds(10)).toBeNull();
  });

  it('returns null when the duration is unknown', () => {
    expect(computeResumeFromSeconds(null)).toBeNull();
  });
});

describe('byteRangeResume.parsePacketScan', () => {
  it('derives start, end and sorted keyframe times from ffprobe csv output', () => {
    const scan = parsePacketScan('0.000000,0.040000,K__\n0.040000,0.040000,___\n5.000000,0.040000,K__\n');
    expect(scan).toEqual({ startTime: 0, endTime: 5.04, keyframeTimes: [0, 5] });
  });

  it('ignores N/A and blank lines', () => {
    const scan = parsePacketScan('N/A,N/A,K__\n\n1.000000,0.500000,K__\n');
    expect(scan).toEqual({ startTime: 1, endTime: 1.5, keyframeTimes: [1] });
  });

  it('returns null when there are no usable packets', () => {
    expect(parsePacketScan('')).toBeNull();
  });
});

describe('byteRangeResume.planSeam', () => {
  const baseScan = { startTime: 0, endTime: 100 };

  it('cuts at the last resume keyframe at or before the base end minus the safety margin (absolute timestamps)', () => {
    const resumeScan = { startTime: 88, endTime: 130, keyframeTimes: [88, 94, 98, 104] };
    const plan = planSeam({ baseScan, resumeScan, resumeFromSeconds: 88 });
    expect(plan).toMatchObject({ ok: true, absoluteMode: true, cutAbsSeconds: 98, trimStartRelSeconds: 10, expectedEndSeconds: 130 });
  });

  it('maps re-zeroed resume timestamps back onto the video timeline', () => {
    const resumeScan = { startTime: 0, endTime: 42, keyframeTimes: [0, 6, 10, 16] };
    const plan = planSeam({ baseScan, resumeScan, resumeFromSeconds: 88 });
    expect(plan).toMatchObject({ ok: true, absoluteMode: false, cutAbsSeconds: 98, trimStartRelSeconds: 10, expectedEndSeconds: 130 });
  });

  it('refuses when no resume keyframe lands before the base end (would leave a gap)', () => {
    const resumeScan = { startTime: 99, endTime: 130, keyframeTimes: [99, 105] };
    expect(planSeam({ baseScan, resumeScan, resumeFromSeconds: 99 }).ok).toBe(false);
  });

  it('refuses when the resume file has no keyframes', () => {
    expect(planSeam({ baseScan, resumeScan: { startTime: 0, endTime: 1, keyframeTimes: [] }, resumeFromSeconds: 88 }).ok).toBe(false);
  });

  it('refuses when the base file could not be scanned', () => {
    const resumeScan = { startTime: 88, endTime: 130, keyframeTimes: [88] };
    expect(planSeam({ baseScan: null, resumeScan, resumeFromSeconds: 88 }).ok).toBe(false);
  });
});

describe('byteRangeResume.findCompleteBoxEnd', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-resume-test-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const writeBoxes = (...buffers) => {
    const filePath = path.join(tmpDir, 'f.mp4');
    fs.writeFileSync(filePath, Buffer.concat(buffers));
    return filePath;
  };

  it('returns the file size when every box is complete', () => {
    const buffers = [box('ftyp', 8), box('moov', 40), box('moof', 16), box('mdat', 100)];
    const filePath = writeBoxes(...buffers);
    expect(findCompleteBoxEnd(filePath)).toBe(Buffer.concat(buffers).length);
  });

  it('trims a truncated final mdat back to the end of the previous complete fragment', () => {
    const head = Buffer.concat([box('ftyp', 8), box('moov', 40), box('moof', 16), box('mdat', 100)]);
    const truncated = box('mdat', 100).subarray(0, 50);
    const filePath = writeBoxes(head, box('moof', 16), truncated);
    expect(findCompleteBoxEnd(filePath)).toBe(head.length);
  });

  it('never ends on a dangling moof whose mdat is missing', () => {
    const head = Buffer.concat([box('ftyp', 8), box('moov', 40), box('moof', 16), box('mdat', 100)]);
    const filePath = writeBoxes(head, box('moof', 16));
    expect(findCompleteBoxEnd(filePath)).toBe(head.length);
  });

  it('returns 0 for a file with no complete box', () => {
    const filePath = writeBoxes(Buffer.from([0, 0, 0]));
    expect(findCompleteBoxEnd(filePath)).toBe(0);
  });
});

describe('byteRangeResume.quoteConcatPath', () => {
  it('wraps a plain path in single quotes', () => {
    expect(quoteConcatPath('/tmp/a/part1.mp4')).toBe('\'/tmp/a/part1.mp4\'');
  });

  it('escapes an embedded single quote the way ffconcat expects', () => {
    expect(quoteConcatPath('/tmp/O\'Brien/p.mp4')).toBe('\'/tmp/O\'\\\'\'Brien/p.mp4\'');
  });
});

describe('byteRangeResume.stitchResumeFiles', () => {
  let workDir;
  let outPath;

  // Programs execFile by command+args: ffprobe scans are answered per file
  // path, ffmpeg steps succeed unless `ffmpegFails` says otherwise.
  const programExec = ({ scans, ffmpegFails = false }) => {
    execFile.mockImplementation((command, args, opts, cb) => {
      if (command === 'ffprobe') {
        const target = args[args.length - 1];
        cb(null, scans[target] || '', '');
        return;
      }
      if (ffmpegFails) {
        cb(new Error('ffmpeg blew up'), '', 'boom');
        return;
      }
      cb(null, '', '');
    });
  };

  const scanText = (packets) => packets.map(([pts, dur, flags]) => `${pts},${dur},${flags}`).join('\n');

  const args = () => ({
    basePath: '/base.mp4',
    resumePath: '/resume.mp4',
    workDir,
    outPath,
    resumeFromSeconds: 88,
    previousDurationSeconds: 100,
  });

  beforeEach(() => {
    execFile.mockReset();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-stitch-test-'));
    outPath = path.join(workDir, 'out.mp4');
  });
  afterEach(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

  const baseScanText = scanText([[0, 0.04, 'K__'], [99.96, 0.04, '___']]);
  const resumeScanText = scanText([[88, 0.04, 'K__'], [98, 0.04, 'K__'], [129.96, 0.04, '___']]);

  it('runs cut, trim and concat as stream-copy passes and reports the stitched duration', async () => {
    programExec({ scans: { '/base.mp4': baseScanText, '/resume.mp4': resumeScanText, [outPath]: scanText([[0, 0.04, 'K__'], [129.96, 0.04, '___']]) } });
    const result = await stitchResumeFiles(args());
    expect(result).toEqual({ ok: true, durationSeconds: 130 });
    const ffmpegCalls = execFile.mock.calls.filter((call) => call[0] === 'ffmpeg');
    expect(ffmpegCalls).toHaveLength(3);
    expect(ffmpegCalls.every((call) => call[1].includes('copy'))).toBe(true);
  });

  it('trims the resume file to start exactly on the seam keyframe', async () => {
    programExec({ scans: { '/base.mp4': baseScanText, '/resume.mp4': resumeScanText, [outPath]: scanText([[0, 0.04, 'K__'], [129.96, 0.04, '___']]) } });
    await stitchResumeFiles(args());
    const trimCall = execFile.mock.calls.find((call) => call[0] === 'ffmpeg' && call[1].includes('/resume.mp4'));
    expect(trimCall[1].slice(trimCall[1].indexOf('-ss'), trimCall[1].indexOf('-ss') + 2)).toEqual(['-ss', '10']);
  });

  it('rejects a stitch whose duration disagrees with what the resume pass implies', async () => {
    programExec({ scans: { '/base.mp4': baseScanText, '/resume.mp4': resumeScanText, [outPath]: scanText([[0, 0.04, 'K__'], [111.96, 0.04, '___']]) } });
    const result = await stitchResumeFiles(args());
    expect(result.ok).toBe(false);
  });

  it('removes the partial output when validation rejects it', async () => {
    fs.writeFileSync(outPath, 'partial');
    programExec({ scans: { '/base.mp4': baseScanText, '/resume.mp4': resumeScanText, [outPath]: scanText([[0, 0.04, 'K__'], [111.96, 0.04, '___']]) } });
    await stitchResumeFiles(args());
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it('does nothing when the resume pass got no further than the cached duration', async () => {
    programExec({ scans: { '/base.mp4': baseScanText, '/resume.mp4': scanText([[88, 0.04, 'K__'], [99.5, 0.04, '___']]) } });
    const result = await stitchResumeFiles(args());
    expect(result.ok).toBe(false);
    expect(execFile.mock.calls.filter((call) => call[0] === 'ffmpeg')).toHaveLength(0);
  });

  it('reports failure when an ffmpeg step errors', async () => {
    programExec({ scans: { '/base.mp4': baseScanText, '/resume.mp4': resumeScanText }, ffmpegFails: true });
    const result = await stitchResumeFiles(args());
    expect(result.ok).toBe(false);
  });
});
