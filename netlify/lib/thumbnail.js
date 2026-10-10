// Validates the browser-generated thumbnail and STRIPS any metadata server-side,
// without an image library: reads width/height from the WebP or JPEG header and
// removes EXIF / XMP / IPTC / comment blocks. Some browsers (Safari) write a small
// technical EXIF block even after canvas re-encoding, so we never trust the client.

export const MAX_THUMB_PX = 256;
export const MAX_THUMB_BYTES = 50 * 1024;

// ── WebP ──
function webpInfo(b) {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1, extended: true };
  return null;
}

// Drops EXIF and XMP chunks from an extended (VP8X) WebP and clears their flags.
function stripWebp(b) {
  if (b.toString('ascii', 12, 16) !== 'VP8X') return b;
  const parts = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4);
    const size = b.readUInt32LE(i + 4);
    const end = i + 8 + size + (size & 1);
    if (end > b.length) return null;
    if (id !== 'EXIF' && id !== 'XMP ') parts.push(Buffer.from(b.subarray(i, end)));
    i = end;
  }
  const vp8x = parts.find((p) => p.toString('ascii', 0, 4) === 'VP8X');
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

// ── JPEG ──
// Keeps only what is needed to display the image: APP0 (JFIF), APP2 ICC colour
// profile, tables, frame and scan data. Drops APP1 (EXIF/XMP), APP3–APP15 (incl.
// IPTC in APP13) and COM segments.
function stripJpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out = [b.subarray(0, 2)];
  let i = 2;
  let w = 0, h = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; }            // fill byte
    if (marker === 0xda) {                              // SOS: rest is image data
      out.push(b.subarray(i));
      return w && h ? { bytes: Buffer.concat(out), w, h } : null;
    }
    const len = b.readUInt16BE(i + 2);
    const end = i + 2 + len;
    if (end > b.length) return null;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7);
    }
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keepApp = marker === 0xe0 || (marker === 0xe2 && b.toString('ascii', i + 4, i + 15) === 'ICC_PROFILE');
    if ((isApp && !keepApp) || marker === 0xfe) { i = end; continue; }
    out.push(b.subarray(i, end));
    i = end;
  }
  return null;
}

// Returns { bytes, contentType, ext } or { error }.
export function validateThumbnail(thumb) {
  if (!thumb || typeof thumb.data !== 'string') return { error: 'missing' };
  const declared = thumb.type;
  if (declared !== 'image/webp' && declared !== 'image/jpeg') return { error: 'type' };
  let bytes;
  try { bytes = Buffer.from(thumb.data, 'base64'); } catch { return { error: 'decode' }; }
  if (!bytes.length || bytes.length > MAX_THUMB_BYTES) return { error: 'size' };

  let clean, dim;
  if (declared === 'image/webp') {
    dim = webpInfo(bytes);
    if (!dim) return { error: 'format' };
    clean = stripWebp(bytes);
  } else {
    const r = stripJpeg(bytes);
    if (!r) return { error: 'format' };
    clean = r.bytes; dim = r;
  }
  if (!clean) return { error: 'format' };
  if (!dim.w || !dim.h || Math.max(dim.w, dim.h) > MAX_THUMB_PX) return { error: 'dimensions' };

  return { bytes: clean, contentType: declared, ext: declared === 'image/webp' ? 'webp' : 'jpg' };
}
