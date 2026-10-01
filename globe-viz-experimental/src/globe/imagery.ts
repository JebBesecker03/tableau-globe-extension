import type { Texture } from '../types';

/**
 * Satellite imagery for the Canvas globe (Tableau Desktop has no WebGL). Screen pixels are
 * mapped back onto the texture (the inverse of the bars' rotation, then lat/lng → texel)
 * at up to BUDGET_FULL pixels and scaled up smoothly.
 *
 * Spinning is the common motion (auto-rotate, sideways drags), and it only changes
 * longitude: for a fixed tilt and zoom, each screen pixel always shows the same latitude
 * and the same longitude offset. So the expensive part (atan2/asin per pixel) is computed
 * once into a "grid", and each spin frame just slides the texture sideways (one add and
 * one lookup per pixel), staying sharp. Tilting, zooming and fly-to change the grid, so
 * they briefly render directly at a lower budget and sharpen once the view settles.
 */

const FILES: Record<Exclude<Texture, 'midnight'>, string> = {
  day: 'earth-blue-marble.jpg',
  night: 'earth-night.jpg',
  dark: 'earth-dark.jpg',
};
const textureUrl = (file: string) => `${import.meta.env.BASE_URL}textures/${file}`;

/** Texture resolution used for sampling: plenty for a globe, and 8 MB in memory. */
const TEX_W = 2048;
const TEX_H = 1024;
/** Output pixels: full detail (also used while spinning), and while tilting/zooming. */
const BUDGET_FULL = 420_000;
const BUDGET_MOVING = 120_000;

export interface EarthTexture {
  /** RGBA texels as 32-bit words, row-major, TEX_W × TEX_H. */
  pixels: Uint32Array;
  /** URL for the WebGL globe: the original file, or the generated Midnight image. */
  url: string;
}

const loaded = new Map<Texture, Promise<EarthTexture>>();

/** Loads (once) a texture's pixels; Midnight is generated from Blue Marble + city lights. */
export function loadTexture(texture: Texture): Promise<EarthTexture> {
  let p = loaded.get(texture);
  if (!p) {
    p = texture === 'midnight' ? buildMidnight() : loadPixels(FILES[texture]).then(({ pixels }) => ({ pixels, url: textureUrl(FILES[texture]) }));
    loaded.set(texture, p);
    p.catch(() => loaded.delete(texture)); // allow a retry
  }
  return p;
}

async function loadPixels(file: string): Promise<{ pixels: Uint32Array; canvas: HTMLCanvasElement }> {
  const img = new Image();
  img.src = textureUrl(file);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, TEX_W, TEX_H);
  const data = ctx.getImageData(0, 0, TEX_W, TEX_H).data;
  return { pixels: new Uint32Array(data.buffer), canvas };
}

/**
 * "Midnight": Blue Marble re-toned by brightness, so the dark ocean becomes deep navy and
 * brighter land becomes blue-grey with its relief intact, plus a hint of the original hue
 * and the city-lights texture added in warm tones, like Earth seen at night.
 */
async function buildMidnight(): Promise<EarthTexture> {
  const [day, night] = await Promise.all([loadPixels(FILES.day), loadPixels(FILES.night)]);
  const out = new Uint32Array(TEX_W * TEX_H);
  const d = day.pixels;
  const n = night.pixels;
  const DEEP = [4, 12, 34]; // ocean
  const LIGHT = [128, 162, 205]; // brightest land / ice
  for (let i = 0; i < out.length; i++) {
    const dp = d[i];
    const np = n[i];
    // Little-endian RGBA: R in the low byte.
    const dr = dp & 255;
    const dg = (dp >> 8) & 255;
    const db = (dp >> 16) & 255;
    const lum = 0.3 * dr + 0.59 * dg + 0.11 * db;
    const t = Math.min(1, Math.max(0, (lum - 18) / 190)) ** 0.8;
    const lights = ((np & 255) + ((np >> 8) & 255) + ((np >> 16) & 255)) / 3;
    const glow = lights > 45 ? (lights - 45) * 1.2 : 0;
    const r = Math.min(255, DEEP[0] + (LIGHT[0] - DEEP[0]) * t + (dr - lum) * 0.12 + glow);
    const g = Math.min(255, DEEP[1] + (LIGHT[1] - DEEP[1]) * t + (dg - lum) * 0.12 + glow * 0.8);
    const b = Math.min(255, DEEP[2] + (LIGHT[2] - DEEP[2]) * t + (db - lum) * 0.12 + glow * 0.45);
    out[i] = (255 << 24) | (Math.max(0, b) << 16) | (Math.max(0, g) << 8) | Math.max(0, r);
  }
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), TEX_W, TEX_H), 0, 0);
  return { pixels: out, url: canvas.toDataURL('image/jpeg', 0.92) };
}

