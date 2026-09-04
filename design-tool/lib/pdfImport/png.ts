import { deflateSync } from "node:zlib";

// Minimal PNG encoder for extracted PDF figures (E5 slice 4). pdf.js hands
// back raw pixels (gray, gray+alpha, RGB or RGBA); this turns them into a
// PNG without a native dependency (ADR 0013 rules those out here). Stored
// uncompressed-filtered (filter 0 per row) + zlib; fine for figures.

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode interleaved 8-bit pixels. `channels`: 1 gray, 2 gray+alpha
 * (expanded to RGBA — PNG's gray+alpha is rarely worth the special case),
 * 3 RGB, 4 RGBA.
 */
export function encodePng(
  width: number,
  height: number,
  channels: 1 | 2 | 3 | 4,
  data: Uint8Array | Uint8ClampedArray,
): Buffer {
  if (width <= 0 || height <= 0) throw new Error("png: empty image");
  if (data.length < width * height * channels) throw new Error("png: pixel buffer too short");
  let ch: 1 | 3 | 4 = channels === 2 ? 4 : channels;
  let src: Uint8Array = data as Uint8Array;
  if (channels === 2) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i * 2]!;
      out[i * 4 + 3] = data[i * 2 + 1]!;
    }
    src = out;
    ch = 4;
  }
  const colorType = ch === 1 ? 0 : ch === 3 ? 2 : 6;
  const stride = width * ch;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(src.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Width and height from a PNG's IHDR, for tests and sanity checks. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(png);
  if (!b.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("png: bad signature");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
