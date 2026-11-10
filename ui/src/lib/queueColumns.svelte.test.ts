import { afterEach, describe, expect, it } from "vitest";
import {
  QueueColumnGroup,
  defaultVisibility,
  reconcileColumnOrder,
  type QueueColumn,
} from "./queueColumns.svelte.js";

const cols: QueueColumn[] = [
  { id: "a", label: "A", defaultVisible: true },
  { id: "b", label: "B", defaultVisible: false },
  { id: "c", label: "C", defaultVisible: true, right: true },
];

function withStorage(stored: Record<string, string>) {
  const store = new Map(Object.entries(stored));
  (globalThis as Record<string, unknown>).window = {};
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("reconcileColumnOrder", () => {
  it("keeps a stored order of known ids", () => {
    expect(reconcileColumnOrder(["c", "a", "b"], cols)).toEqual(["c", "a", "b"]);
  });

  it("drops stale ids and appends new columns", () => {
    expect(reconcileColumnOrder(["x", "c", "a", "y"], cols)).toEqual(["c", "a", "b"]);
  });

  it("falls back to the default order when nothing is stored", () => {
    expect(reconcileColumnOrder([], cols)).toEqual(["a", "b", "c"]);
  });
});

describe("defaultVisibility", () => {
  it("reflects each column's defaultVisible", () => {
    expect(defaultVisibility(cols)).toEqual({ a: true, b: false, c: true });
  });
});

describe("QueueColumnGroup", () => {
  it("starts at the defaults when nothing is stored", () => {
    withStorage({});
    const g = new QueueColumnGroup("activity", "test", "Test", cols);
    expect(g.order).toEqual(["a", "b", "c"]);
    expect(g.visibility).toEqual({ a: true, b: false, c: true });
    expect(g.visible).toEqual(["a", "c"]);
    expect(g.label("b")).toBe("B");
    expect(g.headerClass("c", "base")).toBe("base text-right");
    expect(g.headerClass("a", "base")).toBe("base");
  });

  it("reconciles a stored order and persists the cleaned one", () => {
    withStorage({ "activity-queue-test-column-order": JSON.stringify(["x", "c", "a", "y"]) });
    const g = new QueueColumnGroup("activity", "test", "Test", cols);
    expect(g.order).toEqual(["c", "a", "b"]);
    expect(JSON.parse(localStorage.getItem("activity-queue-test-column-order") ?? "[]")).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("toggles visibility and persists it", () => {
    withStorage({});
    const g = new QueueColumnGroup("activity", "test", "Test", cols);
    g.toggle("a", false);
    expect(g.visible).toEqual(["c"]);
    expect(JSON.parse(localStorage.getItem("activity-queue-test-columns") ?? "{}")).toEqual({
      a: false,
      b: false,
      c: true,
    });
    g.toggle("b", true);
    expect(g.visible).toEqual(["b", "c"]);
  });

  function fakeDrag(clientY: number, rowTops: Record<string, { top: number; height: number }>) {
    const parent = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
    return (id: string) =>
      ({
        currentTarget: {
          offsetParent: parent,
          offsetTop: rowTops[id].top,
          offsetHeight: rowTops[id].height,
        },
        clientY,
        preventDefault: () => {},
        dataTransfer: { effectAllowed: "", dropEffect: "", setData: () => {} },
      }) as unknown as DragEvent;
  }

  it("reorders live when a drag crosses a neighbour's midpoint", () => {
    withStorage({});
    const g = new QueueColumnGroup("activity", "test", "Test", cols);
    // Rows a/b/c at 0/20/40, 20px tall: c's midpoint is 50.
    const rows = { a: { top: 0, height: 20 }, b: { top: 20, height: 20 }, c: { top: 40, height: 20 } };
    const drag = fakeDrag(0, rows);
    g.onDragStart(drag("a"), "a");
    expect(g.dragId).toBe("a");
    // Above c's midpoint: no swap yet (hysteresis).
    g.onDragOver(Object.assign(drag("c"), { clientY: 45 }) as DragEvent, "c");
    expect(g.order).toEqual(["a", "b", "c"]);
    // Past it: the dragged column moves below c.
    g.onDragOver(Object.assign(drag("c"), { clientY: 55 }) as DragEvent, "c");
    expect(g.order).toEqual(["b", "c", "a"]);
    g.onDrop(Object.assign(drag("c"), { clientY: 55 }) as DragEvent);
    expect(g.dragId).toBeNull();
    expect(JSON.parse(localStorage.getItem("activity-queue-test-column-order") ?? "[]")).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});
