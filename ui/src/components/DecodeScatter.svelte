<script lang="ts">
  import { onMount } from "svelte";
  import { Chart, ScatterController, PointElement, LinearScale, Title, Tooltip } from "chart.js";
  import type { TooltipItem } from "chart.js";
  import type { GenScatterPoint } from "../lib/types";
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
    acceptColor,
    densityAlpha,
    densityThresholds,
    densityColor,
    densityRamp,
    latestSession,
    shortSession,
    withAlpha,
    ACCEPT_RAMP_DARK,
    ACCEPT_RAMP_LIGHT,
    LATEST_DARK,
    LATEST_LIGHT,
    OTHER_DARK,
    OTHER_LIGHT,
  } from "../lib/scatterColor";

  Chart.register(ScatterController, PointElement, LinearScale, Title, Tooltip, heatmapPlugin);

  interface Props {
    points: GenScatterPoint[];
    colorMode: "session" | "accept";
  }

  let { points, colorMode }: Props = $props();

  let canvas: HTMLCanvasElement;
  let chart: Chart<"scatter">;

  const BUCKET_LABELS = ["<0.5", "0.5–0.6", "0.6–0.7", "0.7–0.8", ">=0.8"];

  let latest = $derived(latestSession(points.map((p) => p.session ?? "")));
  let overlay = $derived(latest === "" ? [] : points.filter((p) => (p.session ?? "") === latest));
  let grid = $derived(
    buildHeatGrid(
      points.map((p) => ({ x: p.context, y: p.speed, accept: p.accept })),
      { xScale: "linear", ...gridSize(points.length, axisFill(points.map((p) => p.speed))) },
    ),
  );

  function acceptSwatches(dark: boolean) {
    const ramp = dark ? ACCEPT_RAMP_DARK : ACCEPT_RAMP_LIGHT;
    return [
      ...BUCKET_LABELS.map((label, i) => ({ label, color: ramp[i] })),
      { label: "no draft data", color: dark ? OTHER_DARK : OTHER_LIGHT },
    ];
  }

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

  /**
   * Cell fill. In density mode the count drives the blue ramp directly; in
   * acceptance mode the hue carries mean acceptance and the count moves to
   * the alpha channel, so both encodings survive in one layer.
   */
  // Ramp steps are assigned by rank, so each shade carries a comparable slice
  // of the cells whatever the distribution looks like. See densityThresholds.
  let thresholds = $derived(densityThresholds(grid.cells.map((c) => c.count)));

  function cellColorFor(bounds: number[], dark: boolean, mode: "session" | "accept") {
    return (cell: HeatCell) => {
      if (mode !== "accept") return densityColor(cell.count, bounds, dark);
      return withAlpha(acceptColor(cell.accept, dark), densityAlpha(cell.count, bounds));
    };
  }

  function cellOf(item: TooltipItem<"scatter">): HeatCell | undefined {
    const dataset = item.dataset as unknown as { cells?: HeatCell[] };
    return dataset.cells?.[item.dataIndex];
  }

  function overlayPointOf(item: TooltipItem<"scatter">): GenScatterPoint | undefined {
    const dataset = item.dataset as unknown as { sourcePoints?: GenScatterPoint[] };
    return dataset.sourcePoints?.[item.dataIndex];
  }

  function buildOptions(dark: boolean) {
    const colors = getChartColors(dark);
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false as const,
      interaction: {
        // Cell centers sit on a regular grid, so "nearest without intersect"
        // resolves to the cell the cursor is actually inside, and an overlay
        // dot wins whenever the cursor is closer to it than to a center.
        mode: "nearest" as const,
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: "Decode Speed vs Context Length",
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
              if (point) return `${formatCompact(point.context)} context tokens`;
              const cell = cellOf(item);
              if (!cell) return "";
              return `${formatCompact(cell.x0)}–${formatCompact(cell.x1)} context tokens`;
            },
            label: (item: TooltipItem<"scatter">) => {
              const point = overlayPointOf(item);
              if (point) {
                const lines = [`${point.speed.toFixed(1)} tokens/sec`];
                lines.push(
                  point.accept < 0
                    ? "no draft data"
                    : `acceptance ${(point.accept * 100).toFixed(0)}%`,
                );
                lines.push(`${formatCompact(point.output)} output tokens`);
                lines.push(`latest session ${shortSession(point.session ?? "")}`);
                return lines;
              }
              const cell = cellOf(item);
              if (!cell) return "";
              const lines = [`${cell.y0.toFixed(1)}–${cell.y1.toFixed(1)} tokens/sec`];
              lines.push(`${formatCompact(cell.count)} request${cell.count === 1 ? "" : "s"}`);
              if (cell.accept >= 0) {
                lines.push(`mean acceptance ${(cell.accept * 100).toFixed(0)}%`);
              }
              return lines;
            },
          },
        },
      },
      scales: {
        x: {
          // Linear, not logarithmic: decode context clusters hard at the top of
          // the range (92% of requests land in 30k-125k), which a log axis
          // squeezes into ~15% of the width and a linear axis gives ~76% to.
          // The prefill chart is the opposite case and keeps its log axis.
          type: "linear" as const,
          beginAtZero: true,
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
          title: { display: true, text: "Context (tokens)", color: colors.tick },
        },
        y: {
          beginAtZero: true,
          ticks: { color: colors.tick, font: { size: 10 } },
          grid: { color: colors.grid },
          title: { display: true, text: "Decode speed (tokens/sec)", color: colors.tick },
        },
      },
    };
  }

  function buildData(dark: boolean, heat: HeatGrid) {
    const colors = getChartColors(dark);
    const datasets: unknown[] = [
      {
        // Invisible: the grid itself is painted by heatmapPlugin. These points
        // exist so each cell has something for Chart.js to hit-test and
        // tooltip against.
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
        data: overlay.map((p) => ({ x: p.context, y: p.speed })),
        sourcePoints: overlay,
        backgroundColor: colors.latest,
        borderWidth: 0,
        pointRadius: 2.5,
        pointHoverRadius: 5,
      });
    }
    return { datasets };
  }

  function sync(dark: boolean, mode: "session" | "accept", heat: HeatGrid, bounds: number[]) {
    if (!chart) return;
    setHeatmapState(chart, { grid: heat, colorFor: cellColorFor(bounds, dark, mode) });
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
    setHeatmapState(chart, {
      grid,
      colorFor: cellColorFor(thresholds, $isDarkMode, colorMode),
    });
    chart.update("none");

    return () => {
      chart.destroy();
    };
  });

  $effect(() => {
    sync($isDarkMode, colorMode, grid, thresholds);
  });
</script>

<Card.Root class="h-[300px] py-0">
  <Card.Content class="flex h-full flex-col p-4">
    <div class="min-h-0 flex-1">
      <canvas bind:this={canvas}></canvas>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      {#if colorMode === "accept"}
        {#each acceptSwatches($isDarkMode) as swatch (swatch.label)}
          <span class="flex items-center gap-1">
            <span class="inline-block size-2 rounded-sm" style="background: {swatch.color}"></span>
            <span class="text-muted-foreground text-xs">{swatch.label}</span>
          </span>
        {/each}
        <span class="text-muted-foreground text-xs">(shade: cell density)</span>
      {:else}
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
      {/if}
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
