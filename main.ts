// The picture that tastes of one ingredient — one juicy orange slice.
// Pure procedural rasterization: no assets, no network, no dependencies.
// Run with: node main.ts  ->  writes /output/entry.png (1024x1024 PNG)

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Integer hash -> [0, 1)
function hash2(ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >> 16)) >>> 0;
  return h / 4294967296;
}

// Smooth value noise in [-1, 1]
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const v = lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  return v * 2 - 1;
}

function fbm(x: number, y: number): number {
  return (
    vnoise(x, y) * 0.55 +
    vnoise(x * 2.13 + 7.7, y * 2.13 + 3.1) * 0.3 +
    vnoise(x * 4.31 + 13.7, y * 4.31 + 9.4) * 0.15
  );
}

type RGB = [number, number, number];

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [
    lerp(c1[0], c2[0], t),
    lerp(c1[1], c2[1], t),
    lerp(c1[2], c2[2], t),
  ];
}

// ---------------------------------------------------------------------------
// Scene: a single orange slice, macro shot, on a warm cream backdrop
// ---------------------------------------------------------------------------

const CX = 512; // slice centre
const CY = 498;
const R_OUT = 388; // outer rind edge
const R_RIND = 360; // rind / pith boundary
const R_PITH = 340; // pith / flesh boundary
const SEGMENTS = 10;

const BG_TOP: RGB = [253, 243, 226];
const BG_BOT: RGB = [246, 220, 178];
const GLOW: RGB = [255, 248, 225];
const SHADOW: RGB = [120, 70, 25];

const RIND_DARK: RGB = [198, 74, 8];
const RIND: RGB = [232, 104, 12];
const RIND_LIGHT: RGB = [255, 148, 38];
const PITH: RGB = [255, 240, 205];
const PITH_SHADE: RGB = [238, 205, 150];
const FLESH_IN: RGB = [255, 196, 58];
const FLESH_OUT: RGB = [255, 138, 26];
const FLESH_DEEP: RGB = [240, 110, 8];
const MEMBRANE: RGB = [255, 233, 178];
const CORE: RGB = [255, 246, 214];

function background(x: number, y: number): RGB {
  const t = y / (H - 1);
  let c = mix(BG_TOP, BG_BOT, t);
  // soft warm glow behind the slice
  const dx = x - CX;
  const dy = y - CY;
  const d = Math.sqrt(dx * dx + dy * dy) / 560;
  const g = Math.max(0, 1 - d * d);
  c = mix(c, GLOW, g * g * 0.45);
  return c;
}

// Soft elliptical shadow cast under the slice
function shadowAmount(x: number, y: number): number {
  const dx = (x - CX - 14) / 400;
  const dy = (y - (CY + 330)) / 92;
  const d2 = dx * dx + dy * dy;
  if (d2 >= 1) return 0;
  return (1 - d2) * (1 - d2) * 0.34;
}

// Distance (in px) from (x,y) to the nearest segment boundary ray
function membraneDist(x: number, y: number): number {
  const dx = x - CX;
  const dy = y - CY;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r < 1) return 0;
  const a = Math.atan2(dy, dx); // -PI..PI
  const step = (Math.PI * 2) / SEGMENTS;
  // fold angle into [0, step)
  let f = a / step;
  f = f - Math.floor(f);
  const distAng = Math.min(f, 1 - f) * step;
  return distAng * r;
}

