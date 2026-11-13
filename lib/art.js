// Art for the Nuvio collection: one tile per catalog, drawn from the posters at the top of the list.
// cover() is the still tile and focus() the GIF Nuvio plays while the tile has focus. Both share one layout, so the
// GIF's first frame sits exactly on top of the still. backdrop() and logo() fill Nuvio's big preview of the tile.

import canvasLib from "@napi-rs/canvas";
import gifenc from "gifenc";
import { FONT_BOLD_BASE64, FONT_MEDIUM_BASE64 } from "./fonts.js";

const { createCanvas, loadImage, GlobalFonts } = canvasLib;
const { GIFEncoder, quantize, applyPalette } = gifenc;

export const VERSION = 1; // part of every image's ETag: raise it when the design changes, so apps fetch the new look

GlobalFonts.register(Buffer.from(FONT_BOLD_BASE64, "base64"), "TFI Bold");
GlobalFonts.register(Buffer.from(FONT_MEDIUM_BASE64, "base64"), "TFI Medium");

const W = 960, H = 540; // layout units (16:9, Nuvio's landscape tile); the cover is drawn 1:1, the loop at half size
const COVER_SCALE = 1, LOOP_SCALE = 0.5;
const LOOP_POSTERS = 5; // posters the loop cycles through
const HOLD_MS = 1500, STEP_MS = 70, STEP_FRAMES = 6; // each poster rests, then the fan turns in 6 short steps
const BG = "#07060d";

// Where a poster can sit in the fan: centre x/y, height, tilt in degrees, how much it's darkened, opacity.
const SLOTS = {
  center: { x: 676, y: 272, h: 404, rot: 0, dim: 0, alpha: 1 },
  left: { x: 512, y: 288, h: 336, rot: -8, dim: 0.42, alpha: 1 },
  right: { x: 840, y: 288, h: 336, rot: 8, dim: 0.42, alpha: 1 },
  back: { x: 676, y: 292, h: 300, rot: 0, dim: 0.75, alpha: 0 }, // hidden behind the centre poster
};
const TURN = [["right", "back"], ["center", "right"], ["left", "center"], ["back", "left"]]; // one step of the loop

const ease = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] + (b[k] - a[k]) * t]));
const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;

// null for an image that isn't there (the next poster takes its place). A timeout or server error throws instead:
// the request fails and is tried again later, rather than a half-empty tile being kept under the list's ETag.
async function fetchImage(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (r.status >= 500 || r.status === 429) throw new Error(`Image ${r.status} on ${url}`);
  if (!r.ok) return null;
  return loadImage(Buffer.from(await r.arrayBuffer())).catch(() => null);
}
// The first n posters that exist, in list order. Fewer than 4 are repeated to fill the fan and its hidden slot.
async function loadPosters(urls, n) {
  const got = (await Promise.all(urls.slice(0, n + 3).map(fetchImage))).filter(Boolean).slice(0, n);
  const out = [...got];
  while (got.length && out.length < 4) out.push(got[out.length % got.length]);
  return out;
}