/** Renders the imagery for one view, reusing the last result when nothing changed. */
export class ImageryRenderer {
  private readonly buffer = document.createElement('canvas');
  private readonly bufferCtx = this.buffer.getContext('2d')!;
  private texture: EarthTexture | null = null;
  private textureName: Texture | null = null;
  private lastKey = '';
  /** Per-pixel latitude row and base longitude for one tilt/zoom/size (see class doc). */
  private grid: { key: string; vRow: Int32Array; uBase: Float32Array } | null = null;
  private image: ImageData | null = null;
  private lastTilt = '';
  /** True when the last render used the low "moving" budget and should be refined. */
  lowRes = false;

  /** Starts loading `texture`; `onReady` fires when it can be drawn (to trigger a redraw). */
  use(texture: Texture, onReady: () => void): void {
    if (texture === this.textureName) return;
    this.textureName = texture;
    loadTexture(texture)
      .then((t) => {
        if (this.textureName !== texture) return;
        this.texture = t;
        this.lastKey = '';
        onReady();
      })
      .catch((err) => console.warn('[globe] texture failed to load', err));
  }

  get ready(): boolean {
    return this.texture !== null;
  }

  /**
   * Draws the globe disk (center cx,cy, radius r, rotation lambda/phi as d3 uses them)
   * into ctx. Returns false if the texture isn't loaded yet.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    lambda: number,
    phi: number,
    width: number,
    height: number,
    moving: boolean,
  ): boolean {
    const tex = this.texture;
    if (!tex) return false;
    // Only the part of the disk that's on screen.
    const x0 = Math.max(0, Math.floor(cx - r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const x1 = Math.min(width, Math.ceil(cx + r));
    const y1 = Math.min(height, Math.ceil(cy + r));
    if (x1 <= x0 || y1 <= y0) return true;
    const areaW = x1 - x0;
    const areaH = y1 - y0;
    const fullScale = Math.min(1, Math.sqrt(BUDGET_FULL / (areaW * areaH)));
    const fw = Math.max(1, Math.round(areaW * fullScale));
    const fh = Math.max(1, Math.round(areaH * fullScale));

    // Tilt, zoom and size define the grid; only longitude (lambda) may change cheaply.
    const tilt = `${cx},${cy},${r},${phi},${x0},${y0},${fw},${fh}`;
    const spinning = tilt === this.lastTilt;
    this.lastTilt = tilt;
    let bw: number;
    let bh: number;
    if (!moving || spinning || this.grid?.key === tilt) {
      bw = fw;
      bh = fh;
      if (this.grid?.key !== tilt) this.buildGrid(tilt, fw, fh, x0, y0, areaW / fw, areaH / fh, cx, cy, r, phi);
      const key = `grid|${tilt}|${lambda}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.renderFromGrid(tex.pixels, fw, fh, lambda);
      }
      this.lowRes = false;
    } else {
      // Tilting / zooming / flying: render directly at a lower budget for this frame.
      const scale = Math.min(fullScale, Math.sqrt(BUDGET_MOVING / (areaW * areaH)));
      bw = Math.max(1, Math.round(areaW * scale));
      bh = Math.max(1, Math.round(areaH * scale));
      const key = `direct|${cx},${cy},${r},${lambda},${phi},${bw},${bh}`;
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.render(tex.pixels, bw, bh, x0, y0, areaW / bw, areaH / bh, cx, cy, r, lambda, phi);
      }
      this.lowRes = bw < fw;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.buffer, 0, 0, bw, bh, x0, y0, areaW, areaH);
    ctx.restore();
    return true;
  }

  private render(
    tex: Uint32Array,
    bw: number,
    bh: number,
    x0: number,
    y0: number,
    stepX: number,
    stepY: number,
    cx: number,
    cy: number,
    r: number,
    lambda: number,
    phi: number,
  ): void {
    const image = this.target(bw, bh);
    const out = new Uint32Array(image.data.buffer);
    out.fill(0);
    const rad = Math.PI / 180;
    const cl = Math.cos(lambda * rad);
    const sl = Math.sin(lambda * rad);
    const cp = Math.cos(phi * rad);
    const sp = Math.sin(phi * rad);
    const invR = 1 / r;
    const uScale = TEX_W / (2 * Math.PI);
    const vScale = TEX_H / Math.PI;

    for (let j = 0; j < bh; j++) {
      const sy = (cy - (y0 + (j + 0.5) * stepY)) * invR; // screen "up", -1..1
      const sy2 = sy * sy;
      if (sy2 >= 1) continue;
      let o = j * bw;
      for (let i = 0; i < bw; i++, o++) {
        const sx = (x0 + (i + 0.5) * stepX - cx) * invR;
        const d2 = sx * sx + sy2;
        if (d2 >= 1) continue;
        const sz = Math.sqrt(1 - d2); // toward the viewer
        // Inverse of the bars' rotation (see canvas.ts drawBars): screen → globe unit vector.
        const a = sy * sp + sz * cp;
        const uz = sy * cp - sz * sp;
        const ux = a * cl + sx * sl;
        const uy = sx * cl - a * sl;
        const lng = Math.atan2(uy, ux); // -π..π
        const lat = Math.asin(uz < -1 ? -1 : uz > 1 ? 1 : uz);
        let u = ((lng + Math.PI) * uScale) | 0;
        let v = ((Math.PI / 2 - lat) * vScale) | 0;
        if (u >= TEX_W) u = TEX_W - 1;
        if (v >= TEX_H) v = TEX_H - 1;
        out[o] = tex[v * TEX_W + u];
      }
    }
    this.bufferCtx.putImageData(image, 0, 0);
  }

  /**
   * For each output pixel: the texture row (v·TEX_W) of its latitude, or -1 off the globe,
   * and its longitude in texels with lambda = 0. Rotating by lambda then just subtracts
   * lambda from every longitude (the d3 rotation applies lambda about the pole first).
   */
  private buildGrid(
    key: string,
    bw: number,
    bh: number,
    x0: number,
    y0: number,
    stepX: number,
    stepY: number,
    cx: number,
    cy: number,
    r: number,
    phi: number,
  ): void {
    const n = bw * bh;
    const vRow = new Int32Array(n).fill(-1);
    const uBase = new Float32Array(n);
    const rad = Math.PI / 180;
    const cp = Math.cos(phi * rad);
    const sp = Math.sin(phi * rad);
    const invR = 1 / r;
    const uScale = TEX_W / (2 * Math.PI);
    const vScale = TEX_H / Math.PI;
    for (let j = 0; j < bh; j++) {
      const sy = (cy - (y0 + (j + 0.5) * stepY)) * invR;
      const sy2 = sy * sy;
      if (sy2 >= 1) continue;
      let o = j * bw;
      for (let i = 0; i < bw; i++, o++) {
        const sx = (x0 + (i + 0.5) * stepX - cx) * invR;
        const d2 = sx * sx + sy2;
        if (d2 >= 1) continue;
        const sz = Math.sqrt(1 - d2);
        const a = sy * sp + sz * cp; // undo the tilt (phi)
        const uz = sy * cp - sz * sp;
        const lat = Math.asin(uz < -1 ? -1 : uz > 1 ? 1 : uz);
        let v = ((Math.PI / 2 - lat) * vScale) | 0;
        if (v >= TEX_H) v = TEX_H - 1;
        vRow[o] = v * TEX_W;
        uBase[o] = (Math.atan2(sx, a) + Math.PI) * uScale; // longitude with lambda = 0
      }
    }
    this.grid = { key, vRow, uBase };
  }