function slicePixel(x: number, y: number): RGB | null {
  const dx = x - CX;
  const dy = y - CY;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (r > R_OUT) return null;

  const ang = Math.atan2(dy, dx);
  const wobble = fbm(Math.cos(ang) * 2.2 + 5, Math.sin(ang) * 2.2 + 5) * 3.0;
  const rr = r + wobble;

  // --- rind ---------------------------------------------------------------
  if (rr > R_RIND) {
    const t = (rr - R_RIND) / (R_OUT - R_RIND); // 0 inner -> 1 outer
    let c = mix(RIND_LIGHT, RIND, smoothstep(0, 0.45, t));
    c = mix(c, RIND_DARK, smoothstep(0.55, 1, t));
    // peel dimples: gentle pitted texture
    const dim = fbm(x * 0.045, y * 0.045);
    c = mix(c, RIND_DARK, Math.max(0, dim) * 0.16);
    c = mix(c, RIND_LIGHT, Math.max(0, -dim) * 0.14);
    // rim light, upper-left
    const lx = -dx / R_OUT;
    const ly = -dy / R_OUT;
    const rim = Math.max(0, lx * 0.7 + ly * 0.7);
    c = mix(c, [255, 190, 90], rim * rim * 0.28 * smoothstep(0.75, 1, t));
    return c;
  }

  // --- pith ---------------------------------------------------------------
  if (rr > R_PITH) {
    const t = (rr - R_PITH) / (R_RIND - R_PITH);
    let c = mix(PITH, PITH_SHADE, smoothstep(0.2, 1, t));
    const n = fbm(x * 0.06 + 31, y * 0.06 + 17);
    c = mix(c, PITH_SHADE, Math.max(0, n) * 0.18);
    return c;
  }

  // --- flesh --------------------------------------------------------------
  // radial colour: pale gold near the core, deep orange near the pith
  const rt = rr / R_PITH;
  let c = mix(FLESH_IN, FLESH_OUT, smoothstep(0.05, 0.85, rt));
  c = mix(c, FLESH_DEEP, smoothstep(0.88, 1, rt) * 0.55);

  // per-segment brightness so each wedge reads separately
  const seg = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * SEGMENTS);
  const segShade = (hash2(seg, 7) - 0.5) * 0.1;
  c = mix(c, [255, 255, 255], Math.max(0, segShade));
  c = mix(c, [200, 90, 0], Math.max(0, -segShade));

  // juice vesicles: fine cellular speckle, brighter and glossier
  const ves = fbm(x * 0.09 + 3.3, y * 0.09 + 8.8);
  const ves2 = vnoise(x * 0.021 + 11, y * 0.021 + 4);
  c = mix(c, [255, 214, 110], Math.max(0, ves) * 0.36);
  c = mix(c, [255, 240, 170], Math.max(0, ves2) * 0.22);

  // pale membranes between segments
  const md = membraneDist(x, y);
  const memW = 3.2 + rt * 5.5;
  const mem = 1 - smoothstep(memW * 0.55, memW, md);
  c = mix(c, MEMBRANE, mem * 0.92);

  // pale core star at the centre
  const core = 1 - smoothstep(16, 44, rr);
  c = mix(c, CORE, core * 0.65);

  // glistening highlights on the flesh, upper-left
  const h1 = Math.exp(
    -((x - 380) * (x - 380) + (y - 360) * (y - 360)) / (2 * 95 * 95),
  );
  const h2 = Math.exp(
    -((x - 640) * (x - 640) + (y - 660) * (y - 660)) / (2 * 70 * 70),
  );
  c = mix(c, [255, 252, 235], h1 * 0.2 + h2 * 0.12);

  return c;
}

// A few juice droplets resting on the backdrop, lower right
function droplet(x: number, y: number): RGB | null {
  const drops: Array<[number, number, number]> = [
    [742, 884, 16],
    [788, 902, 10],
    [706, 912, 8],
  ];
  for (const [dx0, dy0, rad] of drops) {
    const ddx = x - dx0;
    const ddy = y - dy0;
    const d = Math.sqrt(ddx * ddx + ddy * ddy);
    if (d < rad) {
      const t = d / rad;
      let c: RGB = [255, 176, 66];
      c = mix(c, [255, 214, 130], (1 - t) * 0.5);
      // tiny specular dot, upper-left of the droplet
      const sx = x - (dx0 - rad * 0.35);
      const sy = y - (dy0 - rad * 0.35);
      const sp = Math.exp(-(sx * sx + sy * sy) / (2 * 3.2 * 3.2));
      c = mix(c, [255, 255, 255], sp * 0.85);
      // darker rim at the droplet edge
      c = mix(c, [214, 110, 10], smoothstep(0.75, 1, t) * 0.5);
      return c;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

const pixels = Buffer.alloc(W * H * 3);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let c = background(x, y);
    const sh = shadowAmount(x, y);
    if (sh > 0) c = mix(c, SHADOW, sh);
    const drop = droplet(x, y);
    if (drop) c = drop;
    const s = slicePixel(x, y);
    if (s) c = s;
    // gentle vignette to pull the eye to the slice
    const vx = (x - CX) / 640;
    const vy = (y - CY) / 640;
    const vd = vx * vx + vy * vy;
    const vig = 1 - Math.max(0, vd - 0.55) * 0.16;
    const i = (y * W + x) * 3;
    pixels[i] = Math.round(clamp(c[0] * vig, 0, 255));
    pixels[i + 1] = Math.round(clamp(c[1] * vig, 0, 255));
    pixels[i + 2] = Math.round(clamp(c[2] * vig, 0, 255));
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (filter 0, zlib deflate)
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let table = (crc32 as unknown as { t?: Int32Array }).t;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as unknown as { t: Int32Array }).t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  const crcBuf = Buffer.concat([Buffer.from(type, "ascii"), data]);
  out.writeUInt32BE(crc32(crcBuf), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type RGB
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 3)] = 0; // filter: none
  pixels.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = "/output";
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "entry.png");
fs.writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H})`);
