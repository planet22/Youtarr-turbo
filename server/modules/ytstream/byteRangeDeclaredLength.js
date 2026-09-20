/**
 * server/modules/ytstream/byteRangeDeclaredLength.js
 *
 * Lets a still-growing deliverAsFile encode report its FINAL size from the
 * very first response, so a player's scrub bar shows the real length
 * immediately (a player takes a file's length from the total in the first
 * Range response, and never re-asks once the file outgrows it). With a
 * plain remux (no re-encode) the finished file is the two downloaded
 * streams repackaged, so its size is known almost exactly up front:
 *
 *   declared total = (video bytes + audio bytes) * (1 + margin) + slack
 *
 * yt-dlp reports both stream sizes in its progress lines. When the encode
 * ends, the small over-estimate is filled with an MP4 `free` box (a
 * skippable padding atom every parser ignores), so the finished file is
 * exactly the size that was declared. Reads past the bytes written so far
 * simply wait for the encode to catch up (byteRangeServe.js).
 *
 * Only ever used for transcode=copy: a re-encode's output size isn't
 * predictable.
 */
const fs = require('fs');

const UNIT_BYTES = { B: 1, KiB: 1024, MiB: 1024 * 1024, GiB: 1024 * 1024 * 1024 };
// Progress lines look like `[download]  12.3% of  479.48MiB at ...`. A `~`
// marks an estimate (fragmented formats), which is not reliable enough.
const SIZE_PATTERN = /\bof\s+(~?)\s*([\d.]+)\s*(GiB|MiB|KiB|B)\b/g;
// Measured on 14 real sessions: finished size == video + audio within
// +/-0.02%. The margin only has to beat that and yt-dlp's 0.01 MiB rounding.
const DECLARED_MARGIN_RATIO = 0.002;
// Measured on 3 real mkv sessions: the finished file came out ~0.003% SMALLER
// than video + audio, so this only has to beat rounding, like the mp4 margin;
// kept a little wider since far fewer sessions back it.
const MKV_DECLARED_MARGIN_RATIO = 0.005;
// EBML Void element: ID 0xEC, then a size vint. An 8-byte vint (0x01 + 7
// bytes) is always used, so the header is a fixed 9 bytes.
const MKV_VOID_ID = 0xec;
const MKV_VOID_HEADER_BYTES = 9;
const DECLARED_SLACK_BYTES = 1024 * 1024;
// A box header is 8 bytes (16 with a 64-bit size); smaller gaps can't be a box.
const MIN_BOX_BYTES = 8;
const LARGE_BOX_THRESHOLD = 0xffffffff;
const ZERO_CHUNK_BYTES = 1024 * 1024;
// The finished file always ends with at least DECLARED_SLACK_BYTES of `free`
// box body (all zeros), whatever the real size turns out to be, so the last
// bytes are known before the encode is done. A player's end-of-file probes
// (mfra lookup, tail timestamp reads) land here and can be answered at once
// instead of waiting for the download to reach the end.
const ZERO_TAIL_BYTES = 512 * 1024;

/** @returns {boolean} whether a range starting at `start` lies entirely in the known all-zero tail */
function isInZeroTail(start, declaredTotal) {
  return start >= declaredTotal - ZERO_TAIL_BYTES;
}

/**
 * @param {string} text - a chunk of yt-dlp stderr
 * @returns {number|null} the exact (non-estimated) download size in bytes
 *   from the first progress line that has one, else null
 */
function parseDownloadSizeBytes(text) {
  for (const match of String(text || '').matchAll(SIZE_PATTERN)) {
    if (match[1] === '~') continue;
    const value = Number(match[2]);
    if (Number.isFinite(value) && value > 0) return Math.round(value * UNIT_BYTES[match[3]]);
  }
  return null;
}

/** @returns {number} the size to advertise for a remuxed video+audio pair */
function computeDeclaredTotal(videoBytes, audioBytes, container = 'mp4') {
  const ratio = container === 'mkv' ? MKV_DECLARED_MARGIN_RATIO : DECLARED_MARGIN_RATIO;
  return Math.ceil((videoBytes + audioBytes) * (1 + ratio)) + DECLARED_SLACK_BYTES;
}

/**
 * @param {number} sizeBytes - total element size including its header
 * @returns {Buffer} an EBML Void element header for exactly that size (zero
 *   bytes when too small to hold one)
 */
function buildVoidElementHeader(sizeBytes) {
  if (sizeBytes < MKV_VOID_HEADER_BYTES) return Buffer.alloc(sizeBytes);
  const header = Buffer.alloc(MKV_VOID_HEADER_BYTES);
  header[0] = MKV_VOID_ID;
  header[1] = 0x01;
  header.writeUIntBE(sizeBytes - MKV_VOID_HEADER_BYTES, 3, 6);
  return header;
}

/**
 * @param {number} sizeBytes - total box size including its header
 * @returns {Buffer} a `free` box of exactly that size (zero bytes when it is
 *   too small to hold a header)
 */
function buildFreeBoxHeader(sizeBytes) {
  if (sizeBytes < MIN_BOX_BYTES) return Buffer.alloc(sizeBytes);
  if (sizeBytes <= LARGE_BOX_THRESHOLD) {
    const header = Buffer.alloc(MIN_BOX_BYTES);
    header.writeUInt32BE(sizeBytes, 0);
    header.write('free', 4, 'latin1');
    return header;
  }
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write('free', 4, 'latin1');
  header.writeBigUInt64BE(BigInt(sizeBytes), 8);
  return header;
}

/**
 * Appends a `free` box (mp4) or an EBML Void element (mkv) so the file is
 * exactly `targetSize` bytes.
 * @returns {{ok: true, paddedBytes: number} | {ok: false, reason: string, actualBytes?: number}}
 *   not ok when the file is already bigger than the size that was declared
 *   (the estimate was too small) or on an I/O error
 */
function padFileToSize(filePath, targetSize, container = 'mp4') {
  let actual;
  try {
    actual = fs.statSync(filePath).size;
  } catch (err) {
    return { ok: false, reason: `cannot stat file: ${err.message}` };
  }
  const remaining = targetSize - actual;
  if (remaining < 0) return { ok: false, reason: 'file is larger than the declared size', actualBytes: actual };
  if (remaining === 0) return { ok: true, paddedBytes: 0 };
  let fd;
  try {
    fd = fs.openSync(filePath, 'a');
    const header = container === 'mkv' ? buildVoidElementHeader(remaining) : buildFreeBoxHeader(remaining);
    fs.writeSync(fd, header);
    let left = remaining - header.length;
    while (left > 0) {
      const chunk = Buffer.alloc(Math.min(left, ZERO_CHUNK_BYTES));
      fs.writeSync(fd, chunk);
      left -= chunk.length;
    }
    return { ok: true, paddedBytes: remaining };
  } catch (err) {
    return { ok: false, reason: `cannot pad file: ${err.message}` };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { ZERO_TAIL_BYTES, isInZeroTail, parseDownloadSizeBytes, computeDeclaredTotal, buildFreeBoxHeader, buildVoidElementHeader, padFileToSize };
