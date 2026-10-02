<script lang="ts">
  import { onMount } from "svelte";
  import {
    Chart,
    ScatterController,
    PointElement,
    LinearScale,
    LogarithmicScale,
    Title,
    Tooltip,
  } from "chart.js";
  import type { TooltipItem } from "chart.js";
  import type { PromptScatterPoint } from "../lib/types";
  import { isDarkMode } from "../stores/theme";
  import * as Card from "$lib/components/ui/card/index.js";
  import { formatCompact } from "../lib/format";
  import {
    axisFill,
    buildHeatGrid,
    gridSize,
    heatmapPlugin,
    setHeatmapState,
    type HeatCell,
    type HeatGrid,
  } from "../lib/heatmap";
  import {
    densityThresholds,
    densityColor,
    densityRamp,
    latestSession,
    shortSession,
    LATEST_DARK,
    LATEST_LIGHT,
  } from "../lib/scatterColor";

  Chart.register(
    ScatterController,
    PointElement,
    LinearScale,
    LogarithmicScale,
    Title,
    Tooltip,
    heatmapPlugin,
  );

  interface Props {
    points: PromptScatterPoint[];
    /**
     * Accepted for parity with the decode chart's toggle, but prefill requests
     * carry no draft acceptance, so this chart is always density-colored.
     */
    colorMode: "session" | "accept";
  }

  let { points }: Props = $props();

  let canvas: HTMLCanvasElement;
  let chart: Chart<"scatter">;

  let latest = $derived(latestSession(points.map((p) => p.session ?? "")));
  let overlay = $derived(latest === "" ? [] : points.filter((p) => (p.session ?? "") === latest));
  let grid = $derived(
    buildHeatGrid(
      points.map((p) => ({ x: p.length, y: p.speed })),
      {
        xScale: "logarithmic",
        ...gridSize(points.length, axisFill(points.map((p) => p.speed))),
      },
    ),
  );

  function getChartColors(dark: boolean) {
    return {
      grid: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
      tick: dark ? "#9ca3af" : "#6b7280",
      legend: dark ? "#d1d5db" : "#374151",
      tooltipBg: dark ? "#1f2937" : "#ffffff",
      tooltipText: dark ? "#f3f4f6" : "#111827",
      tooltipBorder: dark ? "#374151" : "#e5e7eb",
      latest: dark ? LATEST_DARK : LATEST_LIGHT,
    };
  }

  // Ramp steps are assigned by rank, so each shade carries a comparable slice
  // of the cells whatever the distribution looks like. See densityThresholds.
  let thresholds = $derived(densityThresholds(grid.cells.map((c) => c.count)));

  function cellColorFor(bounds: number[], dark: boolean) {
    return (cell: HeatCell) => densityColor(cell.count, bounds, dark);
  }

  function cellOf(item: TooltipItem<"scatter">): HeatCell | undefined {
    const dataset = item.dataset as unknown as { cells?: HeatCell[] };
    return dataset.cells?.[item.dataIndex];
  }

  function overlayPointOf(item: TooltipItem<"scatter">): PromptScatterPoint | undefined {
    const dataset = item.dataset as unknown as { sourcePoints?: PromptScatterPoint[] };
    return dataset.sourcePoints?.[item.dataIndex];
  }

  function buildOptions(dark: boolean) {
    const colors = getChartColors(dark);
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      interaction: {
        // See DecodeScatter: a regular grid of cell centers makes "nearest
        // without intersect" resolve to the containing cell.
        mode: "nearest" as const,
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "Prefill Speed vs Prompt Length",
          color: colors.legend,
          font: { size: 14, weight: "bold" as const },
        },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.tooltipText,
          bodyColor: colors.tooltipText,
          borderColor: colors.tooltipBorder,
          borderWidth: 1,
          displayColors: false,
          callbacks: {
            title: (items: TooltipItem<"scatter">[]) => {
              const item = items[0];
              if (!item) return "";
              const point = overlayPointOf(item);
              if (point) return `${formatCompact(point.length)} prompt tokens`;
              const cell = cellOf(item);
              if (!cell) return "";
              return `${formatCompact(cell.x0)}–${formatCompact(cell.x1)} prompt tokens`;
            },
            label: (item: TooltipItem<"scatter">) => {
              const point = overlayPointOf(item);
              if (point) {
                return [
                  `${point.speed.toFixed(1)} tokens/sec`,
                  `latest session ${shortSession(point.session ?? "")}`,
                ];
              }
              const cell = cellOf(item);
              if (!cell) return "";
              return [
                `${cell.y0.toFixed(1)}–${cell.y1.toFixed(1)} tokens/sec`,
                `${formatCompact(cell.count)} request${cell.count === 1 ? "" : "s"}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          type: "logarithmic" as const,
          ticks: {
            color: colors.tick,
            minRotation: 90,
            maxRotation: 90,
            autoSkip: true,
            maxTicksLimit: 12,
            font: { size: 10 },
            callback: (value: string | number) => formatCompact(Number(value)),
          },
          grid: { color: colors.grid },
          title: { display: true, text: "Prompt length (tokens, log)", color: colors.tick },
        },
        y: {
          beginAtZero: true,
          ticks: { color: colors.tick, font: { size: 10 } },
          grid: { color: colors.grid },
          title: { display: true, text: "Prefill speed (tokens/sec)", color: colors.tick },
        },
      },
    };
  }

  function buildData(dark: boolean, heat: HeatGrid) {
    const colors = getChartColors(dark);
    const datasets: unknown[] = [
      {
        // Invisible hit-test layer; heatmapPlugin paints the cells themselves.
        label: "Requests",
        data: heat.cells.map((cell) => ({ x: cell.cx, y: cell.cy })),
        cells: heat.cells,
        pointRadius: 0,
        pointHoverRadius: 0,
        backgroundColor: "transparent",
        borderColor: "transparent",
      },
    ];
    if (overlay.length > 0) {
      datasets.push({
        label: `latest session ${shortSession(latest)}`,
        data: overlay.map((p) => ({ x: p.length, y: p.speed })),
        sourcePoints: overlay,
        backgroundColor: colors.latest,
        borderWidth: 0,
        pointRadius: 2.5,
        pointHoverRadius: 5,
      });
    }
    return { datasets };
  }

  function sync(dark: boolean, heat: HeatGrid, bounds: number[]) {
    if (!chart) return;
    setHeatmapState(chart, { grid: heat, colorFor: cellColorFor(bounds, dark) });
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
    setHeatmapState(chart, { grid, colorFor: cellColorFor(thresholds, $isDarkMode) });
    chart.update("none");

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
        <span
          class="text-muted-foreground text-xs"
          title={`shade steps top out at: ${thresholds.join(", ")} requests`}
        >
          {formatCompact(grid.maxCount)} req/cell
        </span>
      </span>
      {#if overlay.length > 0}
        <span class="flex items-center gap-1">
          <span
            class="inline-block size-2 rounded-full"
            style="background: {getChartColors($isDarkMode).latest}"
          ></span>
          <span class="text-muted-foreground text-xs">latest session {shortSession(latest)}</span>
        </span>
      {/if}
    </div>
  </Card.Content>
</Card.Root>
