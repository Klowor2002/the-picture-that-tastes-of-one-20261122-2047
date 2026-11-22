// The picture that tastes of one ingredient — one glossy ripe strawberry,
// macro studio shot, procedurally rasterized pixel by pixel.
// Zero dependencies, no network, no external assets.
// Writes /output/entry.png (1024x1024 PNG, <= 1 MiB).

import * as fs from "node:fs";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

// ---------- small helpers ----------
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
// deterministic 2D hash -> [0,1)
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
// value noise, smooth
function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// ---------- CRC32 (PNG chunks) ----------
const CRC_TABLE: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(w: number, h: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter none
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- strawberry geometry ----------
// Body: centre x 512, top y 250, bottom y 895. u = (x-512)/305, v = (y-250)/645.
const CX = 512;
const HW = 305;
const TOP = 250;
const BOT = 895;
function profile(v: number): number {
  // half-width in u units; rounded shoulders, tapering to a soft point
  if (v <= 0 || v >= 1) return 0;
  return Math.pow(1 - Math.pow(v, 2.6), 0.58);
}
function bodyUV(x: number, y: number): [number, number, boolean] {
  const u = (x - CX) / HW;
  const v = (y - TOP) / (BOT - TOP);
  if (v < 0.01 || v > 1) return [u, v, false];
  const p = profile(v);
  // top edge curves down toward the shoulders
  if (v < 0.14 * u * u + 0.01) return [u, v, false];
  return [u, v, Math.abs(u) <= p];
}

// Seeds (achenes): sparse grid in (u,v) space, alternating rows, jittered.
function seedAt(u: number, v: number): number {
  const rowH = 0.1;
  const colW = 0.14;
  const row = Math.round((v - 0.16) / rowH);
  if (row < 0 || row > 8) return 0;
  const sv = 0.16 + row * rowH;
  const off = row % 2 === 0 ? 0 : colW / 2;
  const jx = (hash2(row, 7) - 0.5) * 0.04;
  const jy = (hash2(row, 13) - 0.5) * 0.016;
  const col = Math.round((u - off) / colW);
  const su = off + col * colW + jx;
  const sizeJ = 0.85 + hash2(col, row) * 0.3;
  const du = (u - su) / (0.016 * sizeJ);
  const dv = (v - (sv + jy)) / (0.014 * sizeJ);
  const r2 = du * du + dv * dv;
  if (r2 > 1.5) return 0;
  return r2;
}

// Dew droplets: fixed positions (u,v), radius in px
const DROPS: Array<[number, number, number]> = [
  [-0.42, 0.3, 9], [-0.15, 0.42, 7], [0.3, 0.35, 8],
  [0.52, 0.55, 6], [-0.28, 0.8, 6], [0.42, 0.78, 7],
];

// Calyx leaves: short and broad, hugging the berry.
// [angle from straight up (rad), length, half-width]
const LEAVES: Array<[number, number, number]> = [
  [-0.95, 150, 48], [-0.55, 165, 52], [-0.15, 140, 48],
  [0.25, 158, 50], [0.65, 165, 52], [1.05, 145, 46],
  [-1.35, 118, 40], [1.45, 115, 40],
];
const CALYX_X = 512;
const CALYX_Y = 238;

function leafAt(x: number, y: number): [boolean, number, number] {
  // returns [inside, alongFrac, perpFrac]
  const dx = x - CALYX_X;
  const dy = y - CALYX_Y;
  for (let i = 0; i < LEAVES.length; i++) {
    const [ang, len, w] = LEAVES[i];
    const sx = Math.sin(ang);
    const sy = -Math.cos(ang);
    const along = dx * sx + dy * sy;
    if (along < -8 || along > len) continue;
    const perp = dx * Math.cos(ang) + dy * Math.sin(ang);
    const half = w * (1 - Math.max(0, along) / len) * (0.55 + 0.45 * Math.sin(Math.PI * clamp(along / len, 0, 1) * 0.5 + 0.35));
    if (Math.abs(perp) <= Math.max(2, half)) {
      return [true, clamp(along / len, 0, 1), perp / Math.max(2, half)];
    }
  }
  return [false, 0, 0];
}

// ---------- render ----------
const img = Buffer.alloc(W * H * 3);

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 3;
    let r: number, g: number, b: number;

    // ---- background: warm cream radial + soft glow behind the berry ----
    const bgdx = (x - 512) / 720;
    const bgdy = (y - 430) / 720;
    const bgd = Math.sqrt(bgdx * bgdx + bgdy * bgdy);
    const glow = Math.exp(-bgd * bgd * 2.2);
    r = lerp(243, 255, glow);
    g = lerp(214, 246, glow);
    b = lerp(168, 232, glow);
    // gentle vignette
    const vig = 1 - 0.10 * smoothstep(0.55, 1.05, bgd);
    r *= vig; g *= vig; b *= vig;

    // ---- soft ground shadow (ellipse under the berry) ----
    const shx = (x - 512) / 300;
    const shy = (y - 918) / 40;
    const shd = shx * shx + shy * shy;
    if (shd < 1.6) {
      const s = 0.42 * Math.exp(-shd * 2.0) * smoothstep(1.6, 0.4, shd);
      r = lerp(r, 122, s);
      g = lerp(g, 88, s);
      b = lerp(b, 52, s);
    }

    const [u, v, inside] = bodyUV(x, y);

    if (inside) {
      const p = profile(v);
      const edge = Math.abs(u) / p; // 0 centre -> 1 edge
      const n = noise2(x * 0.045, y * 0.045) * 0.6 + noise2(x * 0.15, y * 0.15) * 0.4;

      // base red: bright juicy top-left -> deep red at edges and bottom
      const hlx = -0.38, hly = 0.26;
      const hd = Math.sqrt(((u - hlx) / 0.85) ** 2 + ((v - hly) / 0.62) ** 2);
      const bright = clamp(1.12 - 0.62 * hd, 0.55, 1.12);
      const depth = 1 - 0.28 * v - 0.22 * edge * edge;
      let br = 248 * bright * depth;
      let bg2 = 58 * bright * depth + 26 * (1 - depth);
      let bb = 52 * bright * depth + 22 * (1 - depth);
      // subtle flesh variation
      br += (n - 0.5) * 22;
      bg2 += (n - 0.5) * 10;
      bb += (n - 0.5) * 8;

      // warm rim light on the right edge
      if (u > 0.1 && edge > 0.86) {
        const rim = smoothstep(0.86, 1.0, edge) * 0.55;
        br = lerp(br, 255, rim);
        bg2 = lerp(bg2, 150, rim);
        bb = lerp(bb, 128, rim);
      }
      // darker crease at the very tip
      if (v > 0.93) {
        const tip = smoothstep(0.93, 1.0, v) * 0.35;
        br *= 1 - tip; bg2 *= 1 - tip; bb *= 1 - tip;
      }

      r = br; g = bg2; b = bb;

      // ---- seeds ----
      const sr = seedAt(u, v);
      if (sr > 0 && edge < 0.96) {
        if (sr <= 1) {
          // pale golden seed, shaded toward its lower right
          const shade = 0.84 + 0.16 * clamp(0.5 - (sr - 0.5), 0, 1);
          r = lerp(r, 250 * shade, 0.92);
          g = lerp(g, 224 * shade, 0.92);
          b = lerp(b, 138 * shade, 0.92);
        } else {
          // pit ring: darken the red around the seed
          r *= 0.82; g *= 0.82; b *= 0.82;
        }
      }

      // ---- big soft gloss highlight, upper left ----
      const gx = (x - 380) / 200;
      const gy = (y - 330) / 160;
      const gd = gx * gx + gy * gy;
      if (gd < 1) {
        const gl = 0.5 * Math.exp(-gd * 2.4);
        r = lerp(r, 255, gl);
        g = lerp(g, 205, gl);
        b = lerp(b, 185, gl);
      }
      // faint second sheen, mid right — kept very subtle so no edge shows
      const gx2 = (x - 660) / 170;
      const gy2 = (y - 560) / 140;
      const gd2 = gx2 * gx2 + gy2 * gy2;
      if (gd2 < 1) {
        const gl2 = 0.14 * Math.exp(-gd2 * 1.6);
        r = lerp(r, 255, gl2);
        g = lerp(g, 200, gl2);
        b = lerp(b, 180, gl2);
      }

      // ---- dew droplets ----
      for (let i = 0; i < DROPS.length; i++) {
        const [du0, dv0, dr] = DROPS[i];
        const px = CX + du0 * HW * profile(dv0);
        const py = TOP + dv0 * (BOT - TOP);
        const ddx = (x - px) / dr;
        const ddy = (y - py) / (dr * 0.82);
        const dd = ddx * ddx + ddy * ddy;
        if (dd < 1) {
          const drop = 0.55 * Math.exp(-dd * 1.8);
          r = lerp(r, 255, drop);
          g = lerp(g, 240, drop);
          b = lerp(b, 225, drop);
          // bright specular dot
          const sx2 = (x - (px - dr * 0.3)) / (dr * 0.35);
          const sy2 = (y - (py - dr * 0.35)) / (dr * 0.35);
          if (sx2 * sx2 + sy2 * sy2 < 1) {
            r = 255; g = 250; b = 245;
          }
        }
      }
    }

    // ---- calyx: green collar + leaves + stem (drawn over the body top) ----
    const colx = (x - CALYX_X) / 95;
    const coly = (y - (CALYX_Y + 4)) / 34;
    if (colx * colx + coly * coly < 1 && y > CALYX_Y - 26) {
      r = lerp(r, 52, 0.96);
      g = lerp(g, 126, 0.96);
      b = lerp(b, 58, 0.96);
    }
    const [inLeaf, alongF, perpF] = leafAt(x, y);
    if (inLeaf) {
      const lg = 1 - 0.45 * alongF;
      let lr = 52 * lg + 14;
      let lg2 = 138 * lg + 16;
      let lb = 58 * lg + 12;
      // centre vein lighter
      if (Math.abs(perpF) < 0.16) {
        lr = lerp(lr, 150, 0.55);
        lg2 = lerp(lg2, 205, 0.55);
        lb = lerp(lb, 120, 0.55);
      }
      r = lr; g = lg2; b = lb;
    }
    // stem: gently curving, rising from the calyx
    if (y >= 118 && y <= CALYX_Y + 10) {
      const t = (y - 118) / (CALYX_Y + 10 - 118);
      const stemX = CALYX_X + 16 * Math.sin(t * 1.1) - 8 * t;
      const half = 11 - 4 * t;
      if (Math.abs(x - stemX) < half) {
        const sh = x < stemX ? 1.1 : 0.85;
        r = 96 * sh; g = 116 * sh; b = 58 * sh;
      }
    }

    img[idx] = clamp(Math.round(r), 0, 255);
    img[idx + 1] = clamp(Math.round(g), 0, 255);
    img[idx + 2] = clamp(Math.round(b), 0, 255);
  }
}

fs.mkdirSync("/output", { recursive: true });
const png = encodePNG(W, H, img);
fs.writeFileSync("/output/entry.png", png);
console.log(`wrote /output/entry.png ${png.length} bytes ${W}x${H}`);
