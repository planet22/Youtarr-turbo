/* eslint-env jest */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseInitBoxes, buildDurationPatches, patchFileHeaderDuration, patchMkvHeaderDuration, parseFfmpegInputDurations } = require('../byteRangeHeaderDuration');

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function mvhdBox({ version = 0, timescale = 1000, duration = 0 } = {}) {
  const payload = version === 1
    ? Buffer.alloc(4 + 8 + 8 + 4 + 8 + 80)
    : Buffer.alloc(4 + 4 + 4 + 4 + 4 + 80);
  payload[0] = version;
  if (version === 1) {
    payload.writeUInt32BE(timescale, 20);
    payload.writeBigUInt64BE(BigInt(duration), 24);
  } else {
    payload.writeUInt32BE(timescale, 12);
    payload.writeUInt32BE(duration, 16);
  }
  return box('mvhd', payload);
}

function mehdBox({ version = 1, duration = 0 } = {}) {
  const payload = Buffer.alloc(version === 1 ? 12 : 8);
  payload[0] = version;
  if (version === 1) payload.writeBigUInt64BE(BigInt(duration), 4);
  else payload.writeUInt32BE(duration, 4);
  return box('mehd', payload);
}

/** ftyp + moov(mvhd, trak, mvex(mehd, trex)) - the layout of an ffmpeg fMP4 init segment. */
function initSegment({ mvhd = mvhdBox(), mehd = mehdBox(), withMehd = true } = {}) {
  const mvex = box('mvex', Buffer.concat([withMehd ? mehd : Buffer.alloc(0), box('trex', Buffer.alloc(24))]));
  const moov = box('moov', Buffer.concat([mvhd, box('trak', Buffer.alloc(40)), mvex]));
  return Buffer.concat([box('ftyp', Buffer.from('iso5....')), moov]);
}

const fragment = () => Buffer.concat([box('moof', Buffer.alloc(32)), box('mdat', Buffer.alloc(200, 9))]);

describe('byteRangeHeaderDuration.parseInitBoxes', () => {
  it('lists the boxes it walked, including nested moov and mvex children', () => {
    expect(parseInitBoxes(initSegment()).boxes).toEqual(
      expect.arrayContaining(['ftyp', 'moov', 'moov/mvhd', 'moov/trak', 'moov/mvex', 'mvex/mehd', 'mvex/trex'])
    );
  });

  it('finds the mvhd timescale', () => {
    expect(parseInitBoxes(initSegment({ mvhd: mvhdBox({ timescale: 90000 }) })).mvhd.timescale).toBe(90000);
  });

  it('reports no mehd when the init segment has none', () => {
    expect(parseInitBoxes(initSegment({ withMehd: false })).mehd).toBeNull();
  });

  it('stops at the first moof', () => {
    expect(parseInitBoxes(Buffer.concat([initSegment(), fragment()])).boxes).toContain('moof');
  });

  it('reports the moov as incomplete when the buffer ends inside it', () => {
    const init = initSegment();
    expect(parseInitBoxes(init.subarray(0, init.length - 10)).moovComplete).toBe(false);
  });
});

describe('byteRangeHeaderDuration.buildDurationPatches', () => {
  it('converts the duration to movie-timescale units for both mvhd and mehd', () => {
    const built = buildDurationPatches(initSegment({ mvhd: mvhdBox({ timescale: 1000 }) }), 2848.5);
    expect(built.patches.map((p) => p.field)).toEqual(['mvhd', 'mehd']);
    expect(built.patches[0].bytes.readUInt32BE(0)).toBe(2848500);
    expect(built.patches[1].bytes.readBigUInt64BE(0)).toBe(2848500n);
  });

  it('patches only mvhd when there is no mehd', () => {
    const built = buildDurationPatches(initSegment({ withMehd: false }), 100);
    expect(built.patches.map((p) => p.field)).toEqual(['mvhd']);
  });

  it('handles a 64-bit (version 1) mvhd', () => {
    const built = buildDurationPatches(initSegment({ mvhd: mvhdBox({ version: 1, timescale: 1000 }) }), 100);
    expect(built.patches[0].bytes.readBigUInt64BE(0)).toBe(100000n);
  });

  it('handles a 32-bit (version 0) mehd', () => {
    const built = buildDurationPatches(initSegment({ mehd: mehdBox({ version: 0 }) }), 100);
    expect(built.patches.find((p) => p.field === 'mehd').bytes.readUInt32BE(0)).toBe(100000);
  });

  it('asks the caller to retry while the init segment is not fully written', () => {
    const init = initSegment();
    const built = buildDurationPatches(init.subarray(0, init.length - 10), 100);
    expect(built.ok).toBe(false);
    expect(built.retry).toBe(true);
  });

  it('fails without retry when the mvhd timescale is zero', () => {
    const built = buildDurationPatches(initSegment({ mvhd: mvhdBox({ timescale: 0 }) }), 100);
    expect(built.ok).toBe(false);
    expect(built.retry).toBe(false);
  });
});

