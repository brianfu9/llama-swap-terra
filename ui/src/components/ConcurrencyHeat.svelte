<script lang="ts">
  import { onMount } from "svelte";
  import { Chart, ScatterController, PointElement, LineElement, LinearScale, Title, Tooltip } from "chart.js";
  import type { TooltipItem } from "chart.js";
  import type { ConcurrencyData, ConcurrencyLevel } from "../lib/concurrency";
  import { isDarkMode } from "../stores/theme";
  import * as Card from "$lib/components/ui/card/index.js";
  import { formatCompact } from "../lib/format";
  import { heatmapPlugin, setHeatmapState, type HeatCell, type HeatGrid } from "../lib/heatmap";
  import { densityColor, densityRamp, densityThresholds } from "../lib/scatterColor";

  Chart.register(ScatterController, PointElement, LineElement, LinearScale, Title, Tooltip, heatmapPlugin);

  // Decode speed against concurrency. Columns are k, the number of decodes
  // running at once; cells are per-request decode speed density, each request
  // placed at its time-weighted mean k. Per-stream speed falls as k rises; the
  // solid line is what the whole system produced at that k, the dashed line
  // is perfect linear scaling from the solo rate. The gap between them is what
  // batching costs; a flat solid line means more agents gain nothing.

  let { data }: { data: ConcurrencyData } = $props();

  let canvas: HTMLCanvasElement;
  let chart: Chart<"scatter">;

  const Y_BINS = 16;
  /** Half the column width, in k units. */
  const HALF = 0.42;

  /** Column-aligned grid: one column per whole k, y binned over speed. */
  let grid = $derived.by((): HeatGrid => {
    const pts = data.points;
    if (pts.length === 0) return { cells: [], maxCount: 0 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.speed < lo) lo = p.speed;
      if (p.speed > hi) hi = p.speed;
    }
    const step = (hi - lo) / Y_BINS;
    const counts = new Map<string, { k: number; iy: number; count: number }>();
    for (const p of pts) {
      const iy = step > 0 ? Math.min(Y_BINS - 1, Math.floor((p.speed - lo) / step)) : 0;
      const key = `${p.k}:${iy}`;
      const c = counts.get(key) ?? { k: p.k, iy, count: 0 };
      c.count++;
      counts.set(key, c);
    }
    const cells: HeatCell[] = [];
    let maxCount = 0;
    for (const { k, iy, count } of counts.values()) {
      const y0 = lo + iy * step;
      const y1 = step > 0 ? y0 + step : y0;
      cells.push({ x0: k - HALF, x1: k + HALF, y0, y1, cx: k, cy: (y0 + y1) / 2, count, accept: -1 });
      if (count > maxCount) maxCount = count;
    }
    cells.sort((a, b) => a.count - b.count);
    return { cells, maxCount };
  });

  let thresholds = $derived(densityThresholds(grid.cells.map((c) => c.count)));

  /** A request's rounded mean k never exceeds the highest level seen. */
  let xMax = $derived(Math.max(1, data.maxK));

  /**
   * Y range covers the cells and the measured system line. The ideal line is
   * left to clip: k x solo grows without bound and would squash the data.
   */
  let yMax = $derived.by(() => {
    let top = 0;
    for (const p of data.points) top = Math.max(top, p.speed);
    for (const l of data.levels) top = Math.max(top, l.systemTps);
    return top > 0 ? Math.ceil((top * 1.12) / 20) * 20 : 20;
  });

  function getChartColors(dark: boolean) {
    return {
      grid: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
      tick: dark ? "#9ca3af" : "#6b7280",
      tooltipBg: dark ? "#1f2937" : "#ffffff",
      tooltipText: dark ? "#f3f4f6" : "#111827",
      tooltipBorder: dark ? "#374151" : "#e5e7eb",
      system: dark ? "#4ade80" : "#16a34a",
      ideal: dark ? "#9ca3af" : "#6b7280",
    };
  }

  function levelOf(item: TooltipItem<"scatter">): ConcurrencyLevel | undefined {
    const dataset = item.dataset as unknown as { levels?: ConcurrencyLevel[] };
    return dataset.levels?.[item.dataIndex];
  }

  function cellOf(item: TooltipItem<"scatter">): HeatCell | undefined {
    const dataset = item.dataset as unknown as { cells?: HeatCell[] };
    return dataset.cells?.[item.dataIndex];
  }

  function busyLabel(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
    return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  }

  function buildOptions(dark: boolean) {
    const colors = getChartColors(dark);
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      interaction: { mode: "nearest" as const, intersect: false },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "Decode Speed vs Concurrency",
          color: colors.tick,
        },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.tooltipText,
          bodyColor: colors.tooltipText,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
          callbacks: {
            title: (items: TooltipItem<"scatter">[]) => {
              const level = items[0] && levelOf(items[0]);
              if (level) return `${level.k} decoding at once`;
              const cell = items[0] && cellOf(items[0]);
              return cell ? `k ≈ ${cell.cx}` : "";
            },
            label: (item: TooltipItem<"scatter">) => {
              const level = levelOf(item);
              if (level) {
                const lines = [`system: ${formatCompact(level.systemTps)} tok/s`];
                if (level.speedup > 0) lines.push(`speedup vs solo: ${level.speedup.toFixed(2)}×`);
                if (level.perStreamMedian > 0)
                  lines.push(`per-stream median: ${formatCompact(level.perStreamMedian)} tok/s`);
                lines.push(
                  `busy: ${busyLabel(level.busyMs)} (${(level.share * 100).toFixed(1)}%) · ${level.requests} req`,
                );
                return lines;
              }
              const cell = cellOf(item);
              if (cell) {
                return `${formatCompact(cell.y0)}–${formatCompact(cell.y1)} tok/s per stream: ${cell.count} req`;
              }
              return "";
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear" as const,
          min: 0.5,
          max: xMax + 0.5,
          title: { display: true, text: "Decodes running at once (k)", color: colors.tick },
          // The axis runs half a column past each end, so generated ticks
          // would land on the .5 edges; pin them to the whole-k centers.
          afterBuildTicks: (axis: { ticks: { value: number }[] }) => {
            axis.ticks = Array.from({ length: xMax }, (_, i) => ({ value: i + 1 }));
          },
          ticks: { color: colors.tick },
          grid: { color: colors.grid },
        },
        y: {
          type: "linear" as const,
          min: 0,
          max: yMax,
          title: { display: true, text: "Decode speed (tokens/sec)", color: colors.tick },
          ticks: { color: colors.tick, callback: (v: number | string) => formatCompact(Number(v)) },
          grid: { color: colors.grid },
        },
      },
    };
  }

  function buildData(dark: boolean, heat: HeatGrid) {
    const colors = getChartColors(dark);
    const levels = data.levels;
    const datasets: unknown[] = [
      {
        // Invisible hit targets for the cells heatmapPlugin paints.
        label: "Requests",
        data: heat.cells.map((cell) => ({ x: cell.cx, y: cell.cy })),
        cells: heat.cells,
        pointRadius: 0,
        pointHoverRadius: 0,
        backgroundColor: "transparent",
        borderColor: "transparent",
      },
    ];
    if (data.soloTps > 0) {
      datasets.push({
        label: "ideal",
        data: levels.map((l) => ({ x: l.k, y: l.idealTps })),
        levels,
        showLine: true,
        borderColor: colors.ideal,
        borderDash: [6, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
      });
    }
    datasets.push({
      label: "system",
      data: levels.map((l) => ({ x: l.k, y: l.systemTps })),
      levels,
      showLine: true,
      borderColor: colors.system,
      backgroundColor: colors.system,
      borderWidth: 2.5,
      pointRadius: 3.5,
      pointHoverRadius: 6,
    });
    return { datasets };
  }

  function sync(dark: boolean, heat: HeatGrid, bounds: number[]) {
    if (!chart) return;
    setHeatmapState(chart, { grid: heat, colorFor: (cell) => densityColor(cell.count, bounds, dark) });
    chart.options = buildOptions(dark) as typeof chart.options;
    chart.data = buildData(dark, heat) as typeof chart.data;
    chart.update("none");
  }

  onMount(() => {
    chart = new Chart(canvas, {
      type: "scatter",
      data: buildData($isDarkMode, grid) as never,
      options: buildOptions($isDarkMode) as never,
    });
    sync($isDarkMode, grid, thresholds);
    return () => {
      chart.destroy();
    };
  });

  $effect(() => {
    sync($isDarkMode, grid, thresholds);
  });
</script>

<Card.Root class="h-[300px] py-0">
  <Card.Content class="flex h-full flex-col p-4">
    <div class="min-h-0 flex-1">
      <canvas bind:this={canvas}></canvas>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span class="flex items-center gap-1">
        <span class="text-muted-foreground text-xs">1</span>
        {#each densityRamp($isDarkMode) as step (step)}
          <span class="inline-block size-2" style="background: {step}"></span>
        {/each}
        <span class="text-muted-foreground text-xs" title={`shade steps top out at: ${thresholds.join(", ")} requests`}>
          {formatCompact(grid.maxCount)} req/cell (per stream)
        </span>
      </span>
      <span class="flex items-center gap-1">
        <span class="inline-block w-4 border-t-[3px]" style="border-color: {getChartColors($isDarkMode).system}"></span>
        <span class="text-muted-foreground text-xs">system</span>
      </span>
      {#if data.soloTps > 0}
        <span class="flex items-center gap-1">
          <span class="inline-block w-4 border-t-2 border-dashed" style="border-color: {getChartColors($isDarkMode).ideal}"></span>
          <span class="text-muted-foreground text-xs">ideal (k × solo)</span>
        </span>
      {/if}
    </div>
  </Card.Content>
</Card.Root>
