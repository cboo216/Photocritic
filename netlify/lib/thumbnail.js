// Validates the browser-generated thumbnail without any image library:
// reads width/height straight from the WebP or JPEG header.

export const MAX_THUMB_PX = 256;
export const MAX_THUMB_BYTES = 50 * 1024;

function webpSize(b) {
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
  if (chunk === 'VP8X') {
    return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1, extended: true, flags: b[20] };
  }
  return null;
}

function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let hasExif = false;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    if (marker === 0xe1) hasExif = true;
    // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), hasExif };
    }
    i += 2 + len;
  }
  return null;
}

// Returns { bytes, contentType, ext } or null (with reason) if invalid.
export function validateThumbnail(thumb) {
  if (!thumb || typeof thumb.data !== 'string') return { error: 'missing' };
  const declared = thumb.type;
  if (declared !== 'image/webp' && declared !== 'image/jpeg') return { error: 'type' };
  let bytes;
  try { bytes = Buffer.from(thumb.data, 'base64'); } catch { return { error: 'decode' }; }
  if (!bytes.length || bytes.length > MAX_THUMB_BYTES) return { error: 'size' };

  const isWebp = declared === 'image/webp';
  const dim = isWebp ? webpSize(bytes) : jpegSize(bytes);
  if (!dim) return { error: 'format' };
  if (Math.max(dim.w, dim.h) > MAX_THUMB_PX || !dim.w || !dim.h) return { error: 'dimensions' };
  // Canvas re-encoding never writes EXIF; refuse anything that carries it
  if (dim.hasExif || (dim.extended && (dim.flags & 0x08))) return { error: 'metadata' };

  return { bytes, contentType: declared, ext: isWebp ? 'webp' : 'jpg' };
}
