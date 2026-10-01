import { FILL_BY_DRILL, FILL_BY_ZIP, detectHierarchy } from './globe/layers';
import type { GlobeData, GlobeSettings } from './types';

const KEY = 'globeSettings';

export const DEFAULT_SETTINGS: GlobeSettings = {
  mapType: 'points',
  fillBy: '',
  rollup: 'sum',
  singleColor: '#00e5ff',
  sequentialScheme: 'Neon',
  categoricalScheme: 'Neon',
  showLabels: true,
  neonOutlines: true,
  detailedEarth: true,
  showSun: true,
  showLegend: true,
  legendTitle: '',
  categoryColors: {},
  autoRotate: true,
  rotateSpeed: 0.6,
  texture: 'midnight',
  barScale: 1,
  barRadius: 0.6,
  showAtmosphere: true,
};

/**
 * Settings persist in tableau.extensions.settings (saved with the workbook).
 * In mock mode they fall back to localStorage.
 */
export function loadSettings(inTableau: boolean): GlobeSettings {
  let raw: string | null | undefined;
  try {
    raw = inTableau ? tableau.extensions.settings.get(KEY) : localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<GlobeSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: GlobeSettings, inTableau: boolean): Promise<void> {
  const raw = JSON.stringify(settings);
  try {
    if (inTableau) {
      tableau.extensions.settings.set(KEY, raw);
      await tableau.extensions.settings.saveAsync();
    } else {
      localStorage.setItem(KEY, raw);
    }
  } catch (err) {
    // Viewers without edit rights can't persist settings; changes still apply for the session.
    console.warn('[globe] could not save settings', err);
  }
}

/** Wires the settings form to the current settings; calls onChange with the updated object. */
export function bindSettingsPanel(
  toggle: HTMLButtonElement,
  form: HTMLFormElement,
  settings: GlobeSettings,
  onChange: (s: GlobeSettings) => void,
): void {
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
  });

  const input = (name: keyof GlobeSettings) => form.elements.namedItem(name) as HTMLInputElement;
  const select = (name: keyof GlobeSettings) => form.elements.namedItem(name) as HTMLSelectElement;
  select('mapType').value = settings.mapType;
  select('rollup').value = settings.rollup;
  input('singleColor').value = settings.singleColor;
  select('sequentialScheme').value = settings.sequentialScheme;
  select('categoricalScheme').value = settings.categoricalScheme;
  input('showLabels').checked = settings.showLabels;
  input('neonOutlines').checked = settings.neonOutlines;
  input('detailedEarth').checked = settings.detailedEarth;
  input('showSun').checked = settings.showSun;
  input('showLegend').checked = settings.showLegend;
  input('legendTitle').value = settings.legendTitle;
  input('autoRotate').checked = settings.autoRotate;
  input('rotateSpeed').value = String(settings.rotateSpeed);
  select('texture').value = settings.texture;
  input('barScale').value = String(settings.barScale);
  input('barRadius').value = String(settings.barRadius);
  input('showAtmosphere').checked = settings.showAtmosphere;

  // Tracks the latest settings, for the category colors that aren't on screen right now.
  let current = settings;
  const categoryColors = () => {
    const colors = { ...current.categoryColors };
    for (const picker of form.querySelectorAll<HTMLInputElement>('input[data-category]')) {
      const category = picker.dataset.category!;
      // Only colors that differ from the palette are saved, so the rest keep following it.
      if (picker.value.toLowerCase() === picker.dataset.paletteColor) delete colors[category];
      else colors[category] = picker.value;
    }
    return colors;
  };
  form.querySelector('.reset-colors')?.addEventListener('click', () => {
    for (const picker of form.querySelectorAll<HTMLInputElement>('input[data-category]')) {
      picker.value = picker.dataset.paletteColor!;
    }
    form.dispatchEvent(new Event('input'));
  });

  form.addEventListener('input', () => {
    current = {
      mapType: select('mapType').value as GlobeSettings['mapType'],
      fillBy: select('fillBy').value,
      rollup: select('rollup').value as GlobeSettings['rollup'],
      singleColor: input('singleColor').value,
      sequentialScheme: select('sequentialScheme').value as GlobeSettings['sequentialScheme'],
      categoricalScheme: select('categoricalScheme').value as GlobeSettings['categoricalScheme'],
      showLabels: input('showLabels').checked,
      neonOutlines: input('neonOutlines').checked,
      detailedEarth: input('detailedEarth').checked,
      showSun: input('showSun').checked,
      showLegend: input('showLegend').checked,
      legendTitle: input('legendTitle').value,
      categoryColors: categoryColors(),
      autoRotate: input('autoRotate').checked,
      rotateSpeed: Number(input('rotateSpeed').value),
      texture: select('texture').value as GlobeSettings['texture'],
      barScale: Number(input('barScale').value),
      barRadius: Number(input('barRadius').value),
      showAtmosphere: input('showAtmosphere').checked,
    };
    onChange(current);
  });
  form.addEventListener('submit', (e) => e.preventDefault());
}

