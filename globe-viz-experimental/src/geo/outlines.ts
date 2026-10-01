import type { GlobeData } from '../types';

/**
 * Remembers which ZIPs belong to which Region / Territory (the drill-down hierarchy) from
 * the fullest data seen, so area outlines don't change when filters remove ZIPs.
 *
 * Filters only ever remove rows, so an unfiltered view teaches it every ZIP; later,
 * filtered views still merge each area from all of its known ZIPs. The values (colors,
 * heights) always come from the current data. A ZIP's latest membership wins, so
 * territory realignments are picked up; "Reset remembered outlines" starts over.
 * It's saved with the workbook, so a workbook opened already filtered keeps full outlines.
 */
export class OutlineMemory {
  /** The hierarchy, coarsest first, e.g. ["Region", "Territory"]. */
  fields: string[] = [];
  /** ZIP → its value for each of `fields`. */
  private zips = new Map<string, string[]>();
  /** Bumped whenever membership changes, so layers know to rebuild. */
  version = 0;

  get size(): number {
    return this.zips.size;
  }

  clear(): void {
    this.fields = [];
    this.zips.clear();
    this.version++;
  }

  /**
   * Records the ZIP memberships in `data` for hierarchy `levels`. If the remembered
   * hierarchy no longer fits the sheet (fields removed or replaced), it starts over.
   * Returns true if anything changed.
   */
  learn(data: GlobeData, levels: string[]): boolean {
    if (!data.zipField || levels.length === 0) return false;
    let changed = false;
    if (this.fields.join('\u0001') !== levels.join('\u0001')) {
      this.fields = [...levels];
      this.zips.clear();
      changed = true;
    }
    for (const p of data.points) {
      if (!p.zip) continue;
      const values = this.fields.map((f) => p.dims?.[f] ?? '');
      if (values.some((v) => !v || v === 'Null')) continue;
      const known = this.zips.get(p.zip);
      if (known && known.every((v, i) => v === values[i])) continue;
      this.zips.set(p.zip, values);
      changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  /**
   * The remembered hierarchy if the sheet still has those fields (filtering can hide a
   * level from detection, e.g. one Region left), else null.
   */
  levelsFor(data: GlobeData): string[] | null {
    if (this.fields.length === 0 || !data.zipField) return null;
    return this.fields.every((f) => data.groupFields?.includes(f)) ? this.fields : null;
  }

  /**
   * ZIPs grouped by their value of the hierarchy field `level`, among the ZIPs inside
   * `path` (values for the levels above, e.g. ["Southeast"] when level = 1).
   */
  groupZips(level: number, path: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const [zip, values] of this.zips) {
      if (path.some((v, i) => values[i] !== v)) continue;
      const key = values[level];
      const list = groups.get(key);
      if (list) list.push(zip);
      else groups.set(key, [zip]);
    }
    return groups;
  }

  /** All ZIPs inside `path` (a full path through every level). */
  zipsIn(path: string[]): string[] {
    const out: string[] = [];
    for (const [zip, values] of this.zips) if (path.every((v, i) => values[i] === v)) out.push(zip);
    return out;
  }

  /** Compact text form for workbook settings: value tables plus "zip,i,j" per ZIP. */
  serialize(): string {
    const tables = this.fields.map(() => new Map<string, number>());
    const rows: string[] = [];
    for (const [zip, values] of this.zips) {
      const idx = values.map((v, i) => {
        let n = tables[i].get(v);
        if (n === undefined) {
          n = tables[i].size;
          tables[i].set(v, n);
        }
        return n;
      });
      rows.push(`${zip},${idx.join(',')}`);
    }
    return JSON.stringify({ f: this.fields, v: tables.map((t) => [...t.keys()]), z: rows.join(';') });
  }

  static parse(text: string | null | undefined): OutlineMemory {
    const memory = new OutlineMemory();
    if (!text) return memory;
    try {
      const { f, v, z } = JSON.parse(text) as { f: string[]; v: string[][]; z: string };
      memory.fields = f;
      for (const row of z ? z.split(';') : []) {
        const [zip, ...idx] = row.split(',');
        memory.zips.set(zip, idx.map((n, i) => v[i][Number(n)]));
      }
    } catch {
      return new OutlineMemory();
    }
    return memory;
  }
}