  /** Spins the grid by lambda: a texel shift per pixel, no trigonometry. */
  private renderFromGrid(tex: Uint32Array, bw: number, bh: number, lambda: number): void {
    const { vRow, uBase } = this.grid!;
    const image = this.target(bw, bh);
    const out = new Uint32Array(image.data.buffer);
    // longitude = base − lambda; normalize the shift into [0, TEX_W) once.
    let shift = (-lambda / 360) * TEX_W;
    shift -= Math.floor(shift / TEX_W) * TEX_W;
    for (let o = 0, n = bw * bh; o < n; o++) {
      const row = vRow[o];
      if (row < 0) {
        out[o] = 0;
        continue;
      }
      let u = uBase[o] + shift;
      if (u >= TEX_W) u -= TEX_W;
      out[o] = tex[row + (u | 0)];
    }
    this.bufferCtx.putImageData(image, 0, 0);
  }

  /** Reuses one ImageData (and buffer canvas size) while the output size is unchanged. */
  private target(bw: number, bh: number): ImageData {
    if (this.buffer.width !== bw || this.buffer.height !== bh) {
      this.buffer.width = bw;
      this.buffer.height = bh;
    }
    if (!this.image || this.image.width !== bw || this.image.height !== bh) {
      this.image = this.bufferCtx.createImageData(bw, bh);
    }
    return this.image;
  }
}
