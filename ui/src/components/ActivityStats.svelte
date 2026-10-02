<script lang="ts">
  import type { ActivityStatsData } from "../lib/types";
  import { formatCompact } from "../lib/format";
  import { persistentStore } from "../stores/persistent";
  import TokenHistogram from "./TokenHistogram.svelte";
  import PrefillTimeHistogram from "./PrefillTimeHistogram.svelte";
  import PromptPrefillScatter from "./PromptPrefillScatter.svelte";
  import DecodeScatter from "./DecodeScatter.svelte";
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
  const scatterColorMode = persistentStore<"session" | "accept">("activity-scatter-color", "session");
</script>

<Card.Root class="relative p-3">
  <Button
    variant="ghost"
    size="xs"
    class="text-muted-foreground absolute right-10 top-2"
    onclick={() => ($scatterColorMode = $scatterColorMode === "session" ? "accept" : "session")}
    title="Toggle scatter point coloring between session and draft acceptance rate"
  >
    Color: {$scatterColorMode === "session" ? "session" : "acceptance"}
  </Button>
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
  <!-- pr-36 keeps the selector clear of the absolutely positioned buttons top-right. -->
  <div class="mb-3 flex items-center gap-2 pr-36">
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
          <PromptPrefillScatter points={stats.prompt_scatter} colorMode={$scatterColorMode} />
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
        <div class="text-muted-foreground mb-1 text-sm font-medium">Token Generation</div>
        {#if stats?.gen_scatter && stats.gen_scatter.length > 0}
          <DecodeScatter points={stats.gen_scatter} colorMode={$scatterColorMode} />
        {/if}
        {#if stats?.gen_histogram}
          <TokenHistogram
            data={stats.gen_histogram}
            unit="tokens/sec"
            xLabel="Decode speed (tokens/sec)"
            yLabel="Requests"
          />
        {:else}
          <div class="text-muted-foreground py-6 text-center text-sm">No generation speed data yet</div>
        {/if}
      </div>
    </div>
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
    </div>
  </div>
</Card.Root>
