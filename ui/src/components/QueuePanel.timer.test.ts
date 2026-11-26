// @vitest-environment happy-dom
//
// Regression test for the stuttering / backwards-running Age and Waited
// timers. The displayed age re-baselines to the engine's age_s on every
// snapshot, and that stamp lags the browser's processing of the event — so a
// snapshot arriving after the row's own tick has counted further must not
// pull the number backwards. The ratchet holds it; the rAF clock keeps the
// tick continuous. Driven with fake timers: performance.now() and rAF are
// sinon-faked, so the clock is deterministic.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QueuePanelHarness from "./QueuePanel.harness.svelte";
import { inflightRequestEntries, queueSnapshots } from "../stores/api";
import type { QueueRequest, QueueSnapshot } from "../lib/types";

function snap(ageS: number, receivedAt: number): QueueSnapshot {
  const r: QueueRequest = {
    id: 1, state: "decode", prompt: 0, computed: 0, cached: 0, output: 0, max: 32768,
    kv_tokens: 0, age_s: ageS, tps: 0, priority: 0,
  };
  return {
    model: "rad", at_ms: 0, kv_tokens_total: 200_000, kv_tokens_used: 0, kv_tokens_cached: 0,
    running: 1, waiting: 0, decode_tps: 0, prefill_tps: 0, preemptions: 0,
    queue: { kv_reserve: 16384, backfill_ms: 60000, aging_s: 30 },
    client_received_at_ms: receivedAt,
    requests: [r],
  };
}

describe("queue timer ratchet", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout",
        "requestAnimationFrame", "cancelAnimationFrame", "performance",
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    window.localStorage.clear();
    queueSnapshots.set([]);
    inflightRequestEntries.set([]);
  });

  // The Age cell, located by its header's position in the running table's
  // own column set — not "first bare Xs td", so a future column emitting a
  // bare duration earlier in a row cannot silently retarget this.
  function ageVal(): number {
    for (const hr of document.querySelectorAll("tr")) {
      const ths = [...hr.children] as HTMLElement[];
      const i = ths.findIndex((th) => th.textContent?.trim() === "Age");
      if (i < 0 || !ths.length) continue;
      const tbody = hr.closest("table")?.querySelector("tbody");
      if (!tbody) continue;
      for (const row of [...tbody.children]) {
        const td = row.children[i] as HTMLElement | undefined;
        const t = td ? (td.textContent || "").trim() : "";
        if (/^\d+(\.\d+)?s$/.test(t)) return parseFloat(t);
      }
    }
    return NaN;
  }

  it("ticks forward, never drops on a stale snapshot, and follows a new one", async () => {
    const t0 = performance.now();
    const panel = mount(QueuePanelHarness, {
      target: document.body,
      props: { inflightRequests: [] },
    });
    flushSync();

    queueSnapshots.set([snap(0, t0)]);
    await vi.advanceTimersByTimeAsync(3000); // the rAF clock counts the row up
    expect(ageVal()).toBeGreaterThanOrEqual(2.9);
    expect(ageVal()).toBeLessThanOrEqual(3.1);

    // A snapshot stamped before the display has already counted (its event
    // processed late, then the next one processed on time) must not pull the
    // timer backwards.
    queueSnapshots.set([snap(2.5, performance.now())]);
    flushSync();
    expect(ageVal()).toBeGreaterThanOrEqual(2.9);

    // A genuinely newer snapshot still advances the row.
    queueSnapshots.set([snap(5, performance.now())]);
    flushSync();
    expect(ageVal()).toBeGreaterThanOrEqual(5.0);

    unmount(panel);
  });
});
