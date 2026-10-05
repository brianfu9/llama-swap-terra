<script lang="ts">
  import type { ActivityStatsData } from "../lib/types";
  import { formatCompact } from "../lib/format";
  import { persistentStore } from "../stores/persistent";
  import TokenHistogram from "./TokenHistogram.svelte";
  import PrefillTimeHistogram from "./PrefillTimeHistogram.svelte";
  import PromptPrefillScatter from "./PromptPrefillScatter.svelte";
  import DecodeScatter from "./DecodeScatter.svelte";
  import ConcurrencyHeat from "./ConcurrencyHeat.svelte";
  import { buildConcurrency } from "../lib/concurrency";
  import { buildHistogram } from "../lib/histogram";
  import { ChevronDown, X } from "@lucide/svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Select from "$lib/components/ui/select/index.js";

  interface Props {
    stats: ActivityStatsData | null;
    /** Model the stats describe; "" means all models. */
    statsModel: string;
    onStatsModelChange: (model: string) => void;
  }

  let { stats, statsModel, onStatsModelChange }: Props = $props();

  // bits-ui Select needs a non-empty value for the "all" option.
  const ALL_MODELS = "__all__";
  // Keep a stored selection visible even if that model has no rows (pruned or
  // renamed), so the control never shows a value missing from its own list.
  const modelOptions = $derived.by(() => {
    const list = stats?.models ?? [];
    if (statsModel && !list.some((m) => m.id === statsModel)) {
      return [...list, { id: statsModel, requests: 0 }];
    }
    return list;
  });

  const nf = new Intl.NumberFormat();
  const histogramCollapsed = persistentStore<boolean>("activity-histogram-collapsed", false);

  // Per-stream decode speed drops when agents run in parallel; these measure
  // what the system as a whole produced. See lib/concurrency.ts.
  const concurrency = $derived(
    buildConcurrency(
      (stats?.gen_scatter ?? []).map((p) => ({
        endMs: p.end_ms,
        decodeMs: p.decode_ms,
        output: p.output,
        speed: p.speed,
      })),
    ),
  );

  // Which speed the Token Generation heat map and histogram plot. "system"
  // replaces each request's reported speed with the system rate over its own
  // decode, so overlapping agents no longer read as a slowdown; solo requests
  // are unchanged. Requests with no decode timing keep their reported speed.
  const decodeSpeedMode = persistentStore<"system" | "stream">("activity-decode-speed", "system");
  const genPoints = $derived.by(() => {
    const points = stats?.gen_scatter ?? [];
    if ($decodeSpeedMode !== "system") return points;
    return points.map((p, i) => {
      const system = concurrency.systemSpeeds[i];
      return Number.isFinite(system) ? { ...p, speed: system, stream_speed: p.speed } : p;
    });
  });
  // The server's gen_histogram bins reported speeds, so the system view bins
  // in the browser. It covers the scatter's rows (those with a context), which
  // can be a few fewer than the server histogram's.
  const genHistogram = $derived(
    $decodeSpeedMode === "system" ? buildHistogram(genPoints.map((p) => p.speed)) : (stats?.gen_histogram ?? null),
  );
</script>

