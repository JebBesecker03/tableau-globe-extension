import type { Worksheet } from '@tableau/extensions-api-types';
import { loadZipShapes, zipShapesLoaded } from './geo/shapes';
import { CanvasGlobe } from './globe/canvas';
import { type LabelCandidate, LabelLayer } from './globe/labels';
import { type Layers, buildLayers } from './globe/layers';
import { type PointStyle, buildPointStyle, isSelected, tupleIdsOf } from './globe/points';
import { type GlobeRenderer, type SceneHandlers, hasWebGL } from './globe/renderer';
import { GlobeScene } from './globe/scene';
import { mockData } from './mock';
import { bindSettingsPanel, loadSettings, saveSettings, updateFillByOptions } from './settings';
import { readGlobeData } from './tableau/data';
import { TableauInteraction } from './tableau/interaction';
import type { GlobeData, GlobePoint, GlobeSettings } from './types';

const INIT_TIMEOUT_MS = 4000;

const container = document.getElementById('globe')!;
const statusEl = document.getElementById('status')!;
const noteEl = document.getElementById('note')!;
const colorInfoEl = document.getElementById('color-info')!;
const areaTipEl = document.getElementById('area-tip')!;
const breadcrumbEl = document.getElementById('breadcrumb')!;
const settingsForm = document.getElementById('settings-panel') as HTMLFormElement;

let data: GlobeData = { points: [], colorKind: 'none', missing: [] };
let settings: GlobeSettings;
const selected = new Set<number>();
/** Drill-down: the opened area, e.g. ["East", "NE Metro"]; [] = top level. Replaced, never mutated. */
let drillPath: string[] = [];

async function start(): Promise<void> {
  showStatus('Connecting to Tableau…');
  const worksheet = await initTableau();
  const inTableau = worksheet !== null;

  showStatus('Starting globe renderer…');
  settings = loadSettings(inTableau);
  const interaction = new TableauInteraction(worksheet, container);

  const handlers: SceneHandlers = {
    onPointHover: (p) => {
      hovered = p;
      refreshLabels();
      if (p?.tupleIds) {
        // A merged area stands for many marks; Tableau's tooltip would describe only one.
        interaction.hover(null);
        showAreaTip(p);
      } else {
        hideAreaTip();
        interaction.hover(p?.tupleId ?? null);
      }
    },
    onPointClick: (p, event) => {
      if (p.drillPath) {
        drillTo(p.drillPath);
        return;
      }
      const ids = tupleIdsOf(p);
      const toggle = event.ctrlKey || event.metaKey || event.shiftKey;
      if (toggle && isSelected(p, selected)) ids.forEach((id) => selected.delete(id));
      else {
        if (!toggle) selected.clear();
        ids.forEach((id) => selected.add(id));
      }
      interaction.select(ids, event, toggle);
      render();
      const shown = [...layers.points, ...layers.regions.map((r) => r.point)];
      scene.flyTo(shown.filter((pt) => isSelected(pt, selected) && Number.isFinite(pt.lat)));
    },
    onEmptyClick: () => {
      // In a drill-down, clicking outside the areas goes back up one level.
      if (layers.drillLevels && drillPath.length > 0) {
        drillTo(drillPath.slice(0, -1));
        return;
      }
      if (selected.size === 0) return;
      selected.clear();
      interaction.clearSelection();
      render();
    },
  };

  /**
   * Opens `path` in the drill-down (e.g. ["East"] shows East's territories), selects that
   * area's marks in Tableau so dashboard actions follow, and frames what's now shown.
   */
  const drillTo = (path: string[]) => {
    drillPath = path;
    const levels = layers.drillLevels ?? [];
    const members = data.points.filter((p) => path.every((v, i) => p.dims?.[levels[i]] === v));
    selected.clear();
    if (path.length === 0) interaction.clearSelection();
    else {
      members.forEach((p) => selected.add(p.tupleId));
      interaction.select(
        members.map((p) => p.tupleId),
        undefined,
        false,
      );
    }
    render();
    // Frame the opened area's children (or, at the top, every area).
    const shown = layers.regions.map((r) => r.point).filter((p) => (p.level ?? 0) === path.length);
    scene.flyTo(shown.length > 0 ? shown : layers.regions.map((r) => r.point));
  };

  // Tableau Desktop's embedded browser has no WebGL; fall back to the Canvas globe there.
  const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
  const scene: GlobeRenderer =
    !forceCanvas && hasWebGL()
      ? new GlobeScene(container, settings, handlers)
      : new CanvasGlobe(container, settings, handlers);

  // Rebuild bars/areas only when their inputs change, so selection re-renders reuse the
  // same arrays (the Canvas globe re-animates new arrays, and merging ZIPs isn't free).
  let layers: Layers = buildLayers(data, settings);
  let layersKey: unknown[] = [];
  const render = () => {
    const key = [data, settings.mapType, settings.fillBy, settings.rollup, zipShapesLoaded(), drillPath];
    if (key.some((v, i) => v !== layersKey[i])) {
      layers = buildLayers(data, settings, drillPath);
      layersKey = key;
      if (layers.needsZipShapes) {
        loadZipShapes()
          .then(render)
          .catch((err) => showNote(`Couldn't load ZIP outlines: ${errorText(err)}`));
      }
    }
    // One scale per drill level, so e.g. Territories are colored relative to each other.
    const styles = layers.styleGroups.map((group) => buildPointStyle(group, settings, selected));
    const styleOf = (p: GlobePoint) => styles[p.level ?? 0] ?? styles[0];
    const style: PointStyle = {
      altitude: (p) => styleOf(p).altitude(p),
      color: (p) => styleOf(p).color(p),
      radius: styles[0].radius,
      hasHeight: styles.some((s) => s.hasHeight),
    };
    scene.setRegions(layers.regions, style);
    scene.setPoints(layers.points, style);
    showNote(layers.note);
    renderBreadcrumb(layers.drillLevels, drillPath, drillTo);
    refreshLabels();
    colorInfoEl.textContent = colorInfoText(data);
    updateFillByOptions(settingsForm, data, settings);
  };

  const labels = new LabelLayer(container, scene);
  let hovered: GlobePoint | null = null;
  const refreshLabels = () =>
    labels.set(labelCandidates(layers, drillPath, selected, hovered), settings.showLabels);

  if (import.meta.env.DEV) {
    Object.assign(window, {
      __scene: scene,
      __globe: scene instanceof GlobeScene ? scene.globe : undefined,
      __layers: () => layers,
      __labels: labels,
    });
  }

  const showAuthoringUi = !inTableau || String(tableau.extensions.environment.mode) === 'authoring';
  if (showAuthoringUi) {
    bindSettingsPanel(document.getElementById('settings-toggle') as HTMLButtonElement, settingsForm, settings, (next) => {
      if (next.fillBy !== settings.fillBy || next.mapType !== settings.mapType) drillPath = [];
      settings = next;
      scene.applySettings(settings);
      render();
      void saveSettings(settings, inTableau);
    });
  }

  const refresh = async () => {
    try {
      if (data.points.length === 0) showStatus('Reading worksheet data…');
      const next = worksheet ? await readGlobeData(worksheet) : mockData(mockParam());
      // Tuple ids are row positions, so a changed row count invalidates the selection.
      if (next.points.length !== data.points.length) selected.clear();
      data = next;
      showStatus(statusMessage(data));
      render();
    } catch (err) {
      console.error('[globe] failed to read data', err);
      showStatus(`Could not read worksheet data:\n${errorText(err)}`);
    }
  };

  if (worksheet) {
    worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, () => void refresh());
    tableau.extensions.settings.addEventListener(tableau.TableauEventType.SettingsChanged, () => {
      settings = loadSettings(true);
      scene.applySettings(settings);
      render();
    });
  }

  container.addEventListener('pointermove', (e) => {
    areaTipEl.style.left = `${e.clientX + 14}px`;
    areaTipEl.style.top = `${e.clientY + 14}px`;
  });
  container.addEventListener('pointerleave', hideAreaTip);

  await refresh();
}

