<script lang="ts">
  // The request queue (terra fork, patch 33). Replaces the in-flight table on
  // the Activity page: for an upstream that publishes its scheduler (Radiance
  // /stats, polled by queuepoll.go) it draws the KV pool and who holds it, the
  // running batch and the waiting line with the reason each request waits.
  // Rows join llama-swap's in-flight entries by the X-Request-Tag rad echoes,
  // so session, client and cancel work as before. In-flight requests with no
  // scheduler row (other models, a model still loading) stay listed below.
  import type { InflightRequestEntry, QueueRequest, QueueSnapshot } from "../lib/types";
  import { cancelInflightRequest, queueSnapshots, uiConfig } from "../stores/api";
  import { persistentStore } from "../stores/persistent";
  import { formatBytes, liveElapsedMs, requestHeader, sessionID } from "../lib/inflight";
  import {
    SlotAssigner,
    backfillLeftS,
    effectivePriority,
    formatTick,
    formatTokens,
    kvLayout,
    kvTicks,
    reserveTokens,
    requestKey,
    runningRequests,
    waitReason,
    waitingRequests,
    type KVLayout,
    type KVSegment,
  } from "../lib/queueView";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { ChevronDown, CircleX, X } from "@lucide/svelte";
  import MiddleEllipsis from "./activity-table/MiddleEllipsis.svelte";
  import ModelLink from "./activity-table/ModelLink.svelte";

  interface Props {
    inflightRequests: InflightRequestEntry[];
    storagePrefix?: string;
  }

  let { inflightRequests, storagePrefix = "activity" }: Props = $props();

  // svelte-ignore state_referenced_locally
  const storedOpen = persistentStore<boolean>(`${storagePrefix}-queue-open`, true);
  let open = $state($storedOpen);
  function setOpen(v: boolean) {
    open = v;
    storedOpen.set(v);
  }

  // Ages and hold times tick between the once-a-second snapshots.
  let nowMs = $state(performance.now());
  $effect(() => {
    const t = setInterval(() => (nowMs = performance.now()), 250);
    return () => clearInterval(t);
  });
  function sinceSnap(s: QueueSnapshot): number {
    return Math.max(0, (nowMs - (s.client_received_at_ms ?? nowMs)) / 1000);
  }

  // Four slots: rad batches at most four sequences (--max-num-seqs 4).
  const SLOTS = 4;
  const assigner = new SlotAssigner(SLOTS);
  let slots = $derived(
    assigner.assign(
      $queueSnapshots.flatMap((s) => runningRequests(s).map((r) => requestKey(s.model, r)))
    )
  );
  function slotOf(s: QueueSnapshot, r: QueueRequest): number {
    return slots.get(requestKey(s.model, r)) ?? 0;
  }

  let byID = $derived(new Map(inflightRequests.map((e) => [e.id, e])));
  let matchedIDs = $derived.by(() => {
    const ids = new Set<string>();
    for (const s of $queueSnapshots) for (const r of s.requests) if (r.tag && byID.has(r.tag)) ids.add(r.tag);
    return ids;
  });
  let others = $derived(inflightRequests.filter((e) => !matchedIDs.has(e.id)));
  let totalRunning = $derived($queueSnapshots.reduce((n, s) => n + runningRequests(s).length, 0));
  let totalWaiting = $derived($queueSnapshots.reduce((n, s) => n + waitingRequests(s).length, 0));

  function entryOf(r: QueueRequest): InflightRequestEntry | undefined {
    return r.tag ? byID.get(r.tag) : undefined;
  }
  function sessionOf(e: InflightRequestEntry | undefined): string {
    return e ? sessionID(e.req_headers, $uiConfig.activity.session_id) : "";
  }
  // The short name drawn on a bar segment: the session's tail, else the id.
  function shortName(r: QueueRequest): string {
    const sess = sessionOf(entryOf(r));
    return sess ? `…${sess.slice(-6)}` : `#${r.id}`;
  }
  function clientOf(e: InflightRequestEntry | undefined): string {
    if (!e) return "";
    const ua = requestHeader(e.req_headers, "User-Agent");
    return ua ? ua.split(/[ /]/)[0] : e.remote_ip;
  }

  let cancelling = $state<string[]>([]);
  async function cancel(id: string | undefined) {
    if (!id || cancelling.includes(id)) return;
    cancelling = [...cancelling, id];
    try {
      await cancelInflightRequest(id);
    } finally {
      cancelling = cancelling.filter((x) => x !== id);
    }
  }

  const pct = (tokens: number, total: number) => (100 * tokens) / Math.max(1, total);
  function fmtS(s: number): string {
    if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
    return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  }
  function segmentTitle(g: KVSegment): string {
    const t = formatTokens(g.tokens);
    switch (g.kind) {
      case "held":
        return `#${g.request!.id} ${shortName(g.request!)}: holds ${t} of context`;
      case "reserve":
        return `#${g.request!.id}: ${t} reserved for output (--admit-kv-reserve)`;
      case "cache":
        return `prefix cache of finished turns: ${t}, evicted on demand`;
      default:
        return `free: ${t}`;
    }
  }

  // The head of the line drawn as a ghost after what running requests commit.
  function headGhost(s: QueueSnapshot, l: KVLayout) {
    const head = waitingRequests(s)[0];
    const need = head?.admit_tokens ?? 0;
    if (!head || need <= 0) return null;
    const fits = need <= l.room;
    return {
      head,
      need,
      fits,
      left: pct(l.committed, l.total),
      width: pct(Math.min(need, l.room), l.total),
      short: Math.max(0, need - l.room),
    };
  }

  const toneClass: Record<string, string> = {
    hold: "border-[var(--q-warn)] text-[var(--q-warn-ink)]",
    blocked: "border-[var(--q-crit)] text-[var(--q-crit-ink)]",
    pending: "border-border text-muted-foreground",
    info: "border-border text-muted-foreground",
  };
  const thClass = "px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground whitespace-nowrap";
  const tdClass = "px-2 py-1 text-xs whitespace-nowrap";
