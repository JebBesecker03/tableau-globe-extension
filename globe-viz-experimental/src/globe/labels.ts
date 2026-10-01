import type { GlobeRenderer } from './renderer';

/**
 * - focus: the areas you're choosing between (e.g. the Territories of the opened Region).
 * - context: everything else (dimmed areas around the drill-down, bars).
 * - active: what's under the mouse or selected; always drawn, in a pill.
 */
export type LabelStyle = 'focus' | 'context' | 'active';

export interface LabelCandidate {
  text: string;
  lat: number;
  lng: number;
  /** Angular radius of the labeled area; absent for bars (labeled at their base). */
  radiusDeg?: number;
  /** Higher is placed first when labels would overlap. */
  priority: number;
  style: LabelStyle;
}

const MAX_LABELS = 150;
const LAYOUT_FPS = 20;
const PAD = 3;
const FONTS: Record<LabelStyle, string> = {
  focus: '600 13px system-ui, "Segoe UI", sans-serif',
  context: '500 11px system-ui, "Segoe UI", sans-serif',
  active: '700 13px system-ui, "Segoe UI", sans-serif',
};

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Area and bar names drawn on a transparent canvas over the globe. Labels are placed in
 * priority order and skipped when they'd overlap one already placed, or when their area
 * is too small on screen to hold them, so the globe never turns into a pile of text.
 * Layout reruns only when the view or the labels change.
 */
export class LabelLayer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private candidates: LabelCandidate[] = [];
  private enabled = true;
  private lastKey = '';
  private readonly widths = new Map<string, number>();

  constructor(
    container: HTMLElement,
    private readonly renderer: GlobeRenderer,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'label-layer';
    this.canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    const loop = () => {
      this.drawIfChanged();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  set(candidates: LabelCandidate[], enabled: boolean): void {
    this.candidates = [...candidates].sort(
      (a, b) => b.priority - a.priority || (b.radiusDeg ?? 0) - (a.radiusDeg ?? 0),
    );
    this.enabled = enabled;
    this.lastKey = ''; // force a redraw
    this.forced = true;
  }

  private forced = false;
  private lastLayout = 0;

  /** Labels placed in the last layout (for tests and debugging). */
  placedTexts: string[] = [];

  private drawIfChanged(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const key = `${this.renderer.viewKey()}|${w}x${h}`;
    if (key === this.lastKey) return;
    // While the view keeps moving (auto-rotate), re-lay out at most LAYOUT_FPS times a
    // second; label or hover changes still apply immediately.
    const now = performance.now();
    if (!this.forced && now - this.lastLayout < 1000 / LAYOUT_FPS) return;
    this.forced = false;
    this.lastLayout = now;
    this.lastKey = key;

    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled || w === 0) return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const placed: Rect[] = [];
    this.placedTexts = [];
    for (const c of this.candidates) {
      if (placed.length >= MAX_LABELS) break;
      const p = this.renderer.project(c.lat, c.lng);
      if (!p || p.x < 0 || p.y < 0 || p.x > w || p.y > h) continue;

      ctx.font = FONTS[c.style];
      const width = this.textWidth(c);
      const height = c.style === 'context' ? 13 : 16;
      if (c.style !== 'active' && c.radiusDeg !== undefined && !this.fits(c, p, width)) continue;

      // Bars are labeled just above their base; areas at their center.
      const y = c.radiusDeg === undefined ? p.y - 12 : p.y;
      const rect = { x0: p.x - width / 2 - PAD, y0: y - height / 2 - PAD, x1: p.x + width / 2 + PAD, y1: y + height / 2 + PAD };
      if (rect.x0 < 0 || rect.y0 < 0 || rect.x1 > w || rect.y1 > h) continue; // would be cut off
      if (placed.some((r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0)) continue;
      placed.push(rect);
      this.placedTexts.push(`${c.style}:${c.text}`);
      this.drawLabel(c, p.x, y, width, height);
    }
  }

  /** Whether an area is big enough on screen to hold its label (roughly half of it). */
  private fits(c: LabelCandidate, p: { x: number; y: number }, width: number): boolean {
    // Screen size of one degree near the label, from a point half a degree north.
    const north = this.renderer.project(Math.min(89.9, c.lat + 0.5), c.lng);
    if (!north) return false;
    const pxPerDeg = Math.hypot(north.x - p.x, north.y - p.y) * 2;
    // radiusDeg covers the bounding box's corners, so the area itself is a bit smaller.
    const radiusPx = c.radiusDeg! * pxPerDeg * 0.6;
    return radiusPx >= 12 && radiusPx * 2 >= width * 0.55;
  }

  private drawLabel(c: LabelCandidate, x: number, y: number, width: number, height: number): void {
    const ctx = this.ctx;
    if (c.style === 'active') {
      ctx.fillStyle = 'rgba(20, 24, 32, 0.85)';
      ctx.beginPath();
      ctx.roundRect(x - width / 2 - 6, y - height / 2 - 3, width + 12, height + 6, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(c.text, x, y + 0.5);
      return;
    }
    ctx.globalAlpha = c.style === 'context' ? 0.75 : 1;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 3;
    ctx.strokeText(c.text, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(c.text, x, y);
    ctx.globalAlpha = 1;
  }

  private textWidth(c: LabelCandidate): number {
    const key = `${c.style}|${c.text}`;
    let width = this.widths.get(key);
    if (width === undefined) {
      width = this.ctx.measureText(c.text).width;
      this.widths.set(key, width);
    }
    return width;
  }
}
