/* eslint-env jest */
jest.mock('../../../logger');
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const {
  ZERO_TAIL_BYTES,
  isInZeroTail,
  parseDownloadSizeBytes,
  computeDeclaredTotal,
  buildFreeBoxHeader,
  buildVoidElementHeader,
  padFileToSize,
} = require('../byteRangeDeclaredLength');
const { serveDeclaredRange } = require('../byteRangeServe');

const MIB = 1024 * 1024;

describe('byteRangeDeclaredLength.parseDownloadSizeBytes', () => {
  it('reads an exact MiB size from a yt-dlp progress line', () => {
    expect(parseDownloadSizeBytes('[download]  12.3% of  479.48MiB at  5.0MiB/s ETA 00:01')).toBe(Math.round(479.48 * MIB));
  });

  it('reads GiB and KiB units', () => {
    expect(parseDownloadSizeBytes('[download] 1.0% of 2.00GiB at 1MiB/s')).toBe(2 * 1024 * MIB);
    expect(parseDownloadSizeBytes('[download] 1.0% of 512.00KiB at 1MiB/s')).toBe(512 * 1024);
  });

  it('returns null for an estimated size marked with ~', () => {
    expect(parseDownloadSizeBytes('[download]   1.0% of ~  479.48MiB at 1MiB/s')).toBeNull();
  });

  it('skips an estimated size and uses a later exact one in the same chunk', () => {
    expect(parseDownloadSizeBytes('1% of ~ 400.00MiB\r2% of 479.48MiB')).toBe(Math.round(479.48 * MIB));
  });

  it('returns null when there is no size in the text', () => {
    expect(parseDownloadSizeBytes('[youtube] Extracting URL')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseDownloadSizeBytes('')).toBeNull();
  });
});

describe('byteRangeDeclaredLength.computeDeclaredTotal', () => {
  it('is never below the real video + audio size', () => {
    expect(computeDeclaredTotal(480 * MIB, 46 * MIB)).toBeGreaterThan(526 * MIB);
  });

  it('stays within about half a percent above it', () => {
    expect(computeDeclaredTotal(480 * MIB, 46 * MIB)).toBeLessThan(526 * MIB * 1.005 + MIB);
  });
});

describe('byteRangeDeclaredLength.buildFreeBoxHeader', () => {
  it('writes a 32-bit sized free box header', () => {
    const header = buildFreeBoxHeader(5000);
    expect(header.readUInt32BE(0)).toBe(5000);
    expect(header.toString('latin1', 4, 8)).toBe('free');
  });

  it('uses a 64-bit size for a box over 4 GiB', () => {
    const size = 0x1_0000_0000 + 100;
    const header = buildFreeBoxHeader(size);
    expect(header.readUInt32BE(0)).toBe(1);
    expect(Number(header.readBigUInt64BE(8))).toBe(size);
  });

  it('returns plain zeros when the gap is too small for a box', () => {
    expect(buildFreeBoxHeader(5)).toEqual(Buffer.alloc(5));
  });
});

describe('byteRangeDeclaredLength.isInZeroTail', () => {
  it('is true for the last bytes of the declared file', () => {
    expect(isInZeroTail(10 * MIB - 4, 10 * MIB)).toBe(true);
  });

  it('is false for the start of the file', () => {
    expect(isInZeroTail(0, 10 * MIB)).toBe(false);
  });

  it('is false just before the zero tail begins', () => {
    expect(isInZeroTail(10 * MIB - ZERO_TAIL_BYTES - 1, 10 * MIB)).toBe(false);
  });

  it('always lies inside the guaranteed padding, whatever the real size', () => {
    const declared = computeDeclaredTotal(480 * MIB, 46 * MIB);
    const worstCaseReal = (526 * MIB) * 1.0005; // far above the measured +/-0.02%
    expect(declared - worstCaseReal).toBeGreaterThan(ZERO_TAIL_BYTES + 8);
  });
});

