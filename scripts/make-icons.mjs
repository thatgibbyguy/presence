#!/usr/bin/env node
// Emit Extension/icons/icon{16,32,48,128}.png: a single filled, anti-aliased
// circle. No dependencies; PNG is assembled by hand with zlib from node.
//
//   node scripts/make-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "Extension", "icons");
const SIZES = [16, 32, 48, 128];
const COLOR = [0x3a, 0x38, 0x35]; // charcoal; reads on light and dark toolbars

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Coverage of a pixel by a circle, sampled on a 4x4 grid for anti-aliasing. */
function coverage(x, y, cx, cy, r) {
  let hit = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4;
      const py = y + (sy + 0.5) / 4;
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) hit++;
    }
  }
  return hit / 16;
}

function png(size) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.36;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const a = Math.round(coverage(x, y, cx, cy, r) * 255);
      const o = row + 1 + x * 4;
      raw[o] = COLOR[0];
      raw[o + 1] = COLOR[1];
      raw[o + 2] = COLOR[2];
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const s of SIZES) {
  const file = join(outDir, `icon${s}.png`);
  writeFileSync(file, png(s));
  console.log("wrote", file);
}