</script>

<Card.Root class="qp relative p-3">
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 pr-10 text-sm">
    <span class="text-muted-foreground text-xs uppercase tracking-wider">Request Queue</span>
    <span><span class="font-semibold tabular-nums">{totalRunning}</span> running</span>
    <span><span class="font-semibold tabular-nums">{totalWaiting}</span> waiting</span>
    {#if others.length > 0}
      <span class="text-muted-foreground"><span class="font-semibold tabular-nums">{others.length}</span> other in flight</span>
    {/if}
  </div>
  <div class="absolute right-2 top-2">
    <Button
      variant="ghost"
      size="icon-xs"
      class="text-muted-foreground rounded-full"
      onclick={() => setOpen(!open)}
      title={open ? "Hide the request queue" : "Show the request queue"}
    >
      {#if open}<X />{:else}<ChevronDown />{/if}
    </Button>
  </div>

  {#if open}
    {#each $queueSnapshots as s (s.model)}
      {@const l = kvLayout(s)}
      {@const running = runningRequests(s)}
      {@const waiting = waitingRequests(s)}
      {@const policy = s.queue}
      {@const ghost = headGhost(s, l)}
      {@const dt = sinceSnap(s)}
      <section class="mt-3 border-t pt-3 first-of-type:border-t-0 first-of-type:pt-0" aria-label="Queue for {s.model}">
        <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
          <span class="text-sm font-medium"><ModelLink model={s.model} /></span>
          <span class="tabular-nums">
            KV <span class="font-semibold">{formatTokens(s.kv_tokens_used)}</span> / {formatTokens(s.kv_tokens_total)}
            <span class="text-muted-foreground">({pct(s.kv_tokens_used, s.kv_tokens_total).toFixed(0)}% held, {formatTokens(l.cache)} of it cache)</span>
          </span>
          <span class="tabular-nums">gate room <span class="font-semibold">{formatTokens(l.room)}</span></span>
          {#if s.decode_tps > 0}
            <span class="tabular-nums">{s.decode_tps.toFixed(0)} tok/s decode</span>
          {/if}
          <span class="tabular-nums text-muted-foreground">{s.preemptions} preemptions</span>
          {#if policy}
            <span class="text-muted-foreground ml-auto">
              {#if policy.kv_reserve > 0}reserve {formatTokens(policy.kv_reserve)} · backfill {(policy.backfill_ms / 1000).toFixed(0)}s · aging {policy.aging_s}s/pt
              {:else}KV-fit gate off{/if}
            </span>
          {/if}
        </div>

        <!-- The KV pool: one full-attention token axis. -->
        <div class="mt-2">
          <div class="qp-bar relative h-8 rounded-[4px]" role="img"
               aria-label="KV pool: {formatTokens(l.committed)} committed by {running.length} running, {formatTokens(l.cache)} cache, {formatTokens(l.free)} free of {formatTokens(l.total)}">
            {#each l.segments as g, i (g.kind + (g.request?.id ?? "") + i)}
              {@const w = pct(g.tokens, l.total)}
              <Tooltip.Root>
                <Tooltip.Trigger
                  class="qp-seg qp-{g.kind} absolute inset-y-0 overflow-hidden rounded-[4px] text-left"
                  style="left: calc({pct(g.start, l.total)}% + 1px); width: max(0px, calc({w}% - 2px)); --c: var(--q-s{g.request ? slotOf(s, g.request) + 1 : 1});"
                  aria-label={segmentTitle(g)}
                >
                  {#if g.kind === "held" && w >= 7}
                    <span class="qp-seg-label">{shortName(g.request!)} · {formatTokens(g.tokens)}</span>
                  {/if}
                </Tooltip.Trigger>
                <Tooltip.Content>{segmentTitle(g)}</Tooltip.Content>
              </Tooltip.Root>
            {/each}
            {#if ghost}
              <div
                class="qp-ghost pointer-events-none absolute -inset-y-1 rounded-[5px] {ghost.fits ? 'qp-ghost-fit' : 'qp-ghost-short'}"
                style="left: calc({ghost.left}% + 1px); width: max(6px, calc({ghost.width}% - 2px));"
              ></div>
            {/if}
          </div>
          <div class="relative mt-1 h-4 text-[10px] text-muted-foreground tabular-nums">
            {#each kvTicks(l.total) as t (t)}
              <span class="absolute -translate-x-1/2" style="left: {pct(t, l.total)}%">{formatTick(t)}</span>
            {/each}
            <span class="absolute right-0">{formatTokens(l.total)}</span>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span class="flex items-center gap-1"><span class="qp-key qp-held" style="--c: var(--q-s1)"></span>held context</span>
            <span class="flex items-center gap-1"><span class="qp-key qp-reserve" style="--c: var(--q-s1)"></span>output reserve</span>
            <span class="flex items-center gap-1"><span class="qp-key qp-cache"></span>prefix cache (evictable)</span>
            <span class="flex items-center gap-1"><span class="qp-key qp-free"></span>free</span>
            {#if ghost}
              <span class="flex items-center gap-1 text-foreground">
                <span class="qp-key qp-ghost {ghost.fits ? 'qp-ghost-fit' : 'qp-ghost-short'}"></span>
                next in line #{ghost.head.id} needs {formatTokens(ghost.need)}
                {#if ghost.fits}: fits{:else}: short {formatTokens(ghost.short)}{/if}
              </span>
            {/if}
          </div>
        </div>

        <!-- Running batch -->
        <div class="mt-3 overflow-x-auto">
          <Table.Root class="min-w-full">
            <Table.Header>
              <Table.Row>
                <Table.Head class={thClass}>Running</Table.Head>
                <Table.Head class={thClass}>Session</Table.Head>
                <Table.Head class={thClass}>Client</Table.Head>
                <Table.Head class={thClass}>State</Table.Head>
                <Table.Head class="{thClass} text-right">Prio</Table.Head>
                <Table.Head class="{thClass} text-right">Context</Table.Head>
                <Table.Head class="{thClass} text-right">Cached</Table.Head>
                <Table.Head class="{thClass} text-right">Reserve</Table.Head>
                <Table.Head class="{thClass} text-right">Output</Table.Head>
                <Table.Head class="{thClass} text-right">tok/s</Table.Head>
                <Table.Head class="{thClass} text-right">TTFT</Table.Head>
                <Table.Head class="{thClass} text-right">Age</Table.Head>
                <Table.Head class={thClass}></Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each running as r (r.id)}
                {@const e = entryOf(r)}
                {@const prefill = r.state === "prefill"}
                <Table.Row>
                  <Table.Cell class={tdClass}>
                    <span class="inline-flex items-center gap-2">
                      <span class="qp-key qp-held" style="--c: var(--q-s{slotOf(s, r) + 1})"></span>
                      <span class="font-mono">#{r.id}</span>
                    </span>
                  </Table.Cell>
                  <Table.Cell class={tdClass}><MiddleEllipsis value={sessionOf(e) || "—"} tailLength={8} className="max-w-[12rem] font-mono" /></Table.Cell>
                  <Table.Cell class={tdClass}><MiddleEllipsis value={clientOf(e) || "—"} tailLength={8} className="max-w-[10rem]" /></Table.Cell>
                  <Table.Cell class={tdClass}>
                    {#if prefill}
                      {@const done = r.prompt > 0 ? r.computed / r.prompt : 0}
                      <span class="inline-flex items-center gap-2">
                        <span class="qp-progress" style="--p: {(done * 100).toFixed(1)}%; --c: var(--q-s{slotOf(s, r) + 1})"></span>
                        prefill {(done * 100).toFixed(0)}%
                      </span>
                    {:else}
                      decode
                    {/if}
                  </Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums">{r.priority}</Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums">{formatTokens(r.kv_tokens)}</Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums text-muted-foreground">{formatTokens(r.cached)}</Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums">{reserveTokens(r) > 0 ? formatTokens(reserveTokens(r)) : "—"}</Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums">{formatTokens(r.output)}<span class="text-muted-foreground"> / {formatTokens(r.max)}</span></Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums">{r.tps > 0 ? r.tps.toFixed(1) : "—"}</Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums">{r.ttft_s !== undefined ? fmtS(r.ttft_s) : "—"}</Table.Cell>
                  <Table.Cell class="{tdClass} text-right tabular-nums">{fmtS(r.age_s + dt)}</Table.Cell>
                  <Table.Cell class={tdClass}>
                    {#if e}
                      <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive size-6"
                              onclick={() => cancel(e.id)} disabled={cancelling.includes(e.id)}
                              title="Cancel request" aria-label="Cancel request #{r.id}">
                        <CircleX class="size-4" />
                      </Button>
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {:else}
                <Table.Row><Table.Cell colspan={13} class="{tdClass} text-muted-foreground">Nothing running</Table.Cell></Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        </div>

        <!-- Waiting line, in service order -->
        {#if waiting.length > 0}
          <div class="mt-3 overflow-x-auto">
            <Table.Root class="min-w-full">
              <Table.Header>
                <Table.Row>
                  <Table.Head class={thClass}>Waiting</Table.Head>
                  <Table.Head class={thClass}>Session</Table.Head>
                  <Table.Head class={thClass}>Client</Table.Head>
                  <Table.Head class="{thClass} text-right">Prio</Table.Head>
                  <Table.Head class={thClass}>Needs</Table.Head>
                  <Table.Head class="{thClass} text-right">Waited</Table.Head>
                  <Table.Head class={thClass}>Why</Table.Head>
                  <Table.Head class={thClass}></Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {#each waiting as r (r.id)}
                  {@const e = entryOf(r)}
                  {@const age = r.age_s + dt}
                  {@const held = r.held_s !== undefined ? r.held_s + dt : undefined}
                  {@const why = waitReason(r, l, policy?.backfill_ms ?? 0, held)}
                  {@const need = r.admit_tokens ?? 0}
                  {@const left = backfillLeftS(r, policy?.backfill_ms ?? 0, held)}
                  <Table.Row>
                    <Table.Cell class={tdClass}>
                      <span class="font-mono"><span class="text-muted-foreground">{(r.queue_pos ?? 0) + 1}.</span> #{r.id}</span>
                    </Table.Cell>
                    <Table.Cell class={tdClass}><MiddleEllipsis value={sessionOf(e) || "—"} tailLength={8} className="max-w-[12rem] font-mono" /></Table.Cell>
                    <Table.Cell class={tdClass}><MiddleEllipsis value={clientOf(e) || "—"} tailLength={8} className="max-w-[10rem]" /></Table.Cell>
                    <Table.Cell class="{tdClass} text-right tabular-nums">
                      {r.priority}
                      {#if policy && policy.aging_s > 0}
                        <span class="text-muted-foreground" title="priority + waited / {policy.aging_s}s"> → {effectivePriority(r, policy.aging_s, age).toFixed(1)}</span>
                      {/if}
                    </Table.Cell>
                    <Table.Cell class={tdClass}>
                      {#if need > 0}
                        <span class="inline-flex items-center gap-2 tabular-nums">
                          <span class="qp-need" title="needs {formatTokens(need)}; the gate has {formatTokens(l.room)} free"
                                style="--n: {Math.min(100, pct(need, l.total)).toFixed(1)}%; --r: {pct(l.room, l.total).toFixed(1)}%"
                                class:qp-need-short={need > l.room}></span>
                          {formatTokens(need)}
                        </span>
                      {:else}
                        <span class="tabular-nums">{formatTokens(r.prompt)}</span>
                      {/if}
                    </Table.Cell>
                    <Table.Cell class="{tdClass} text-right tabular-nums">{fmtS(age)}</Table.Cell>
                    <Table.Cell class="{tdClass} whitespace-normal">
                      <span class="inline-flex flex-wrap items-center gap-2">
                        <span class="rounded-full border px-2 py-px text-[11px] font-medium {toneClass[why.tone]}">{why.label}</span>
                        {#if left !== null && left > 0}
                          <span class="qp-countdown" style="--p: {(100 * left / ((policy?.backfill_ms ?? 1) / 1000)).toFixed(1)}%" title="backfill window left"></span>
                        {/if}
                        <span class="text-muted-foreground">{why.detail}</span>
                      </span>
                    </Table.Cell>
                    <Table.Cell class={tdClass}>
                      {#if e}
                        <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive size-6"
                                onclick={() => cancel(e.id)} disabled={cancelling.includes(e.id)}
                                title="Cancel request" aria-label="Cancel request #{r.id}">
                          <CircleX class="size-4" />
                        </Button>
                      {/if}
                    </Table.Cell>
                  </Table.Row>
                {/each}
              </Table.Body>
            </Table.Root>
          </div>
        {/if}
      </section>
    {/each}

    <!-- In flight without a scheduler row -->
    {#if others.length > 0 || $queueSnapshots.length === 0}
      <div class="mt-3 overflow-x-auto {$queueSnapshots.length > 0 ? 'border-t pt-3' : ''}">
        <Table.Root class="min-w-full">
          <Table.Header>
            <Table.Row>
              <Table.Head class={thClass}>{$queueSnapshots.length > 0 ? "Other in flight" : "In flight"}</Table.Head>
              <Table.Head class={thClass}>Request</Table.Head>
              <Table.Head class={thClass}>Session</Table.Head>
              <Table.Head class={thClass}>Client</Table.Head>
              <Table.Head class="{thClass} text-right">Received</Table.Head>
              <Table.Head class="{thClass} text-right">Elapsed</Table.Head>
              <Table.Head class={thClass}></Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each others as e (e.id)}
              <Table.Row>
                <Table.Cell class={tdClass}><MiddleEllipsis value={e.model || "—"} tailLength={10} className="max-w-[14rem]" /></Table.Cell>
                <Table.Cell class={tdClass}><MiddleEllipsis value={`${e.method} ${e.req_path}`} tailLength={14} className="max-w-[18rem] font-mono" /></Table.Cell>
                <Table.Cell class={tdClass}><MiddleEllipsis value={sessionOf(e) || "—"} tailLength={8} className="max-w-[12rem] font-mono" /></Table.Cell>
                <Table.Cell class={tdClass}><MiddleEllipsis value={clientOf(e) || "—"} tailLength={8} className="max-w-[10rem]" /></Table.Cell>
                <Table.Cell class="{tdClass} text-right tabular-nums">{formatBytes(e.resp_bytes)}</Table.Cell>
                <Table.Cell class="{tdClass} text-right tabular-nums">{fmtS(liveElapsedMs(e.elapsed_ms, e.client_received_at_ms, nowMs) / 1000)}</Table.Cell>
                <Table.Cell class={tdClass}>
                  <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-destructive size-6"
                          onclick={() => cancel(e.id)} disabled={cancelling.includes(e.id)}
                          title="Cancel request" aria-label="Cancel inflight request">
                    <CircleX class="size-4" />
                  </Button>
                </Table.Cell>
              </Table.Row>
            {:else}
              <Table.Row><Table.Cell colspan={7} class="{tdClass} text-muted-foreground">No requests in flight</Table.Cell></Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      </div>
    {/if}
  {/if}
</Card.Root>

<style>
  /* Categorical slots 1-4 of the validated reference palette (dataviz skill),
     stepped per mode; status tones for the wait reasons. */
  :global(.qp) {
    --q-s1: #2a78d6;
    --q-s2: #eb6834;
    --q-s3: #1baf7a;
    --q-s4: #eda100;
    --q-cache: #b9b8b2;
    --q-warn: #c98500;
    --q-warn-ink: #8a5a00;
    --q-crit: #d03b3b;
    --q-crit-ink: #b42323;
    --q-ok: #1baf7a;
    --q-track: color-mix(in oklab, var(--muted) 70%, transparent);
  }
  :global(.dark .qp) {
    --q-s1: #3987e5;
    --q-s2: #d95926;
    --q-s3: #199e70;
    --q-s4: #c98500;
    --q-cache: #5f5e5a;
    --q-warn: #eda100;
    --q-warn-ink: #f2bd4d;
    --q-crit: #e66767;
    --q-crit-ink: #f09595;
    --q-ok: #34c48f;
  }
  .qp-bar {
    background: var(--q-track);
  }
  :global(.qp-seg) {
    cursor: default;
  }
  :global(.qp-held) {
    background: var(--c);
  }
  /* The reserve is a claim, not an allocation: the request's hue, hatched. */
  :global(.qp-reserve) {
    background: repeating-linear-gradient(45deg, var(--c) 0 2px, transparent 2px 6px);
    box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--c) 60%, transparent);
  }
  :global(.qp-cache) {
    background: repeating-linear-gradient(135deg, var(--q-cache) 0 2px, transparent 2px 6px);
  }
  :global(.qp-free) {
    background: transparent;
  }
  .qp-seg-label {
    display: block;
    padding: 0 6px;
    line-height: 2rem;
    font-size: 11px;
    font-weight: 500;
    /* Near-black reads at 4.6:1 or better on all four fills, in both modes. */
    color: #0b0b0b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .qp-ghost {
    border: 2px dashed var(--q-ok);
  }
  .qp-ghost-short {
    border-color: var(--q-crit);
    border-right-style: solid;
    border-right-width: 3px;
  }
  .qp-key {
    display: inline-block;
    width: 14px;
    height: 10px;
    border-radius: 2px;
  }
  .qp-key.qp-free {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .qp-key.qp-ghost {
    background: transparent;
  }
  .qp-progress,
  .qp-need,
  .qp-countdown {
    position: relative;
    display: inline-block;
    height: 6px;
    border-radius: 3px;
    background: var(--q-track);
    overflow: hidden;
  }
  .qp-progress {
    width: 56px;
  }
  .qp-progress::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--p);
    background: var(--c);
    border-radius: 3px;
  }
  /* Need against the whole pool, with a tick where the gate's room ends. */
  .qp-need {
    width: 72px;
    overflow: visible;
  }
  .qp-need::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--n);
    background: var(--q-ok);
    border-radius: 3px;
  }
  .qp-need-short::after {
    background: var(--q-crit);
  }
  .qp-need::before {
    content: "";
    position: absolute;
    top: -2px;
    bottom: -2px;
    left: var(--r);
    width: 2px;
    background: var(--foreground);
    z-index: 1;
  }
  .qp-countdown {
    width: 40px;
  }
  .qp-countdown::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--p);
    background: var(--q-warn);
    border-radius: 3px;
  }
</style>
