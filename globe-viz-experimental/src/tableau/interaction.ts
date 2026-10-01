import type { Worksheet } from '@tableau/extensions-api-types';

/**
 * Bridges globe interactions to Tableau: native tooltips via hoverTupleAsync and
 * selection (which drives dashboard actions) via selectTuplesAsync.
 * With no worksheet (mock mode) calls are no-ops.
 */
export class TableauInteraction {
  private mouse = { x: 0, y: 0 };
  private hoveredTuple: number | null = null;

  constructor(
    private worksheet: Worksheet | null,
    container: HTMLElement,
  ) {
    // globe.gl's hover callback has no event, so track the pointer for tooltip anchoring.
    container.addEventListener('pointermove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
    });
    container.addEventListener('pointerleave', () => this.hover(null));
  }

  hover(tupleId: number | null): void {
    if (!this.worksheet || tupleId === this.hoveredTuple) return;
    this.hoveredTuple = tupleId;
    // An invalid id (0) clears the tooltip and hover state.
    this.worksheet
      .hoverTupleAsync(tupleId ?? 0, tupleId === null ? null : { tooltipAnchorPoint: this.mouse })
      .catch(logError('hover'));
  }

  /** Without `event`, Tableau's tooltip isn't shown (e.g. selecting a whole drilled-into area). */
  select(tupleIds: number[], event: MouseEvent | undefined, toggle: boolean): void {
    if (!this.worksheet) return;
    const option = toggle ? tableau.SelectOptions.Toggle : tableau.SelectOptions.Simple;
    const tooltip = event && { tooltipAnchorPoint: { x: event.clientX, y: event.clientY } };
    this.worksheet.selectTuplesAsync(tupleIds, option, tooltip).catch(logError('select'));
  }

  clearSelection(): void {
    this.worksheet?.clearSelectedMarksAsync().catch(logError('clear selection'));
  }
}

const logError = (action: string) => (err: unknown) => console.warn(`[globe] ${action} failed`, err);
