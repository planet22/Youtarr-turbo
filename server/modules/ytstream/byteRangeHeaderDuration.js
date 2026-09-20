/**
 * server/modules/ytstream/byteRangeHeaderDuration.js
 *
 * Writes a video's real duration into the header of a still-growing
 * fragmented MP4, in place. ffmpeg's HLS single_file fMP4 output starts with
 * an init segment whose duration fields are all zero (the length isn't known
 * while encoding), so a reader has to walk every fragment to work the
 * duration out - which for a growing file means reading it all, and
 * waiting for the download. With the duration in the header a reader can
 * take it directly:
 *
 *  - `mehd` (movie extends header): the standard place a fragmented file
 *    states its total duration, in movie-timescale units.
 *  - `mvhd` (movie header): the movie-level duration.
 *
 * Both are fixed-size fields, so patching them never moves a byte offset.
 * Where the duration comes from (ffmpeg's own read of the input headers, else
 * the cached yt-dlp metadata) is the caller's business; this module only
 * edits bytes and parses ffmpeg's startup log.
 */
const fs = require('fs');

// The init segment (ftyp + moov) is ~1.5 KB; this is only a safety bound.
const HEADER_SCAN_BYTES = 64 * 1024;
const BOX_HEADER_BYTES = 8;
const CONTAINER_BOXES = new Set(['moov', 'mvex']);
const MAX_UINT32 = 0xffffffff;

/**
 * Walks the top-level boxes and the children of moov/mvex up to the first
 * moof (or the end of the buffer).
 * @returns {{boxes: string[], mvhd: object|null, mehd: object|null, moovComplete: boolean}}
 */
function parseInitBoxes(buf) {
  const found = { boxes: [], mvhd: null, mehd: null, moovComplete: false };

  const walk = (start, end, path) => {
    let offset = start;
    while (offset + BOX_HEADER_BYTES <= end) {
      const size = buf.readUInt32BE(offset);
      const type = buf.toString('latin1', offset + 4, offset + 8);
      if (size < BOX_HEADER_BYTES || offset + size > end) return false;
      found.boxes.push(path ? `${path}/${type}` : type);
      const payload = offset + BOX_HEADER_BYTES;
      if (type === 'moof') return true;
      if (type === 'mvhd') found.mvhd = readTimescaleBox(buf, payload, offset + size);
      if (type === 'mehd') found.mehd = readMehd(buf, payload, offset + size);
      if (CONTAINER_BOXES.has(type)) {
        const ok = walk(payload, offset + size, type);
        if (type === 'moov') found.moovComplete = ok !== false;
      }
      offset += size;
    }
    return true;
  };

  walk(0, buf.length, '');
  return found;
}

/** mvhd: version(1)+flags(3), creation, modification, timescale(4), duration - 32-bit fields for v0, 64-bit creation/modification/duration for v1. */
function readTimescaleBox(buf, payload, boxEnd) {
  const version = buf[payload];
  const timescaleOffset = payload + 4 + (version === 1 ? 16 : 8);
  const durationSize = version === 1 ? 8 : 4;
  const durationOffset = timescaleOffset + 4;
  if (durationOffset + durationSize > boxEnd) return null;
  return { timescale: buf.readUInt32BE(timescaleOffset), durationOffset, durationSize };
}

/** mehd: version(1)+flags(3), fragment_duration (64-bit for v1, else 32-bit). */
function readMehd(buf, payload, boxEnd) {
  const version = buf[payload];
  const durationSize = version === 1 ? 8 : 4;
  const durationOffset = payload + 4;
  if (durationOffset + durationSize > boxEnd) return null;
  return { durationOffset, durationSize };
}

const FFMPEG_DURATION_PATTERN = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g;

/**
 * Pulls every input duration out of ffmpeg's startup log (`Input #0, ...
 * Duration: 00:47:28.00, start: ...`). `Duration: N/A` never matches.
 * @param {string} text - a chunk of ffmpeg stderr
 * @returns {number[]} durations in seconds, in the order they appear
 */
function parseFfmpegInputDurations(text) {
  const durations = [];
  for (const match of String(text || '').matchAll(FFMPEG_DURATION_PATTERN)) {
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (Number.isFinite(seconds) && seconds > 0) durations.push(seconds);
  }
  return durations;
}

function encodeDuration(units, size) {
  const out = Buffer.alloc(size);
  if (size === 8) out.writeBigUInt64BE(BigInt(units));
  else out.writeUInt32BE(units);
  return out;
}

/**
 * @param {Buffer} head - the start of the file
 * @param {number} durationSeconds
 * @returns {{ok: true, patches: Array<{offset: number, bytes: Buffer, field: string}>, boxes: string[]} | {ok: false, reason: string, retry: boolean, boxes: string[]}}
 *   `retry` is true when the init segment simply isn't fully written yet
 */
function buildDurationPatches(head, durationSeconds) {
  const found = parseInitBoxes(head);
  if (!found.moovComplete || !found.mvhd) {
    return { ok: false, retry: !found.moovComplete, reason: 'init segment not complete or has no mvhd', boxes: found.boxes };
  }
  const { timescale } = found.mvhd;
  if (!timescale) return { ok: false, retry: false, reason: 'mvhd timescale is zero', boxes: found.boxes };
  const units = Math.round(durationSeconds * timescale);
  const patches = [];
  for (const [field, box] of [['mvhd', found.mvhd], ['mehd', found.mehd]]) {
    if (!box) continue;
    if (box.durationSize === 4 && units > MAX_UINT32) continue;
    patches.push({ field, offset: box.durationOffset, bytes: encodeDuration(units, box.durationSize) });
  }
  return { ok: true, patches, boxes: found.boxes };
}