/** Resolves the worksheet inside Tableau, or null in a plain browser (mock mode). */
async function initTableau(): Promise<Worksheet | null> {
  if (new URLSearchParams(location.search).has('mock')) return null;
  if (typeof tableau === 'undefined') return null;
  try {
    await Promise.race([
      tableau.extensions.initializeAsync(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), INIT_TIMEOUT_MS)),
    ]);
    return tableau.extensions.worksheetContent?.worksheet ?? null;
  } catch {
    console.info('[globe] no Tableau host found; running with sample data');
    return null;
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      // fall through
    }
  }
  return String(err);
}

/** `?mock` (sample cities), `?mock=states` (US states by region), `?mock=zips`, or `?mock=20000`. */
function mockParam(): string {
  return new URLSearchParams(location.search).get('mock') ?? '';
}

const formatNumber = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Tooltip for a merged area: its name, how many marks it combines, and rolled-up values. */
function showAreaTip(p: GlobePoint): void {
  const [[field, value] = ['', p.label]] = Object.entries(p.dims ?? {});
  const how = settings.rollup === 'avg' ? 'average' : 'total';
  const unit = data.zipField ? 'ZIP' : 'mark';
  const lines = [`${field ? `${field}: ` : ''}${value}`, `${p.memberCount} ${unit}${p.memberCount === 1 ? '' : 's'}`];
  if (data.heightField && p.height !== null) lines.push(`${data.heightField} (${how}): ${formatNumber(p.height)}`);
  if (data.colorField && data.colorKind === 'continuous' && typeof p.colorValue === 'number' && data.colorField.name !== data.heightField) {
    lines.push(`${data.colorField.name} (${how}): ${formatNumber(p.colorValue)}`);
  }
  areaTipEl.textContent = lines.join('\n');
  areaTipEl.hidden = false;
}

