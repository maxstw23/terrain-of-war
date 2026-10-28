// Minimal PNG decoder for terrain tiles (8-bit greyscale, RGB, RGBA or palette;
// non-interlaced). Returns RGBA bytes, like the browser's getImageData().

import { inflateSync } from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('Not a PNG');
  let off = 8, width, height, depth, type, interlace, palette, trns;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
  }
  if (depth !== 8 || interlace) throw new Error(`Unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`Unsupported PNG colour type ${type}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    let r, g, b, a = 255;
    if (type === 2 || type === 6) { r = px[j]; g = px[j + 1]; b = px[j + 2]; if (type === 6) a = px[j + 3]; }
    else if (type === 3) { const k = px[j] * 3; r = palette[k]; g = palette[k + 1]; b = palette[k + 2]; if (trns && px[j] < trns.length) a = trns[px[j]]; }
    else { r = g = b = px[j]; if (type === 4) a = px[j + 1]; }
    out.set([r, g, b, a], i * 4);
  }
  return { width, height, rgba: out };
}