/**
 * One color picker per category on Color (e.g. AVG, LOW, HIGH), showing the chosen color
 * or the palette's. Rebuilt only when the categories or palette colors change, so a picker
 * being dragged isn't replaced mid-change.
 */
export function updateCategoryColors(
  form: HTMLFormElement,
  categories: string[],
  paletteColorOf: (category: string) => string,
  settings: GlobeSettings,
): void {
  const section = form.querySelector<HTMLElement>('#category-colors');
  const list = section?.querySelector<HTMLElement>('.category-list');
  if (!section || !list) return;
  if (categories.length === 0) {
    section.hidden = true;
    return;
  }
  const shown = categories.slice(0, MAX_CATEGORY_PICKERS);
  const palette = shown.map((c) => toHex(paletteColorOf(c)));
  const signature = JSON.stringify([shown, palette]);
  if (list.dataset.signature !== signature) {
    list.replaceChildren(
      ...shown.map((category, i) => {
        const label = document.createElement('label');
        label.className = 'row';
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.dataset.category = category;
        picker.dataset.paletteColor = palette[i];
        label.append(picker, ` ${category}`);
        label.title = category;
        return label;
      }),
    );
    list.dataset.signature = signature;
  }
  for (const picker of list.querySelectorAll<HTMLInputElement>('input[data-category]')) {
    const wanted = settings.categoryColors[picker.dataset.category!] ?? picker.dataset.paletteColor!;
    if (document.activeElement !== picker && picker.value !== wanted) picker.value = wanted;
  }
  section.hidden = false;
}

const MAX_CATEGORY_PICKERS = 12;

/** "rgb(r, g, b)" or "#rrggbb" → "#rrggbb" (what <input type=color> accepts). */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return '#888888';
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Fills the "Fill by" list from the sheet's fields: automatic, ZIP (if present), then each
 * text dimension (Region, Territory…). A saved choice that isn't in the sheet stays listed
 * so it isn't silently lost when a field is temporarily removed.
 */
export function updateFillByOptions(form: HTMLFormElement, data: GlobeData, settings: GlobeSettings): void {
  const select = form.elements.namedItem('fillBy') as HTMLSelectElement | null;
  if (!select) return;
  const options: [string, string][] = [
    ['', data.zipField ? 'Automatic (each ZIP)' : 'Automatic (each country / state)'],
  ];
  const hierarchy = detectHierarchy(data);
  if (hierarchy.length > 0) {
    options.push([FILL_BY_DRILL, `Drill down: ${[...hierarchy, data.zipField ? 'ZIP' : 'State'].join(' → ')}`]);
  }
  if (data.zipField) options.push([FILL_BY_ZIP, `Each ZIP (${data.zipField})`]);
  for (const f of data.groupFields ?? []) options.push([f, `Merge by ${f}`]);
  if (settings.fillBy && !options.some(([v]) => v === settings.fillBy)) {
    const label =
      settings.fillBy === FILL_BY_ZIP ? 'Each ZIP' : settings.fillBy === FILL_BY_DRILL ? 'Drill down' : `Merge by ${settings.fillBy}`;
    options.push([settings.fillBy, `${label} (not available for this sheet)`]);
  }
  const signature = JSON.stringify(options);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
    select.dataset.signature = signature;
  }
  select.value = settings.fillBy;
}