/**
 * Writes `durationSeconds` into the header of the MP4 at `filePath`, in
 * place. Never throws.
 * @returns {{ok: true, patched: string[], boxes: string[]} | {ok: false, reason: string, retry: boolean, boxes?: string[]}}
 */
function patchFileHeaderDuration(filePath, durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { ok: false, retry: false, reason: 'no usable duration' };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r+');
    const head = Buffer.alloc(HEADER_SCAN_BYTES);
    const bytesRead = fs.readSync(fd, head, 0, HEADER_SCAN_BYTES, 0);
    const built = buildDurationPatches(head.subarray(0, bytesRead), durationSeconds);
    if (!built.ok) return built;
    for (const patch of built.patches) fs.writeSync(fd, patch.bytes, 0, patch.bytes.length, patch.offset);
    return { ok: true, patched: built.patches.map((p) => p.field), boxes: built.boxes };
  } catch (err) {
    return { ok: false, retry: err.code === 'ENOENT', reason: `cannot patch header: ${err.message}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Matroska: Segment Info (ID 15 49 A9 66) holds `Duration` (44 89 88 + an
// 8-byte big-endian double, in TimecodeScale units - ffmpeg's 1 ms). Written
// to a non-seekable output ffmpeg leaves the field at 0 or reserves the same
// 11 bytes as an EBML Void (EC 89 + 9 bytes), so either can be overwritten
// in place with a Duration element and nothing shifts.
const MKV_SEGMENT_INFO_ID = Buffer.from([0x15, 0x49, 0xa9, 0x66]);
const MKV_DURATION_ID = Buffer.from([0x44, 0x89, 0x88]);
const MKV_VOID_ID = 0xec;
const MKV_DURATION_FIELD_BYTES = 11;
const MKV_INFO_SEARCH_BYTES = 512;
const MKV_INFO_DUMP_BYTES = 128;
const MKV_INFO_SCAN_BYTES = 4096;
const MKV_MS_PER_SECOND = 1000;

/**
 * Finds an EBML Void element occupying exactly 11 bytes (ID + size vint +
 * body), whatever size encoding ffmpeg used for it (`EC 89 ...` or the
 * 8-byte-vint form `EC 01 00 ... 02`).
 * @returns {number} its offset in `view`, or -1
 */
function findDurationVoidSlot(view, from) {
  const limit = Math.min(view.length, from + MKV_INFO_SEARCH_BYTES);
  for (let at = view.indexOf(MKV_VOID_ID, from); at >= 0 && at < limit; at = view.indexOf(MKV_VOID_ID, at + 1)) {
    const first = view[at + 1];
    if (first === undefined || first === 0) continue;
    const vintBytes = Math.clz32(first) - 23;
    if (at + 1 + vintBytes > view.length) continue;
    let bodyBytes = first & (0xff >> vintBytes);
    for (let i = 1; i < vintBytes; i += 1) bodyBytes = bodyBytes * 256 + view[at + 1 + i];
    if (1 + vintBytes + bodyBytes === MKV_DURATION_FIELD_BYTES) return at;
  }
  return -1;
}

/**
 * Writes `durationSeconds` into the Duration field of the Matroska file at
 * `filePath`, in place. Never throws.
 * @returns {{ok: true, patched: string[], boxes: string[]} | {ok: false, reason: string, retry: boolean}}
 *   `retry` is true while the Segment Info isn't written yet
 */
function patchMkvHeaderDuration(filePath, durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { ok: false, retry: false, reason: 'no usable duration' };
  let fd;
  try {
    fd = fs.openSync(filePath, 'r+');
    const head = Buffer.alloc(MKV_INFO_SCAN_BYTES);
    const bytesRead = fs.readSync(fd, head, 0, MKV_INFO_SCAN_BYTES, 0);
    const view = head.subarray(0, bytesRead);
    const infoAt = view.indexOf(MKV_SEGMENT_INFO_ID);
    if (infoAt < 0) return { ok: false, retry: bytesRead < MKV_INFO_SCAN_BYTES, reason: 'Segment Info not found in the first bytes' };
    let at = view.indexOf(MKV_DURATION_ID, infoAt);
    let kind = 'Duration';
    if (at < 0) {
      at = findDurationVoidSlot(view, infoAt);
      kind = 'reserved Void slot';
    }
    if (at < 0 || at + MKV_DURATION_FIELD_BYTES > bytesRead) {
      return {
        ok: false, retry: false, reason: 'no Duration or Void slot in Segment Info',
        infoHex: view.subarray(infoAt, infoAt + MKV_INFO_DUMP_BYTES).toString('hex'),
      };
    }
    const field = Buffer.alloc(MKV_DURATION_FIELD_BYTES);
    MKV_DURATION_ID.copy(field, 0);
    field.writeDoubleBE(durationSeconds * MKV_MS_PER_SECOND, 3);
    fs.writeSync(fd, field, 0, field.length, at);
    return { ok: true, patched: [kind], boxes: [`SegmentInfo@${infoAt}`, `${kind}@${at}`] };
  } catch (err) {
    return { ok: false, retry: err.code === 'ENOENT', reason: `cannot patch header: ${err.message}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { parseInitBoxes, buildDurationPatches, patchFileHeaderDuration, patchMkvHeaderDuration, parseFfmpegInputDurations };