describe('byteRangeDeclaredLength.padFileToSize', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-pad-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const fileOf = (bytes) => {
    const filePath = path.join(dir, 'f.mp4');
    fs.writeFileSync(filePath, Buffer.alloc(bytes, 7));
    return filePath;
  };

  it('grows the file to exactly the target size', () => {
    const filePath = fileOf(1000);
    padFileToSize(filePath, 3 * MIB);
    expect(fs.statSync(filePath).size).toBe(3 * MIB);
  });

  it('appends a single free box covering the whole padding', () => {
    const filePath = fileOf(1000);
    padFileToSize(filePath, 5000);
    const bytes = fs.readFileSync(filePath);
    expect(bytes.readUInt32BE(1000)).toBe(4000);
    expect(bytes.toString('latin1', 1004, 1008)).toBe('free');
  });

  it('leaves the original bytes untouched', () => {
    const filePath = fileOf(1000);
    padFileToSize(filePath, 5000);
    expect(fs.readFileSync(filePath).subarray(0, 1000)).toEqual(Buffer.alloc(1000, 7));
  });

  it('is a no-op when the file is already the target size', () => {
    const filePath = fileOf(1000);
    expect(padFileToSize(filePath, 1000)).toEqual({ ok: true, paddedBytes: 0 });
  });

  it('refuses to shrink a file that is bigger than the target', () => {
    const filePath = fileOf(2000);
    const result = padFileToSize(filePath, 1000);
    expect(result.ok).toBe(false);
    expect(fs.statSync(filePath).size).toBe(2000);
  });

  it('reports an error for a missing file', () => {
    expect(padFileToSize(path.join(dir, 'nope.mp4'), 100).ok).toBe(false);
  });
});

describe('byteRangeDeclaredLength mkv', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-mkv-pad-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('declares a larger total for mkv than mp4 from the same stream sizes', () => {
    expect(computeDeclaredTotal(100 * MIB, 10 * MIB, 'mkv')).toBeGreaterThan(computeDeclaredTotal(100 * MIB, 10 * MIB, 'mp4'));
  });

  it('declares the mp4 total when no container is given', () => {
    expect(computeDeclaredTotal(100 * MIB, 10 * MIB)).toBe(computeDeclaredTotal(100 * MIB, 10 * MIB, 'mp4'));
  });

  it('builds a Void element header covering exactly the requested size', () => {
    const header = buildVoidElementHeader(5000);
    expect(header[0]).toBe(0xec);
    expect(header[1]).toBe(0x01);
    expect(header.readUIntBE(3, 6)).toBe(5000 - header.length);
  });

  it('uses zero bytes when the gap is too small for a Void header', () => {
    expect(buildVoidElementHeader(5).equals(Buffer.alloc(5))).toBe(true);
  });

  it('pads an mkv file to the target size with a Void element', () => {
    const filePath = path.join(dir, 'f.mkv');
    fs.writeFileSync(filePath, Buffer.alloc(1000, 7));
    padFileToSize(filePath, 5000, 'mkv');
    const bytes = fs.readFileSync(filePath);
    expect(bytes.length).toBe(5000);
    expect(bytes[1000]).toBe(0xec);
  });
});

