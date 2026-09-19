/* eslint-env jest */
jest.mock('../../../logger');
// rangeFileServe.js now calls streamDebug (./streamDebug), which
// transitively requires configModule - the real configModule constructor
// reads config.json and calls logger.setLevel at module-load time, neither
// of which the plain logger mock above provides.
jest.mock('../../configModule', () => ({
  getConfig: jest.fn(() => ({})),
  directoryPath: '/tmp/youtarr-test-mock',
}));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');
const { parseSingleRange, serveFileWithRangeSupport } = require('../rangeFileServe');

describe('parseSingleRange', () => {
  it('parses a start-end range', () => {
    expect(parseSingleRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
  });

  it('parses an open-ended range ("bytes=start-")', () => {
    expect(parseSingleRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('parses a suffix range ("bytes=-N" means the last N bytes)', () => {
    expect(parseSingleRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('clamps end to the last valid byte when it exceeds the file size', () => {
    expect(parseSingleRange('bytes=0-2000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('returns null for a malformed range header', () => {
    expect(parseSingleRange('not-a-range', 1000)).toBeNull();
  });

  it('returns null for a multi-range request (only single ranges are supported)', () => {
    expect(parseSingleRange('bytes=0-10,20-30', 1000)).toBeNull();
  });
});

describe('serveFileWithRangeSupport', () => {
  let filePath;
  const content = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // 26 bytes

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `range-file-serve-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(filePath, content);
  });

  afterEach(() => {
    fs.rmSync(filePath, { force: true });
  });

  function createMockRes() {
    const chunks = [];
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    res.headers = {};
    res.statusCode = null;
    res.set = jest.fn((nameOrObj, value) => {
      if (typeof nameOrObj === 'string') res.headers[nameOrObj.toLowerCase()] = value;
      else Object.entries(nameOrObj).forEach(([k, v]) => { res.headers[k.toLowerCase()] = v; });
      return res;
    });
    res.status = jest.fn((code) => { res.statusCode = code; return res; });
    res.send = jest.fn();
    res.body = () => Buffer.concat(chunks).toString('utf8');
    return res;
  }

  function waitForFinish(res) {
    return new Promise((resolve) => res.on('finish', resolve));
  }

  // fs.stat is async, so the 416/404 early-return paths (no stream piped,
  // so no 'finish' event) need polling rather than a fixed-shape event to
  // await.
  function waitUntil(conditionFn, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (conditionFn()) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
        setTimeout(check, 5);
      };
      check();
    });
  }

  it('serves the whole file with a 200 when no Range header is present', async () => {
    const res = createMockRes();
    const req = { headers: {} };
    serveFileWithRangeSupport(filePath, req, res, 'text/plain');
    await waitForFinish(res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-length']).toBe(String(content.length));
    expect(res.body()).toBe(content);
  });

  it('serves a 206 Partial Content for a valid Range request', async () => {
    const res = createMockRes();
    const req = { headers: { range: 'bytes=0-4' } };
    serveFileWithRangeSupport(filePath, req, res, 'text/plain');
    await waitForFinish(res);
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-4/${content.length}`);
    expect(res.headers['content-length']).toBe('5');
    expect(res.body()).toBe('ABCDE');
  });

  it('serves the last N bytes for a suffix Range request', async () => {
    const res = createMockRes();
    const req = { headers: { range: 'bytes=-5' } };
    serveFileWithRangeSupport(filePath, req, res, 'text/plain');
    await waitForFinish(res);
    expect(res.body()).toBe('VWXYZ');
  });

  it('reports the bytes actually sent through onBytesSent', async () => {
    const res = createMockRes();
    const req = { headers: { range: 'bytes=0-4' } };
    const onBytesSent = jest.fn();
    serveFileWithRangeSupport(filePath, req, res, 'text/plain', undefined, onBytesSent);
    await waitForFinish(res);
    expect(onBytesSent.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)).toBe(5);
  });

  it('counts only the bytes read when the client disconnects before the response completes', async () => {
    const bigPath = path.join(os.tmpdir(), `range-file-serve-big-${Date.now()}.bin`);
    fs.writeFileSync(bigPath, Buffer.alloc(8 * 1024 * 1024));
    try {
      const res = createMockRes();
      const req = { headers: { range: 'bytes=0-' } };
      let total = 0;
      serveFileWithRangeSupport(bigPath, req, res, 'video/mp4', undefined, (bytes) => {
        total += bytes;
        res.destroy(); // client goes away after the first chunk
      });
      await new Promise((resolve) => res.on('close', resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(total).toBeLessThan(1024 * 1024);
    } finally {
      fs.rmSync(bigPath, { force: true });
    }
  });

  it('still calls onServed once with the requested length', async () => {
    const res = createMockRes();
    const req = { headers: { range: 'bytes=0-4' } };
    const onServed = jest.fn();
    serveFileWithRangeSupport(filePath, req, res, 'text/plain', onServed);
    await waitForFinish(res);
    expect(onServed).toHaveBeenCalledWith(5);
  });

  it('responds 416 for a malformed Range header', async () => {
    const res = createMockRes();
    const req = { headers: { range: 'garbage' } };
    serveFileWithRangeSupport(filePath, req, res, 'text/plain');
    await waitUntil(() => res.statusCode !== null);
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${content.length}`);
  });

  it('responds 404 when the file does not exist', async () => {
    const res = createMockRes();
    const req = { headers: {} };
    serveFileWithRangeSupport(path.join(os.tmpdir(), 'does-not-exist-at-all.txt'), req, res, 'text/plain');
    await waitUntil(() => res.statusCode !== null);
    expect(res.statusCode).toBe(404);
  });
});