// Draws img over the box, cropped to fill it.
function fill(ctx, img, x, y, w, h) {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k, sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

// s is the canvas scale: blur and shadow sizes don't follow ctx.scale(), so they're multiplied by hand.
function drawBackground(ctx, s, spec, top) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  if (top) { // the newest poster, blurred, tints the whole tile
    ctx.save();
    ctx.filter = `blur(${56 * s}px) saturate(1.5)`;
    ctx.globalAlpha = 0.62;
    fill(ctx, top, -80, -80, W + 160, H + 160);
    ctx.restore();
  }
  let g = ctx.createRadialGradient(SLOTS.center.x, 300, 40, SLOTS.center.x, 300, 430);
  g.addColorStop(0, rgba(spec.accent, 0.34));
  g.addColorStop(1, rgba(spec.accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createLinearGradient(0, 0, W, 0); // dark on the left, where the words go
  g.addColorStop(0, "rgba(7,6,13,.94)");
  g.addColorStop(0.42, "rgba(7,6,13,.66)");
  g.addColorStop(1, "rgba(7,6,13,.30)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createLinearGradient(0, H * 0.55, 0, H);
  g.addColorStop(0, "rgba(7,6,13,0)");
  g.addColorStop(1, "rgba(7,6,13,.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawText(ctx, spec) {
  const x = 60, maxWidth = 340;
  ctx.textBaseline = "alphabetic";
  // tag
  ctx.font = '21px "TFI Bold"';
  ctx.letterSpacing = "2.5px";
  const tagWidth = ctx.measureText(spec.tag).width + 30;
  ctx.beginPath();
  ctx.roundRect(x, 150, tagWidth, 40, 20);
  ctx.fillStyle = rgba(spec.accent, 0.2);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = rgba(spec.accent, 0.6);
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.fillText(spec.tag, x + 15, 177.5);
  ctx.letterSpacing = "0px";
  // two-line title, shrunk to fit the column
  let size = 92;
  const titleFont = () => `${size}px "TFI Bold"`;
  ctx.font = titleFont();
  while (size > 56 && Math.max(ctx.measureText(spec.title).width, ctx.measureText(spec.kind).width) > maxWidth) { size -= 2; ctx.font = titleFont(); }
  ctx.shadowColor = "rgba(0,0,0,.5)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#fff";
  ctx.fillText(spec.title, x - size * 0.04, 204 + size * 0.86);
  ctx.fillStyle = rgba(spec.accent, 1);
  ctx.fillText(spec.kind, x - size * 0.04, 204 + size * 1.78);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  // count
  if (spec.count) {
    ctx.font = '30px "TFI Medium"';
    ctx.fillStyle = "rgba(255,255,255,.72)";
    ctx.fillText(`${spec.count} ${spec.count === 1 ? "title" : "titles"}`, x, 204 + size * 1.78 + 54);
  }
}

function drawCard(ctx, s, img, p) {
  if (p.alpha < 0.02) return;
  const h = p.h, w = (h * 2) / 3, r = h * 0.05;
  const box = () => { ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, r); };
  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.translate(p.x, p.y);
  ctx.rotate((p.rot * Math.PI) / 180);
  ctx.shadowColor = "rgba(0,0,0,.6)";
  ctx.shadowBlur = 40 * s;
  ctx.shadowOffsetY = 16 * s;
  ctx.fillStyle = "#15121f";
  box();
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.save();
  box();
  ctx.clip();
  fill(ctx, img, -w / 2, -h / 2, w, h);
  if (p.dim > 0) { ctx.fillStyle = `rgba(7,6,13,${p.dim})`; ctx.fillRect(-w / 2, -h / 2, w, h); }
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,.16)";
  box();
  ctx.stroke();
  ctx.restore();
}

// cards: [{ img, ...slot }]. The bigger a poster, the nearer the front.
function drawFan(ctx, s, cards) {
  for (const c of [...cards].sort((a, b) => a.h - b.h)) drawCard(ctx, s, c.img, c);
}

function stage(scale) {
  const canvas = createCanvas(Math.round(W * scale), Math.round(H * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

// The fan at rest: newest in the middle, 2nd on the left, 3rd on the right. posters[] is in ring order (see ring()).
const atRest = (r, k) => [
  { img: r[k % r.length], ...SLOTS.right }, { img: r[(k + 1) % r.length], ...SLOTS.center }, { img: r[(k + 2) % r.length], ...SLOTS.left },
];
// Ring order: each turn of the loop moves every poster one place along this ring.
const ring = (p) => [p[2], p[0], p[1], ...p.slice(3)];

// Ordered (Bayer 4x4) dither, a few levels either way. bytes: RGBA of the pixels at positions[] in a frame this wide.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
function dither(bytes, positions, width) {
  for (let i = 0, n = 0; n < positions.length; i += 4, n++) {
    const p = positions[n];
    const d = (BAYER[((Math.floor(p / width) & 3) << 2) | (p % width & 3)] - 7.5) * 0.7;
    bytes[i] = Math.max(0, Math.min(255, bytes[i] + d));
    bytes[i + 1] = Math.max(0, Math.min(255, bytes[i + 1] + d));
    bytes[i + 2] = Math.max(0, Math.min(255, bytes[i + 2] + d));
  }
}

// spec: { title: "Telugu", kind: "Movies", tag: "MADE IN TELUGU", count: 100, accent: "#a855f7", posters: [url, ...], backdrop: url }
export async function cover(spec) {
  const posters = await loadPosters(spec.posters, 3);
  const { canvas, ctx } = stage(COVER_SCALE);
  drawBackground(ctx, COVER_SCALE, spec, posters[0]);
  if (posters.length) drawFan(ctx, COVER_SCALE, atRest(ring(posters), 0));
  drawText(ctx, spec);
  return canvas.encode("webp", 84);
}

// The newest title's backdrop, 1280x720. Without one, the tile's own background.
export async function backdrop(spec) {
  const img = spec.backdrop ? await fetchImage(spec.backdrop) : null;
  const scale = 1280 / W;
  const { canvas, ctx } = stage(scale);
  if (img) fill(ctx, img, 0, 0, W, H);
  else drawBackground(ctx, scale, spec, (await loadPosters(spec.posters, 1))[0]);
  return canvas.encode("webp", 82);
}

// The catalog's name on a clear background, the way a film's title logo is drawn.
export async function logo(spec) {
  const size = 150, pad = 24;
  const font = `${size}px "TFI Bold"`;
  const probe = createCanvas(8, 8).getContext("2d");
  probe.font = font;
  const width = Math.ceil(Math.max(probe.measureText(spec.title).width, probe.measureText(spec.kind).width)) + pad * 2;
  const canvas = createCanvas(width, Math.round(size * 2.1) + pad * 2);
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,.55)";
  ctx.shadowBlur = 20;
  ctx.fillStyle = "#fff";
  ctx.fillText(spec.title, pad, pad + size * 0.92);
  ctx.fillStyle = spec.accent;
  ctx.fillText(spec.kind, pad, pad + size * 1.88);
  return canvas.encode("webp", 90);
}

export async function focus(spec) {
  const posters = await loadPosters(spec.posters, LOOP_POSTERS);
  const s = LOOP_SCALE;
  const base = stage(s);
  drawBackground(base.ctx, s, spec, posters[0]);
  drawText(base.ctx, spec);
  const { canvas, ctx } = stage(s);
  const w = canvas.width, h = canvas.height, r = posters.length ? ring(posters) : [], n = r.length;
  const gif = GIFEncoder();
  let prev = null;
  // Only the pixels that changed since the frame before are stored; the rest are transparent and show through.
  const frame = (cards, delay, colors) => {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base.canvas, 0, 0);
    ctx.restore();
    drawFan(ctx, s, cards);
    const px = new Uint32Array(ctx.getImageData(0, 0, w, h).data.buffer.slice(0));
    const changed = [];
    for (let i = 0; i < px.length; i++) if (!prev || px[i] !== prev[i]) changed.push(i);
    const part = new Uint32Array(Math.max(changed.length, 1));
    for (let i = 0; i < changed.length; i++) part[i] = px[changed[i]];
    const every = Math.ceil(part.length / 30000); // the palette is picked from a sample: much faster, looks the same
    const palette = quantize(new Uint8Array((every > 1 ? part.filter((_, i) => i % every === 0) : part).buffer), colors);
    const bytes = new Uint8Array(part.buffer);
    dither(bytes, changed, w); // grain hides the bands so few colours leave in the dark background and the shadows
    const mapped = applyPalette(bytes, palette);
    while (palette.length < 256) palette.push([0, 0, 0]);
    const index = new Uint8Array(px.length).fill(255); // 255 = unchanged
    for (let i = 0; i < changed.length; i++) index[changed[i]] = mapped[i];
    gif.writeFrame(index, w, h, { palette, delay, transparent: !!prev, transparentIndex: 255, dispose: 1 });
    prev = px;
  };
  if (!n) frame([], HOLD_MS, 255);
  for (let k = 0; k < n; k++) {
    frame(atRest(r, k), HOLD_MS, 255);
    for (let f = 1; f < STEP_FRAMES; f++) { // the frames in between flash by, so they get by with fewer colours
      const t = ease(f / STEP_FRAMES);
      frame(TURN.map(([from, to], i) => ({ img: r[(k + i) % n], ...mix(SLOTS[from], SLOTS[to], t) })), STEP_MS, 96);
    }
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}
