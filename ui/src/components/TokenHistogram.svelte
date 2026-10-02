<script lang="ts">
  import type { HistogramData } from "../lib/types";
  import { formatCompact } from "../lib/format";

  let {
    data,
    unit = "tokens/sec",
    xLabel = "Speed (tokens/sec)",
    yLabel = "Requests",
    colorClass = "text-blue-500 dark:text-blue-400",
  }: {
    data: HistogramData;
    unit?: string;
    xLabel?: string;
    yLabel?: string;
    colorClass?: string;
  } = $props();

  const height = 290;
  const padding = { top: 30, right: 20, bottom: 72, left: 104 };
  const viewBoxWidth = 1200;
  const chartWidth = viewBoxWidth - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  let maxCount = $derived(Math.max(...data.bins));
  let barWidth = $derived(chartWidth / data.bins.length);
  let range = $derived(data.max - data.min);

  /** Roughly the width one tick label needs in viewBox units. */
  const TICK_LABEL_PX = 78;

  /**
   * Bin edges to tick, thinned so labels never collide. Five fixed fractions
   * left most buckets anonymous; this labels every edge that fits.
   */
  let tickIndexes = $derived.by(() => {
    const count = data.bins.length;
    if (count === 0 || range === 0) return [0];
    const stride = Math.max(1, Math.ceil(TICK_LABEL_PX / (chartWidth / count)));
    const out: number[] = [];
    for (let i = 0; i < count; i += stride) out.push(i);
    out.push(count);
    return out;
  });

  let selectedBin = $state<number | null>(null);

  function selectBin(i: number) {
    selectedBin = selectedBin === i ? null : i;
  }

  function getXPosition(value: number): number {
    return padding.left + ((value - data.min) / range) * chartWidth;
  }
</script>

