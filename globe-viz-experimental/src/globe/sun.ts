/**
 * A sun just behind the globe's upper-right edge: a big glow behind the globe, a backlit
 * rim of atmosphere that fades around the limb, a starburst where the sun peeks past the
 * edge, faint lens ghosts, and a darker far side, for an eclipse look. All gradient fills
 * in screen space, so they cost about the same at any data size, and both renderers share
 * them (the WebGL globe draws them on canvases behind and in front of itself).
 */

/** Direction from the globe's center to the sun, in screen radians (y points down). */
export const SUN_ANGLE = -0.62;
const COS = Math.cos(SUN_ANGLE);
const SIN = Math.sin(SUN_ANGLE);

const at = (cx: number, cy: number, dist: number) => ({ x: cx + COS * dist, y: cy + SIN * dist });

/** Glow behind the globe; draw before the globe so the globe eclipses its center. */
export function drawSunBehind(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const s = at(cx, cy, r * 1.03);
  // Kept tight around the sun so the glow hugs the globe instead of filling space.
  const reach = r * 0.85;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, reach);
  g.addColorStop(0, 'rgba(240, 248, 255, 0.95)');
  g.addColorStop(0.08, 'rgba(190, 220, 255, 0.5)');
  g.addColorStop(0.3, 'rgba(70, 140, 255, 0.16)');
  g.addColorStop(0.65, 'rgba(35, 95, 230, 0.04)');
  g.addColorStop(1, 'rgba(20, 60, 180, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(s.x - reach, s.y - reach, reach * 2, reach * 2);
  ctx.restore();
}

/**
 * Darkens the side of the globe facing away from the sun. Call with the globe's sphere
 * path already set as the current path (or after clipping to it).
 */
export function sunShade(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): CanvasGradient {
  const lit = at(cx, cy, r);
  const dark = at(cx, cy, -r);
  const g = ctx.createLinearGradient(lit.x, lit.y, dark.x, dark.y);
  g.addColorStop(0, 'rgba(110, 175, 255, 0.10)');
  g.addColorStop(0.3, 'rgba(0, 0, 0, 0)');
  g.addColorStop(0.75, 'rgba(0, 4, 14, 0.38)');
  g.addColorStop(1, 'rgba(0, 4, 14, 0.62)');
  return g;
}

/**
 * Electric-blue rim light that hugs the globe, like the reference: the glow lives on the
 * globe itself, brightening steadily toward the edge, with a crisp blue-white line at the
 * edge and only a hairline of haze outside it. It's strongest on the sun's side but wraps
 * well around the globe, never quite disappearing.
 *
 * Two gradients are combined, so it's drawn on its own layer: a radial gradient (brighter
 * toward the edge), then masked with a linear one (brighter toward the sun) and added
 * onto ctx. The layer is screen-sized, so it works at any zoom.
 */
function drawLimbGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  lit: { x: number; y: number },
  dark: { x: number; y: number },
): void {
  const layer = document.createElement('canvas');
  layer.width = Math.max(1, ctx.canvas.width);
  layer.height = Math.max(1, ctx.canvas.height);
  const g = layer.getContext('2d')!;
  g.setTransform(ctx.getTransform());

  // Radial profile: transparent deep inside, building to a bright edge, then a short fade.
  const outer = 1.022;
  const radial = g.createRadialGradient(cx, cy, r * 0.78, cx, cy, r * outer);
  const at = (rel: number) => (rel - 0.78) / (outer - 0.78);
  radial.addColorStop(0, 'rgba(20, 100, 255, 0)');
  radial.addColorStop(at(0.9), 'rgba(25, 110, 255, 0.12)');
  radial.addColorStop(at(0.955), 'rgba(40, 135, 255, 0.32)');
  radial.addColorStop(at(0.985), 'rgba(80, 170, 255, 0.6)');
  radial.addColorStop(at(0.997), 'rgba(175, 222, 255, 0.95)'); // the crisp edge line
  radial.addColorStop(at(1.004), 'rgba(120, 190, 255, 0.55)');
  radial.addColorStop(1, 'rgba(40, 120, 255, 0)'); // hairline haze, gone by 1.022 r
  g.fillStyle = radial;
  g.beginPath();
  g.arc(cx, cy, r * outer, 0, 2 * Math.PI);
  g.fill();

  // Directional mask: full strength toward the sun, easing to a faint rim on the far side.
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createLinearGradient(lit.x, lit.y, dark.x, dark.y);
  mask.addColorStop(0, 'rgba(0, 0, 0, 1)');
  mask.addColorStop(0.3, 'rgba(0, 0, 0, 0.8)');
  mask.addColorStop(0.6, 'rgba(0, 0, 0, 0.45)');
  mask.addColorStop(1, 'rgba(0, 0, 0, 0.22)');
  g.fillStyle = mask;
  // Same (CSS-pixel) space as the gradient; generously covers the whole layer.
  g.fillRect(cx - r * 4 - layer.width, cy - r * 4 - layer.height, r * 8 + layer.width * 2, r * 8 + layer.height * 2);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

/** Backlit rim and flare; draw after the globe and everything on it. */
export function drawSunFront(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const lit = at(cx, cy, r);
  const dark = at(cx, cy, -r);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  drawLimbGlow(ctx, cx, cy, r, lit, dark);

  // Starburst where the sun peeks past the limb.
  const core = ctx.createRadialGradient(lit.x, lit.y, 0, lit.x, lit.y, r * 0.09);
  core.addColorStop(0, 'rgba(255, 255, 255, 1)');
  core.addColorStop(0.2, 'rgba(215, 235, 255, 0.8)');
  core.addColorStop(1, 'rgba(110, 170, 255, 0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(lit.x, lit.y, r * 0.09, 0, 2 * Math.PI);
  ctx.fill();
  const ray = (angle: number, length: number, width: number, alpha: number) => {
    const dx = Math.cos(angle) * length;
    const dy = Math.sin(angle) * length;
    const g = ctx.createLinearGradient(lit.x - dx, lit.y - dy, lit.x + dx, lit.y + dy);
    g.addColorStop(0, 'rgba(200, 225, 255, 0)');
    g.addColorStop(0.5, `rgba(235, 245, 255, ${alpha * 0.8})`);
    g.addColorStop(1, 'rgba(200, 225, 255, 0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(lit.x - dx, lit.y - dy);
    ctx.lineTo(lit.x + dx, lit.y + dy);
    ctx.stroke();
  };
  ray(0, r * 0.75, 2, 0.75); // long horizontal streak
  ray(Math.PI / 2, r * 0.28, 1.5, 0.55);
  ray(Math.PI / 4, r * 0.2, 1.2, 0.4);
  ray(-Math.PI / 4, r * 0.2, 1.2, 0.4);

  // Faint lens ghosts along the line from the sun through the center.
  for (const [t, size, alpha] of [
    [0.45, 0.05, 0.1],
    [0.8, 0.09, 0.06],
    [1.35, 0.14, 0.05],
  ] as const) {
    const gx = lit.x + (cx - lit.x) * t * 2;
    const gy = lit.y + (cy - lit.y) * t * 2;
    const ghost = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * size);
    ghost.addColorStop(0, `rgba(160, 200, 255, ${alpha})`);
    ghost.addColorStop(1, 'rgba(160, 200, 255, 0)');
    ctx.fillStyle = ghost;
    ctx.beginPath();
    ctx.arc(gx, gy, r * size, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}
