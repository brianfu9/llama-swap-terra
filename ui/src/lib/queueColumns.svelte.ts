// Column selection and ordering for the request queue's tables (terra fork,
// patch 34). Same pattern as the activity and in-flight tables in
// ActivityTable.svelte: a persisted per-column visibility and a persisted
// column order, reconciled against the current column set. Each of the
// panel's tables (running batch, waiting line, other in flight) owns one
// QueueColumnGroup; the panel's single "columns" dropdown has one section
// per group.
import { get } from "svelte/store";
import { persistentStore } from "../stores/persistent";

export interface QueueColumn {
  id: string;
  label: string;
  defaultVisible: boolean;
  /** Right-align the column (numeric values). */
  right?: boolean;
}

// Drop stale ids and append any new columns so a stored order always
// represents the current column set exactly.
export function reconcileColumnOrder(stored: string[], cols: QueueColumn[]): string[] {
  const known = new Set(cols.map((c) => c.id));
  const kept = stored.filter((id) => known.has(id));
  const missing = cols.filter((c) => !kept.includes(c.id)).map((c) => c.id);
  return [...kept, ...missing];
}

export function defaultVisibility(cols: QueueColumn[]): Record<string, boolean> {
  const v: Record<string, boolean> = {};
  for (const c of cols) v[c.id] = c.defaultVisible;
  return v;
}

// A hovered row only yields once the pointer passes its midpoint in the
// direction of travel. Without that hysteresis the swap fires as soon as the
// pointer touches the neighbour and the rows oscillate.
//
// The midpoint comes from offsetTop/offsetHeight rather than
// getBoundingClientRect() because the rect includes the in-flight
// animate:flip transform: hit-testing a row that is still sliding compares
// against a position that no longer matches where it will settle.
// (Same hysteresis as the activity table's picker.)
export function crossedMidpoint(e: DragEvent, movingDown: boolean): boolean {
  const el = e.currentTarget as HTMLElement | null;
  const parent = el?.offsetParent as HTMLElement | null;
  if (!el || !parent) return true;
  const top = parent.getBoundingClientRect().top - parent.scrollTop + el.offsetTop;
  const midpoint = top + el.offsetHeight / 2;
  return movingDown ? e.clientY > midpoint : e.clientY < midpoint;
}

// One queue table's column state: persisted visibility and order plus the
// live drag-reorder handlers the picker's items use.
export class QueueColumnGroup {
  readonly title: string;
  readonly cols: QueueColumn[];
  readonly labelMap: Record<string, string>;
  order: string[] = $state([]);
  visibility: Record<string, boolean> = $state({});
  dragId: string | null = $state(null);

  private orderStore: ReturnType<typeof persistentStore<string[]>>;
  private visibilityStore: ReturnType<typeof persistentStore<Record<string, boolean>>>;

  constructor(storagePrefix: string, key: string, title: string, cols: QueueColumn[]) {
    this.title = title;
    this.cols = cols;
    this.labelMap = Object.fromEntries(cols.map((c) => [c.id, c.label]));
    // svelte-ignore state_referenced_locally
    this.visibilityStore = persistentStore<Record<string, boolean>>(
      `${storagePrefix}-queue-${key}-columns`,
      {}
    );
    // svelte-ignore state_referenced_locally
    this.orderStore = persistentStore<string[]>(
      `${storagePrefix}-queue-${key}-column-order`,
      []
    );

    const storedVisibility = get(this.visibilityStore);
    this.visibility =
      Object.keys(storedVisibility).length > 0
        ? storedVisibility
        : defaultVisibility(cols);

    const storedOrder = get(this.orderStore);
    const reconciled = reconcileColumnOrder(storedOrder, cols);
    this.order = reconciled;
    if (reconciled.length !== storedOrder.length || reconciled.some((id, i) => id !== storedOrder[i])) {
      this.orderStore.set(reconciled);
    }
  }

  get visible(): string[] {
    return this.order.filter((id) => this.visibility[id] !== false);
  }

  label(colId: string): string {
    return this.labelMap[colId] ?? colId;
  }

  headerClass(colId: string, base: string): string {
    const col = this.cols.find((c) => c.id === colId);
    return col?.right ? `${base} text-right` : base;
  }

  toggle(colId: string, visible: boolean) {
    this.visibility = { ...this.visibility, [colId]: visible };
    this.visibilityStore.set(this.visibility);
  }

  onDragStart(e: DragEvent, colId: string) {
    this.dragId = colId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", colId);
    }
  }

  // Reorders `order` live as the drag crosses other items, so each item's
  // animate:flip animates the columns sliding out of the way and the menu's
  // order always matches what the table shows.
  onDragOver(e: DragEvent, colId: string) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!this.dragId || this.dragId === colId) return;
    const next = [...this.order];
    const from = next.indexOf(this.dragId);
    const to = next.indexOf(colId);
    if (from === -1 || to === -1 || from === to) return;
    if (!crossedMidpoint(e, to > from)) return;
    next.splice(from, 1);
    next.splice(to, 0, this.dragId);
    this.order = next;
  }

  onDrop(e: DragEvent) {
    e.preventDefault();
    this.persist();
  }

  onDragEnd() {
    this.persist();
  }

  private persist() {
    this.dragId = null;
    this.orderStore.set(this.order);
  }
}
