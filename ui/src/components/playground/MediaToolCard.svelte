<script lang="ts">
  import { Download, ImageIcon, Video as VideoIcon, X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { getMedia } from "../../lib/mediaStore";
  import type { MediaInfo } from "../../lib/types";

  /**
   * terra fork: one generate_image / generate_video call in the Chat tab.
   * The media are read from IndexedDB (lib/mediaStore.ts) by key.
   */
  interface Props {
    media: MediaInfo;
  }

  let { media }: Props = $props();

  let urls = $state<string[]>([]);
  let missing = $state(false);
  let fullscreen = $state<string | null>(null);

  $effect(() => {
    const keys = media.status === "done" ? (media.keys ?? []) : [];
    let cancelled = false;
    const made: string[] = [];
    (async () => {
      const found: string[] = [];
      let lost = false;
      for (const key of keys) {
        const blob = await getMedia(key).catch(() => undefined);
        if (!blob) {
          lost = true;
          continue;
        }
        const url = URL.createObjectURL(blob);
        made.push(url);
        found.push(url);
      }
      if (!cancelled) {
        urls = found;
        missing = lost;
      }
    })();
    return () => {
      cancelled = true;
      for (const url of made) URL.revokeObjectURL(url);
    };
  });

  const label = $derived(media.kind === "video" ? "Video" : media.sources?.length ? "Edit" : "Image");
  const detail = $derived(
    [media.size, media.kind === "video" && media.seconds ? `${media.seconds.toFixed(1)} s` : "", media.model]
      .filter(Boolean)
      .join(" · ")
  );

  function download(url: string, i: number) {
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${media.kind}-${Date.now()}-${i}.${media.kind === "image" ? "png" : "mp4"}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
</script>

<div class="bg-card my-2 rounded-xl border p-3">
  <div class="text-muted-foreground mb-1 flex items-center gap-2 text-xs">
    {#if media.kind === "image"}<ImageIcon class="size-3.5" />{:else}<VideoIcon class="size-3.5" />{/if}
    <span class="text-foreground font-medium">{label}</span>
    {#if detail}<span class="min-w-0 truncate">{detail}</span>{/if}
    {#if media.sources?.length}<span class="shrink-0">from {media.sources.join(", ")}</span>{/if}
  </div>
  {#if media.prompt}
    <p class="text-muted-foreground mb-2 line-clamp-3 text-sm wrap-anywhere">{media.prompt}</p>
  {/if}

  {#if media.status === "running"}
    <div class="text-muted-foreground flex items-center gap-2 text-sm">
      <span class="border-primary inline-block size-4 animate-spin rounded-full border-2 border-t-transparent"></span>
      {media.jobId ? "Generating on the server. You can lock the phone." : "Starting..."}
    </div>
  {:else if media.status === "error"}
    <p class="text-destructive text-sm wrap-anywhere">{media.error ?? "The generation failed."}</p>
  {:else if media.status === "cancelled"}
    <p class="text-muted-foreground text-sm">Cancelled.</p>
  {:else if missing && urls.length === 0}
    <p class="text-muted-foreground text-sm">The {label.toLowerCase()} is no longer stored in this browser.</p>
  {:else if media.kind === "image"}
    <div class="grid gap-2 {urls.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}">
      {#each urls as url, i (url)}
        <div class="relative">
          <button class="block w-full cursor-zoom-in border-0 bg-transparent p-0" onclick={() => (fullscreen = url)} aria-label="View fullscreen">
            <img src={url} alt="Generated {i + 1}" class="max-h-[60dvh] w-full rounded-lg object-contain" />
          </button>
          {#if media.ids?.[i]}
            <!-- The id the chat model (and the user) can name this picture by. -->
            <span class="absolute top-2 left-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-xs text-white">{media.ids[i]}</span>
          {/if}
          <Button
            variant="secondary"
            size="icon"
            class="absolute right-2 bottom-2 size-8 bg-black/60 text-white hover:bg-black/80"
            onclick={() => download(url, i)}
            aria-label="Download image"
          >
            <Download class="size-4" />
          </Button>
        </div>
      {/each}
    </div>
  {:else}
    {#each urls as url, i (url)}
      <div class="relative">
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={url} controls loop playsinline class="max-h-[60dvh] w-full rounded-lg bg-black"></video>
        <Button
          variant="secondary"
          size="icon"
          class="absolute top-2 right-2 size-8 bg-black/60 text-white hover:bg-black/80"
          onclick={() => download(url, i)}
          aria-label="Download video"
        >
          <Download class="size-4" />
        </Button>
      </div>
    {/each}
  {/if}
</div>

{#if fullscreen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
    onclick={(e) => e.target === e.currentTarget && (fullscreen = null)}
    onkeydown={(e) => e.key === "Escape" && (fullscreen = null)}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <Button
      variant="secondary"
      size="icon"
      class="absolute top-4 right-4 bg-black/60 text-white hover:bg-black/80"
      onclick={() => (fullscreen = null)}
      aria-label="Close fullscreen"
    >
      <X class="size-6" />
    </Button>
    <img src={fullscreen} alt="Generated" class="pointer-events-none max-h-full max-w-full object-contain" />
  </div>
{/if}