describe('byteRangeHeaderDuration.patchFileHeaderDuration', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byterange-header-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const writeFile = (buffer) => {
    const filePath = path.join(dir, 'stream.mp4');
    fs.writeFileSync(filePath, buffer);
    return filePath;
  };

  it('writes the duration into the file in place without changing its length', () => {
    const content = Buffer.concat([initSegment(), fragment()]);
    const filePath = writeFile(content);
    patchFileHeaderDuration(filePath, 2848.5);
    expect(fs.statSync(filePath).size).toBe(content.length);
  });

  it('makes the patched duration readable back from the file', () => {
    const filePath = writeFile(Buffer.concat([initSegment(), fragment()]));
    patchFileHeaderDuration(filePath, 2848.5);
    const head = fs.readFileSync(filePath);
    const found = parseInitBoxes(head);
    expect(head.readUInt32BE(found.mvhd.durationOffset)).toBe(2848500);
  });

  it('leaves everything after the init segment untouched', () => {
    const init = initSegment();
    const filePath = writeFile(Buffer.concat([init, fragment()]));
    patchFileHeaderDuration(filePath, 100);
    expect(fs.readFileSync(filePath).subarray(init.length)).toEqual(fragment());
  });

  it('reports which fields it patched and the boxes it saw', () => {
    const filePath = writeFile(initSegment());
    const result = patchFileHeaderDuration(filePath, 100);
    expect(result).toMatchObject({ ok: true, patched: ['mvhd', 'mehd'] });
    expect(result.boxes).toContain('mvex/mehd');
  });

  it('refuses a missing or non-positive duration', () => {
    const filePath = writeFile(initSegment());
    expect(patchFileHeaderDuration(filePath, 0).ok).toBe(false);
    expect(patchFileHeaderDuration(filePath, NaN).ok).toBe(false);
  });

  it('asks to retry for a file that does not exist yet', () => {
    expect(patchFileHeaderDuration(path.join(dir, 'missing.mp4'), 100)).toMatchObject({ ok: false, retry: true });
  });
});

describe('patchMkvHeaderDuration', () => {
  const INFO_ID = Buffer.from([0x15, 0x49, 0xa9, 0x66]);
  let dir;
  let file;

  function writeMkv(...parts) {
    fs.writeFileSync(file, Buffer.concat(parts));
  }

  function readDurationAt(offset) {
    const buf = fs.readFileSync(file);
    expect(buf.subarray(offset, offset + 3)).toEqual(Buffer.from([0x44, 0x89, 0x88]));
    return buf.readDoubleBE(offset + 3);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkvpatch-'));
    file = path.join(dir, 'a.mkv');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('overwrites an existing Duration element with the duration in milliseconds', () => {
    const existing = Buffer.concat([Buffer.from([0x44, 0x89, 0x88]), Buffer.alloc(8)]);
    writeMkv(Buffer.alloc(20), INFO_ID, Buffer.from([0x90]), existing, Buffer.alloc(100));
    const result = patchMkvHeaderDuration(file, 2876.14);
    expect(result.ok).toBe(true);
    expect(readDurationAt(25)).toBeCloseTo(2876140, 3);
  });

  it('turns a reserved 11-byte Void slot into a Duration element', () => {
    const voidSlot = Buffer.concat([Buffer.from([0xec, 0x89]), Buffer.alloc(9)]);
    writeMkv(INFO_ID, Buffer.from([0x90]), voidSlot, Buffer.alloc(100));
    const result = patchMkvHeaderDuration(file, 120);
    expect(result.ok).toBe(true);
    expect(result.patched).toEqual(['reserved Void slot']);
    expect(readDurationAt(5)).toBe(120000);
  });

  it('finds a Void slot written with an 8-byte size vint (EC 01 00.. 02)', () => {
    const voidSlot = Buffer.concat([Buffer.from([0xec, 0x01, 0, 0, 0, 0, 0, 0, 0x02]), Buffer.alloc(2)]);
    writeMkv(INFO_ID, Buffer.from([0x90]), voidSlot, Buffer.alloc(100));
    const result = patchMkvHeaderDuration(file, 30);
    expect(result.ok).toBe(true);
    expect(readDurationAt(5)).toBe(30000);
  });

  it('reports a hex dump of Segment Info when no slot exists', () => {
    writeMkv(INFO_ID, Buffer.alloc(200, 0x11));
    const result = patchMkvHeaderDuration(file, 30);
    expect(result.ok).toBe(false);
    expect(result.infoHex.startsWith('1549a966')).toBe(true);
  });

  it('asks the caller to retry while Segment Info has not been written yet', () => {
    writeMkv(Buffer.alloc(64));
    const result = patchMkvHeaderDuration(file, 60);
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it('asks the caller to retry while the file does not exist', () => {
    const result = patchMkvHeaderDuration(path.join(dir, 'missing.mkv'), 60);
    expect(result).toMatchObject({ ok: false, retry: true });
  });

  it('rejects an unusable duration without touching the file', () => {
    writeMkv(Buffer.alloc(64));
    expect(patchMkvHeaderDuration(file, 0)).toMatchObject({ ok: false, retry: false });
  });
});

describe('byteRangeHeaderDuration.parseFfmpegInputDurations', () => {
  const banner = (n, duration) => `Input #${n}, mov,mp4,m4a,3gp,3g2,mj2, from 'pipe:${n + 3}':\n  Duration: ${duration}, start: 0.000000, bitrate: N/A\n`;

  it('reads hours, minutes and fractional seconds', () => {
    expect(parseFfmpegInputDurations(banner(0, '00:47:28.56'))).toEqual([2848.56]);
  });

  it('returns one entry per input, in order', () => {
    expect(parseFfmpegInputDurations(banner(0, '00:47:28.56') + banner(1, '00:47:28.61'))).toEqual([2848.56, 2848.61]);
  });

  it('ignores an input whose duration is N/A', () => {
    expect(parseFfmpegInputDurations(banner(0, 'N/A') + banner(1, '00:00:10.00'))).toEqual([10]);
  });

  it('handles durations over an hour', () => {
    expect(parseFfmpegInputDurations(banner(0, '03:00:00.00'))).toEqual([10800]);
  });

  it('returns nothing for text without a duration', () => {
    expect(parseFfmpegInputDurations('[hls @ 0x55] Opening file for writing')).toEqual([]);
  });

  it('returns nothing for empty input', () => {
    expect(parseFfmpegInputDurations('')).toEqual([]);
  });
});