describe('byteRangeServe.serveDeclaredRange', () => {
  let dir;
  let streamPath;
  const declaredTotal = 2 * MIB; // realistic: real declared totals always include 1 MB of slack

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-declared-serve-'));
    streamPath = path.join(dir, 'stream.mp4');
    fs.writeFileSync(streamPath, Buffer.from('0123456789'.repeat(100))); // 1000 bytes written so far
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const session = () => ({ key: 'k', streamPath, declaredTotal });

  function mockRes() {
    const chunks = [];
    const res = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk); cb(); } });
    res.headers = {};
    res.statusCode = null;
    res.set = jest.fn((nameOrObj, value) => {
      if (typeof nameOrObj === 'string') res.headers[nameOrObj.toLowerCase()] = value;
      else Object.entries(nameOrObj).forEach(([k, v]) => { res.headers[k.toLowerCase()] = v; });
      return res;
    });
    res.status = jest.fn((code) => { res.statusCode = code; return res; });
    res.body = () => Buffer.concat(chunks).toString('utf8');
    return res;
  }

  const finished = (res) => new Promise((resolve) => res.on('finish', resolve));

  it('reports the DECLARED total in Content-Range even though less is written', async () => {
    const res = mockRes();
    serveDeclaredRange(session(), { headers: { range: 'bytes=0-99' } }, res);
    await finished(res);
    expect(res.headers['content-range']).toBe(`bytes 0-99/${declaredTotal}`);
  });

  it('serves the requested bytes', async () => {
    const res = mockRes();
    serveDeclaredRange(session(), { headers: { range: 'bytes=0-9' } }, res);
    await finished(res);
    expect(res.body()).toBe('0123456789');
  });

  it('caps an open-ended range at the bytes written so far, not the declared total', async () => {
    const res = mockRes();
    serveDeclaredRange(session(), { headers: { range: 'bytes=500-' } }, res);
    await finished(res);
    expect(res.headers['content-range']).toBe(`bytes 500-999/${declaredTotal}`);
    expect(res.headers['content-length']).toBe('500');
  });

  it('answers 416 with the declared total for a start that is not written yet', () => {
    const res = mockRes();
    res.end = jest.fn();
    serveDeclaredRange(session(), { headers: { range: 'bytes=5000-' } }, res);
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${declaredTotal}`);
  });

  it('does not answer a tail read from the zero tail for an mkv session (it waits for real data instead)', () => {
    const res = mockRes();
    res.end = jest.fn();
    serveDeclaredRange({ ...session(), isMkv: true, contentType: 'video/x-matroska' }, { headers: { range: `bytes=${declaredTotal - 4}-` } }, res);
    expect(res.statusCode).toBe(416);
  });

  it('serves the session content type (matroska) with the declared total', async () => {
    const res = mockRes();
    serveDeclaredRange({ ...session(), isMkv: true, contentType: 'video/x-matroska' }, { headers: { range: 'bytes=0-9' } }, res);
    await finished(res);
    expect(res.headers['content-type']).toBe('video/x-matroska');
  });

  it('answers an end-of-file probe at once with zeros, before the encode has reached it', async () => {
    const res = mockRes();
    serveDeclaredRange(session(), { headers: { range: `bytes=${declaredTotal - 4}-` } }, res);
    await finished(res);
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${declaredTotal - 4}-${declaredTotal - 1}/${declaredTotal}`);
    expect(Buffer.from(res.body(), 'latin1').equals(Buffer.alloc(4))).toBe(true);
  });

  it('serves a suffix-range end-of-file probe from the zero tail', async () => {
    const res = mockRes();
    serveDeclaredRange(session(), { headers: { range: 'bytes=-4096' } }, res);
    await finished(res);
    expect(res.headers['content-length']).toBe('4096');
  });

  it('counts the zero-tail bytes it sends', async () => {
    const res = mockRes();
    const onBytesSent = jest.fn();
    serveDeclaredRange(session(), { headers: { range: `bytes=${declaredTotal - 4}-` } }, res, undefined, onBytesSent);
    await finished(res);
    expect(onBytesSent).toHaveBeenCalledWith(4);
  });

  it('treats a missing Range header as a request from byte 0', async () => {
    const res = mockRes();
    serveDeclaredRange(session(), { headers: {} }, res);
    await finished(res);
    expect(res.headers['content-range']).toBe(`bytes 0-999/${declaredTotal}`);
  });

  it('reports the bytes actually sent through onBytesSent', async () => {
    const res = mockRes();
    const onBytesSent = jest.fn();
    serveDeclaredRange(session(), { headers: { range: 'bytes=0-9' } }, res, undefined, onBytesSent);
    await finished(res);
    expect(onBytesSent.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)).toBe(10);
  });
});