function hideAreaTip(): void {
  areaTipEl.hidden = true;
}

/** Explains which color setting applies, since that depends on what's on Color. */
function colorInfoText(d: GlobeData): string {
  const field = d.colorField;
  if (!field) return 'Nothing is on Color, so every mark uses Single color.';
  if (!field.readable) return `"${field.name}" is on Color but its values couldn't be read, so marks use Single color.`;
  if (d.colorKind === 'continuous') {
    return `Color: "${field.name}" is a number, so it uses the palette for measures.`;
  }
  const categories = new Set(d.points.map((p) => p.colorValue)).size;
  return (
    `Color: "${field.name}" is treated as ${categories} categor${categories === 1 ? 'y' : 'ies'} ` +
    `(${field.dataType}), so it uses the palette for dimensions. ` +
    'For a red–green ramp, put a numeric measure on Color.'
  );
}

/** Bars are labeled only when there are few enough to stay readable. */
const MAX_BAR_LABELS = 80;
/** Outside a drill-down, up to this many selected areas/bars get a highlighted label. */
const MAX_ACTIVE_LABELS = 12;

/** What an area or bar is called on the map. */
function labelText(p: GlobePoint): string {
  if (p.radiusDeg === undefined) return p.label; // a bar: the mark's own name
  if (p.tupleIds) return p.label; // a merged area, e.g. a Region or Territory
  return p.zip ?? p.placeName ?? p.label; // a ZIP, state or country outline
}

/**
 * Labels in priority order: the hovered item (always shown), selected items, the areas
 * you're choosing between in a drill-down, then context areas and bars.
 */
function labelCandidates(
  layers: Layers,
  path: string[],
  selected: ReadonlySet<number>,
  hovered: GlobePoint | null,
): LabelCandidate[] {
  const drilling = !!layers.drillLevels;
  const selection = [...layers.regions.map((r) => r.point), ...layers.points].filter((p) => isSelected(p, selected));
  // In a drill-down the whole opened area is selected, so selection isn't highlighted there.
  const highlightSelected = !drilling && selection.length <= MAX_ACTIVE_LABELS;
  const out: LabelCandidate[] = [];
  const add = (p: GlobePoint, fallback: Omit<LabelCandidate, 'text' | 'lat' | 'lng' | 'radiusDeg'>) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
    const text = labelText(p);
    if (!text) return;
    let { priority, style } = fallback;
    if (hovered && tupleIdsOf(hovered)[0] === tupleIdsOf(p)[0] && hovered.label === p.label) {
      priority = 100;
      style = 'active';
    } else if (highlightSelected && isSelected(p, selected)) {
      priority = 50;
      style = 'active';
    }
    out.push({ text, lat: p.lat, lng: p.lng, radiusDeg: p.radiusDeg, priority, style });
  };
  for (const { point } of layers.regions) {
    const focus = !drilling || (point.level ?? 0) === path.length;
    add(point, focus ? { priority: 10, style: 'focus' } : { priority: 1, style: 'context' });
  }
  const labelAllBars = layers.points.length <= MAX_BAR_LABELS;
  for (const p of layers.points) {
    if (labelAllBars || isSelected(p, selected) || p === hovered) add(p, { priority: 0, style: 'context' });
  }
  return out;
}

/**
 * Drill-down trail, e.g. "All Regions › East › NE Metro", plus a hint for the next click.
 * Each earlier step is a button that goes back to that level.
 */
function renderBreadcrumb(levels: string[] | undefined, path: string[], go: (path: string[]) => void): void {
  if (!levels) {
    breadcrumbEl.hidden = true;
    return;
  }
  const plural = (name: string) =>
    /s$/i.test(name) ? name : /[^aeiou]y$/i.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`;
  const steps = [`All ${plural(levels[0])}`, ...path];
  const children = levels[path.length];
  const nodes: (HTMLElement | string)[] = [];
  steps.forEach((label, i) => {
    if (i > 0) nodes.push(' › ');
    if (i < steps.length - 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => go(path.slice(0, i)));
      nodes.push(button);
    } else {
      const current = document.createElement('strong');
      current.textContent = label;
      nodes.push(current);
    }
  });
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent =
    path.length < levels.length - 1
      ? `Click a ${levels[path.length]} to see its ${plural(levels[path.length + 1])}`
      : `Showing ${plural(children)}`;
  breadcrumbEl.replaceChildren(...nodes, hint);
  breadcrumbEl.hidden = false;
}

function showNote(message: string): void {
  noteEl.textContent = message;
  noteEl.hidden = message === '';
}

function statusMessage(d: GlobeData): string {
  if (d.points.length > 0) return '';
  return d.diagnostics ?? 'No marks to show.';
}

function showStatus(message: string): void {
  statusEl.textContent = message;
  statusEl.hidden = message === '';
}

start().catch((err) => {
  console.error('[globe] failed to start', err);
  showStatus(`Globe failed to start:\n${errorText(err)}\n\n${navigator.userAgent}`);
});
