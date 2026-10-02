<script lang="ts">
  import { buildPrefillTime, type PrefillSample } from "../lib/prefillTime";
  import { formatCompact } from "../lib/format";

  let {
    samples,
    colorClass = "text-blue-500 dark:text-blue-400",
  }: {
    samples: PrefillSample[];
    colorClass?: string;
  } = $props();

  const height = 290;
  const padding = { top: 30, right: 20, bottom: 72, left: 104 };
  const viewBoxWidth = 1200;
  const chartWidth = viewBoxWidth - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  let data = $derived(buildPrefillTime(samples));
  let barWidth = $derived(data.bins.length > 0 ? chartWidth / data.bins.length : chartWidth);

  /** Roughly the width one tick label needs in viewBox units. */
  const TICK_LABEL_PX = 78;

  /**
   * Bin edges to tick, thinned so labels never collide: every edge when they
   * fit, otherwise every 2nd, 3rd, ... The final edge is always included so
   * the axis states its upper bound.
   */
  let tickIndexes = $derived.by(() => {
    const count = data.bins.length;
    if (count === 0) return [];
    const stride = Math.max(1, Math.ceil(TICK_LABEL_PX / (chartWidth / count)));
    const out: number[] = [];
    for (let i = 0; i < count; i += stride) out.push(i);
    out.push(count);
    return out;
  });

  /** Share of total prefill time held by the tallest bin, as a percent. */
  let maxPercent = $derived(
    data.totalSeconds > 0 ? (data.maxSeconds / data.totalSeconds) * 100 : 0,
  );

  let selectedBin = $state<number | null>(null);

  function selectBin(i: number) {
    selectedBin = selectedBin === i ? null : i;
  }

  /** Speed axis bounds, taken from the bin edges the bars are drawn on. */
  let axisLo = $derived(data.bins.length > 0 ? data.bins[0].lo : 0);
  let axisHi = $derived(data.bins.length > 0 ? data.bins[data.bins.length - 1].hi : 0);

  /** X pixel for a speed, clamped into the plot so a marker never escapes. */
  function speedX(speed: number): number {
    const span = axisHi - axisLo;
    if (span <= 0) return padding.left;
    const ratio = Math.min(1, Math.max(0, (speed - axisLo) / span));
    return padding.left + ratio * chartWidth;
  }

  let markers = $derived([
    { label: "p50", speed: data.p50, className: "text-blue-700 dark:text-blue-300" },
    { label: "p10", speed: data.p10, className: "text-orange-500 dark:text-orange-400" },
    { label: "p1", speed: data.p1, className: "text-red-500 dark:text-red-400" },
  ]);

  /** Axis/readout label for a bin's speed range. */
  function rangeLabel(index: number): string {
    const bin = data.bins[index];
    if (!bin) return "";
    return `${formatCompact(bin.lo)}–${formatCompact(bin.hi)} tokens/sec`;
  }

  /**
   * Durations here span six orders of magnitude - a single short prefill is
   * milliseconds while the running total is hours - so this carries its own
   * formatter rather than formatDuration, which tops out at minutes and would
   * render a five-hour total as "293m 39.3s".
   */
  function secondsLabel(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0";
    if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  }
</script>

<div class="mt-2 w-full">
  {#if data.bins.length === 0}
    <div class="text-muted-foreground py-6 text-center text-sm">
      {data.untimed > 0
        ? `No prefill timings yet (${formatCompact(data.untimed)} requests without timing data)`
        : "No prefill timing data yet"}
    </div>
  {:else}
    <svg
      viewBox="0 0 {viewBoxWidth} {height}"
      class="w-full h-auto"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Total prefill seconds by prefill speed"
    >
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
        {@const tickPercent = maxPercent * fraction}
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
        <text
          x={padding.left - 10}
          y={tickY + 10}
          font-size="26"
          fill="currentColor"
          opacity="0.8"
          text-anchor="end"
        >
          {fraction === 0 ? "0" : `${tickPercent.toFixed(0)}%`}
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

      <!-- Bars: height is SUMMED prefill seconds, not request count -->
      {#each data.bins as bin, i}
        {@const barHeight = data.maxSeconds > 0 ? (bin.seconds / data.maxSeconds) * chartHeight : 0}
        {@const x = padding.left + i * barWidth}
        {@const y = height - padding.bottom - barHeight}
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
          <title
            >{`${rangeLabel(i)}\n${secondsLabel(bin.seconds)} total prefill (${(bin.share * 100).toFixed(1)}%)\n${bin.count} requests, ${secondsLabel(bin.meanSeconds)} each`}</title
          >
          <rect
            {x}
            y={padding.top}
            width={barWidth}
            height={chartHeight}
            fill="transparent"
            role="button"
            tabindex={0}
            aria-pressed={selectedBin === i}
            aria-label={`${rangeLabel(i)}, ${secondsLabel(bin.seconds)} total prefill, ${bin.count} requests`}
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

      <!-- Percentile markers, weighted by prefill time (see PrefillTimeData) -->
      {#each markers as marker (marker.label)}
        {#if marker.speed > 0}
          <line
            x1={speedX(marker.speed)}
            y1={padding.top}
            x2={speedX(marker.speed)}
            y2={height - padding.bottom}
            stroke="currentColor"
            stroke-width="2"
            stroke-dasharray="4 2"
            opacity="0.7"
            class={marker.className}
          />
        {/if}
      {/each}

      <!-- X-axis ticks: one per bin edge, thinned to whatever fits the width -->
      {#each tickIndexes as index}
        {@const last = index >= data.bins.length}
        {@const tickX = padding.left + (index / data.bins.length) * chartWidth}
        {@const edge = last ? data.bins[data.bins.length - 1].hi : data.bins[index].lo}
        {@const fraction = index / data.bins.length}
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
          {formatCompact(edge)}
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
        Prefill speed (tokens/sec)
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
        % of prefill time
      </text>
    </svg>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-sm text-muted-foreground">
      <span class="inline-flex items-center gap-1.5">
        <span class="w-5 border-t-2 border-dashed border-blue-700 dark:border-blue-300"></span>
        p50 ({formatCompact(data.p50)} tps)
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="w-5 border-t-2 border-dashed border-orange-500 dark:border-orange-400"></span>
        p10 ({formatCompact(data.p10)} tps)
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="w-5 border-t-2 border-dashed border-red-500 dark:border-red-400"></span>
        p1 ({formatCompact(data.p1)} tps)
      </span>
      <span title="Percentiles are weighted by prefill time, not request count">by time</span>
    </div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      {#if data.untimed > 0}
        <span title="Requests with no llama-server prompt_ms; excluded from the totals above">
          {formatCompact(data.untimed)} untimed
        </span>
      {/if}
      {#if selectedBin !== null && data.bins[selectedBin]}
        {@const bin = data.bins[selectedBin]}
        <span class="ml-auto">{rangeLabel(selectedBin)}</span>
        <span>
          {secondsLabel(bin.seconds)} ({(bin.share * 100).toFixed(1)}%) · {bin.count} req · {secondsLabel(
            bin.meanSeconds,
          )} each
        </span>
      {/if}
    </div>
  {/if}
</div>