<Card.Root class="relative p-3">
  <Button
    variant="ghost"
    size="icon-xs"
    class="text-muted-foreground absolute right-2 top-2 rounded-full"
    onclick={() => ($histogramCollapsed = !$histogramCollapsed)}
    title={$histogramCollapsed ? "Show histograms" : "Hide histograms"}
  >
    {#if $histogramCollapsed}
      <ChevronDown />
    {:else}
      <X />
    {/if}
  </Button>
  <!-- pr-10 keeps the selector clear of the absolutely positioned collapse button. -->
  <div class="mb-3 flex items-center gap-2 pr-10">
    <span class="text-muted-foreground text-xs">Model</span>
    <Select.Root
      type="single"
      value={statsModel || ALL_MODELS}
      onValueChange={(value) => onStatsModelChange(value === ALL_MODELS ? "" : value)}
    >
      <Select.Trigger size="sm" class="h-8 min-w-0 max-w-[18rem] text-xs" title="Model the stats below describe">
        <span class="truncate">{statsModel || "All models"}</span>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={ALL_MODELS} label="All models">All models</Select.Item>
        {#each modelOptions as option (option.id)}
          <Select.Item value={option.id} label={option.id}>
            {option.id}
            <span class="text-muted-foreground ml-auto pl-3 tabular-nums" title={nf.format(option.requests)}>
              {formatCompact(option.requests)}
            </span>
          </Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
  {#if !$histogramCollapsed}
    <div class="mb-3 flex flex-col gap-6 sm:flex-row">
      <div class="w-full min-w-0 sm:w-1/2">
        <div class="text-muted-foreground mb-1 text-sm font-medium">Prompt Processing</div>
        {#if stats?.prompt_scatter && stats.prompt_scatter.length > 0}
          <PromptPrefillScatter points={stats.prompt_scatter} />
        {/if}
        {#if stats?.prompt_scatter && stats.prompt_scatter.length > 0}
          <!-- Weighted by time, not request count: counting requests is
               dominated by the many short prompts that cost almost nothing,
               and hides the few long ones that own the wall clock. -->
          <PrefillTimeHistogram
            samples={stats.prompt_scatter.map((p) => ({ speed: p.speed, prefillMs: p.prefill_ms }))}
          />
        {:else}
          <div class="text-muted-foreground py-6 text-center text-sm">No prompt speed data yet</div>
        {/if}
      </div>
      <div class="w-full min-w-0 sm:w-1/2">
        <div class="text-muted-foreground mb-1 flex items-center gap-2 text-sm font-medium">
          Token Generation
          <Button
            variant="ghost"
            size="xs"
            class="text-muted-foreground font-normal"
            onclick={() => ($decodeSpeedMode = $decodeSpeedMode === "system" ? "stream" : "system")}
            title="System: each request shows what the whole GPU produced during its decode, so parallel agents do not read as a slowdown. Per stream: the request's own reported speed."
          >
            Speed: {$decodeSpeedMode === "system" ? "system" : "per stream"}
          </Button>
        </div>
        {#if genPoints.length > 0}
          <DecodeScatter
            points={genPoints}
            title={$decodeSpeedMode === "system" ? "System Decode vs Context Length" : "Decode Speed vs Context Length"}
            yLabel={$decodeSpeedMode === "system" ? "System decode during request (tokens/sec)" : "Decode speed (tokens/sec)"}
          />
        {/if}
        {#if genHistogram}
          <TokenHistogram
            data={genHistogram}
            unit="tokens/sec"
            xLabel={$decodeSpeedMode === "system" ? "System decode during request (tokens/sec)" : "Decode speed (tokens/sec)"}
            yLabel="Requests"
          />
        {:else}
          <div class="text-muted-foreground py-6 text-center text-sm">No generation speed data yet</div>
        {/if}
      </div>
    </div>
    {#if concurrency.timed > 0}
      <div class="mt-3">
        <div class="text-muted-foreground mb-1 flex flex-wrap items-baseline gap-x-4 text-sm">
          <span class="font-medium">Parallel Decode</span>
          <span title="Output tokens ÷ wall-clock time with any decode running">
            system <span class="text-foreground font-semibold">{formatCompact(concurrency.systemTps)}</span> tok/s
          </span>
          <span title="Output tokens ÷ summed per-request decode time">
            per-stream {formatCompact(concurrency.perStreamTps)} tok/s
          </span>
          <span title="Summed decode time ÷ wall-clock time with any decode running">
            avg {concurrency.meanConcurrency.toFixed(2)}× concurrent
          </span>
          {#if concurrency.levels.length > 1}
            <span>
              {concurrency.levels
                .filter((l) => l.k > 1 && l.speedup > 0)
                .map((l) => `${l.k}: ${l.speedup.toFixed(2)}×`)
                .join(" · ")}
            </span>
          {/if}
        </div>
        {#if concurrency.maxK > 1}
          <div class="w-full min-w-0 sm:w-1/2">
            <ConcurrencyHeat data={concurrency} />
          </div>
        {:else}
          <div class="text-muted-foreground py-2 text-sm">
            No decodes have overlapped yet, so system and per-stream rates are equal.
          </div>
        {/if}
      </div>
    {/if}
  {/if}
  <div class="grid grid-cols-4 gap-x-6 gap-y-1 text-sm">
    <div class="text-muted-foreground text-xs uppercase tracking-wider">Requests</div>
    <div class="text-muted-foreground text-xs uppercase tracking-wider">Cached</div>
    <div class="text-muted-foreground text-xs uppercase tracking-wider">Processed</div>
    <div class="text-muted-foreground text-xs uppercase tracking-wider">Generated</div>
    <div class="text-sm" title={nf.format(stats?.total_requests ?? 0)}>
      <span class="font-semibold">{formatCompact(stats?.total_requests ?? 0)}</span> completed
    </div>
    <div class="text-sm" title={nf.format(stats?.total_cache_tokens ?? 0)}>
      <span class="font-semibold">{formatCompact(stats?.total_cache_tokens ?? 0)}</span> tokens
    </div>
    <div class="text-sm" title={nf.format(stats?.total_input_tokens ?? 0)}>
      <span class="font-semibold">{formatCompact(stats?.total_input_tokens ?? 0)}</span> tokens
    </div>
    <div class="text-sm" title={nf.format(stats?.total_output_tokens ?? 0)}>
      <span class="font-semibold">{formatCompact(stats?.total_output_tokens ?? 0)}</span> tokens
      {#if concurrency.systemTps > 0}
        <span
          class="text-muted-foreground"
          title={`System rate: output tokens ÷ wall-clock time with any decode running. Per stream: ${formatCompact(concurrency.perStreamTps)} tok/s.`}
        >
          · {formatCompact(concurrency.systemTps)} tok/s
        </span>
      {/if}
    </div>
  </div>
</Card.Root>