<div class="mt-2 w-full">
  <svg viewBox="0 0 {viewBoxWidth} {height}" class="w-full h-auto" preserveAspectRatio="xMidYMid meet">
    <!-- Y-axis -->
    <line
      x1={padding.left}
      y1={padding.top}
      x2={padding.left}
      y2={height - padding.bottom}
      stroke="currentColor"
      stroke-width="1"
      opacity="0.3"
    />

    <!-- Y-axis ticks and labels -->
    {#each [0, 0.5, 1] as fraction}
      {@const tickCount = Math.round(maxCount * fraction)}
      {@const tickY = height - padding.bottom - fraction * chartHeight}
      <line
        x1={padding.left - 8}
        y1={tickY}
        x2={padding.left}
        y2={tickY}
        stroke="currentColor"
        stroke-width="1"
        opacity="0.4"
      />
      <text x={padding.left - 10} y={tickY + 10} font-size="26" fill="currentColor" opacity="0.8" text-anchor="end">
        {formatCompact(tickCount)}
      </text>
    {/each}

    <!-- X-axis -->
    <line
      x1={padding.left}
      y1={height - padding.bottom}
      x2={viewBoxWidth - padding.right}
      y2={height - padding.bottom}
      stroke="currentColor"
      stroke-width="1"
      opacity="0.3"
    />

    <!-- Histogram bars -->
    {#each data.bins as count, i}
      {@const barHeight = maxCount > 0 ? (count / maxCount) * chartHeight : 0}
      {@const x = padding.left + i * barWidth}
      {@const y = height - padding.bottom - barHeight}
      {@const binStart = data.min + i * data.binSize}
      {@const binEnd = binStart + data.binSize}
      <g class="group">
        <rect
          {x}
          {y}
          width={Math.max(barWidth - 1, 1)}
          height={barHeight}
          fill="currentColor"
          class="{colorClass} {selectedBin === i
            ? 'opacity-100'
            : 'opacity-60 group-hover:opacity-90'} transition-opacity cursor-pointer"
        />
        <title>{`${binStart.toFixed(1)} - ${binEnd.toFixed(1)} ${unit}\nCount: ${count}`}</title>
        <rect
          {x}
          y={padding.top}
          width={barWidth}
          height={chartHeight}
          fill="transparent"
          role="button"
          tabindex={0}
          aria-pressed={selectedBin === i}
          aria-label={`${binStart.toFixed(1)} to ${binEnd.toFixed(1)} ${unit}, count ${count}`}
          class="cursor-pointer"
          onclick={() => selectBin(i)}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectBin(i);
            }
          }}
        />
      </g>
    {/each}

    <!-- Percentile lines -->
    <line
      x1={getXPosition(data.p50)}
      y1={padding.top}
      x2={getXPosition(data.p50)}
      y2={height - padding.bottom}
      stroke="currentColor"
      stroke-width="2"
      stroke-dasharray="4 2"
      opacity="0.7"
      class="text-blue-700 dark:text-blue-300"
    />

    <line
      x1={getXPosition(data.p10)}
      y1={padding.top}
      x2={getXPosition(data.p10)}
      y2={height - padding.bottom}
      stroke="currentColor"
      stroke-width="2"
      stroke-dasharray="4 2"
      opacity="0.7"
      class="text-orange-500 dark:text-orange-400"
    />

    <line
      x1={getXPosition(data.p1)}
      y1={padding.top}
      x2={getXPosition(data.p1)}
      y2={height - padding.bottom}
      stroke="currentColor"
      stroke-width="2"
      stroke-dasharray="4 2"
      opacity="0.7"
      class="text-red-500 dark:text-red-400"
    />

    <!-- X-axis ticks: one per bin edge, thinned to whatever fits the width -->
    {#each tickIndexes as index}
      {@const fraction = data.bins.length > 0 ? index / data.bins.length : 0}
      {@const tickX = padding.left + fraction * chartWidth}
      <line
        x1={tickX}
        y1={height - padding.bottom}
        x2={tickX}
        y2={height - padding.bottom + 8}
        stroke="currentColor"
        stroke-width="1"
        opacity="0.4"
      />
      <text
        x={tickX}
        y={height - padding.bottom + 30}
        font-size="26"
        fill="currentColor"
        opacity="0.8"
        text-anchor={fraction === 0 ? "start" : fraction >= 1 ? "end" : "middle"}
      >
        {(data.min + fraction * range).toFixed(0)}
      </text>
    {/each}
    <!-- Axis titles -->
    <text
      x={padding.left + chartWidth / 2}
      y={height - 8}
      font-size="26"
      fill="currentColor"
      opacity="0.7"
      text-anchor="middle"
    >
      {xLabel}
    </text>
    <text
      x={22}
      y={padding.top + chartHeight / 2}
      transform="rotate(-90, 22, {padding.top + chartHeight / 2})"
      font-size="26"
      fill="currentColor"
      opacity="0.7"
      text-anchor="middle"
    >
      {yLabel}
    </text>
  </svg>

  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm text-muted-foreground">
    <span class="inline-flex items-center gap-1.5">
      <span class="w-5 border-t-2 border-dashed border-blue-700 dark:border-blue-300"></span>
      p50 ({data.p50.toFixed(1)} tps)
    </span>
    <span class="inline-flex items-center gap-1.5">
      <span class="w-5 border-t-2 border-dashed border-orange-500 dark:border-orange-400"></span>
      p10 ({data.p10.toFixed(1)} tps)
    </span>
    <span class="inline-flex items-center gap-1.5">
      <span class="w-5 border-t-2 border-dashed border-red-500 dark:border-red-400"></span>
      p1 ({data.p1.toFixed(1)} tps)
    </span>
    {#if selectedBin !== null}
      {@const selStart = data.min + selectedBin * data.binSize}
      <span class="ml-auto">{`${selStart.toFixed(1)} - ${(selStart + data.binSize).toFixed(1)} ${unit}`}</span>
      <span title={String(data.bins[selectedBin])}>
        Count: {formatCompact(data.bins[selectedBin])}
      </span>
    {/if}
  </div>
</div>
