import type { ToolDefinition } from "./chatApi";
import type { ImageGenerationResponse, MediaInfo } from "./types";
import { buildImageRequest } from "./imageApi";
import { createImageJob, deleteImageJob, waitForImageJob } from "./imageJobs";
import { createVideoJob, deleteVideo, getVideoContent, getVideoStatus } from "./videoApi";
import { putMedia } from "./mediaStore";

/**
 * terra fork: the Chat tab's generate_image / generate_video tools.
 *
 * The browser runs them, not the model's backend: an image goes through
 * llama-swap's /api/jobs, a video through the backend's own /v1/videos job.
 * Both use the model picked on the Images or Video tab. Loading that model
 * unloads the chat model, so the turn ends when the media is shown instead of
 * swapping the chat model back in just to comment on it. The model gets a
 * short text result, so it can refer to the media in a later turn.
 */

export const IMAGE_TOOL = "generate_image";
export const VIDEO_TOOL = "generate_video";

// The Images and Video tabs' size lists (Qwen-Image 2.1 and LTX-2.5 on Radiance).
export const IMAGE_SIZES = [
  "1024x1024", "1536x1536", "2048x2048",
  "1664x928", "2720x1536", "1536x1024", "2528x1696", "1408x1056", "2400x1792",
  "928x1664", "1536x2720", "1024x1536", "1696x2528", "1056x1408", "1792x2400",
];
export const VIDEO_SIZES = ["960x544", "1280x704", "1664x896", "1408x1088", "544x960", "704x1280", "896x1664", "1088x1408", "768x768", "1216x1216"];
export const MAX_IMAGES = 4;
export const MIN_VIDEO_SECONDS = 0.7;
export const MAX_VIDEO_SECONDS = 6.7;

export const MEDIA_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: IMAGE_TOOL,
      description:
        "Generate pictures from a text prompt with a diffusion model and show them to the user. " +
        "Write a detailed visual description in English: subject, setting, style, lighting, composition. " +
        "The user sees the pictures; you do not.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the picture." },
          size: {
            type: "string",
            enum: IMAGE_SIZES,
            description: "WIDTHxHEIGHT. Square 1024x1024 unless the user asks for a shape; larger sizes are slower.",
          },
          n: { type: "integer", minimum: 1, maximum: MAX_IMAGES, description: "Number of pictures, default 1." },
          negative_prompt: { type: "string", description: "Optional. What the picture must not show." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: VIDEO_TOOL,
      description:
        "Generate a short video clip from a text prompt and show it to the user. Describe the scene and the motion " +
        "in English. Takes minutes; use it only when the user asks for a video.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the scene, the motion and the camera." },
          size: { type: "string", enum: VIDEO_SIZES, description: "WIDTHxHEIGHT, default 960x544 (16:9)." },
          seconds: {
            type: "number",
            minimum: MIN_VIDEO_SECONDS,
            maximum: MAX_VIDEO_SECONDS,
            description: "Clip length in seconds, default 5.",
          },
        },
        required: ["prompt"],
      },
    },
  },
];

export function isMediaTool(name: string): boolean {
  return name === IMAGE_TOOL || name === VIDEO_TOOL;
}

/** Defaults taken from the Images and Video tabs. */
export interface MediaToolContext {
  imageModel: string;
  imageSize: string;
  videoModel: string;
  videoSize: string;
  videoSeconds: number;
}

export interface ParsedImageArgs {
  kind: "image";
  prompt: string;
  size: string;
  n: number;
  negativePrompt?: string;
}
export interface ParsedVideoArgs {
  kind: "video";
  prompt: string;
  size: string;
  seconds: number;
}

/**
 * Validates a tool call's arguments against the context. A bad size or count
 * is replaced by the default rather than refused: a refusal would need the
 * chat model swapped back in to retry.
 */
export function parseMediaArgs(
  name: string,
  args: unknown,
  ctx: MediaToolContext
): ParsedImageArgs | ParsedVideoArgs | { error: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
  if (!prompt) return { error: "the prompt is empty" };

  if (name === IMAGE_TOOL) {
    if (!ctx.imageModel) return { error: "no image model is selected on the Images tab" };
    const size = typeof a.size === "string" && IMAGE_SIZES.includes(a.size) ? a.size : ctx.imageSize;
    const rawN = Number(a.n);
    const n = Number.isFinite(rawN) ? Math.min(MAX_IMAGES, Math.max(1, Math.floor(rawN))) : 1;
    const negativePrompt = typeof a.negative_prompt === "string" && a.negative_prompt.trim() ? a.negative_prompt.trim() : undefined;
    return { kind: "image", prompt, size, n, negativePrompt };
  }
  if (name === VIDEO_TOOL) {
    if (!ctx.videoModel) return { error: "no video model is selected on the Video tab" };
    const size = typeof a.size === "string" && VIDEO_SIZES.includes(a.size) ? a.size : ctx.videoSize;
    const rawS = Number(a.seconds);
    const base = Number.isFinite(rawS) && rawS > 0 ? rawS : ctx.videoSeconds;
    const seconds = Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, base));
    return { kind: "video", prompt, size, seconds };
  }
  return { error: `unknown tool ${name}` };
}

/** The text the chat model gets back. */
export function mediaResultText(media: MediaInfo): string {
  const what =
    media.kind === "image"
      ? `${media.keys?.length ?? 0} picture(s), ${media.size}`
      : `a ${media.seconds?.toFixed(1)} s video, ${media.size}`;
  switch (media.status) {
    case "done":
      return `Generated ${what} with ${media.model}. They are shown to the user. Prompt: ${media.prompt}`;
    case "cancelled":
      return "The user cancelled the generation.";
    case "error":
      return `Error: ${media.error ?? "the generation failed"}`;
    default:
      return "The generation is still running.";
  }
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function b64ToBlob(b64: string, type = "image/png"): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const VIDEO_FAILED = new Set(["failed", "error", "cancelled", "canceled"]);
const VIDEO_POLL_MS = 2000;

/** Polls a video job to the end. Failed polls (a locked phone) are retried; the job runs on regardless. */
async function waitForVideo(id: string, model: string, signal: AbortSignal): Promise<Blob> {
  for (;;) {
    try {
      const job = await getVideoStatus(id, model, signal);
      if (job.status === "completed") return await getVideoContent(id, model, signal);
      if (VIDEO_FAILED.has(job.status)) {
        const e = job.error;
        const detail = !e ? "" : typeof e === "string" ? e : (e.message ?? JSON.stringify(e));
        throw new Error(`video generation ${job.status}${detail ? `: ${detail}` : ""}`);
      }
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err instanceof Error && err.message.startsWith("video generation")) throw err;
      // A 404 means the backend lost the job (it was restarted).
      if (err instanceof Error && /error: 404/.test(err.message)) throw new Error("the video job is gone (the model was restarted)");
    }
    await sleep(VIDEO_POLL_MS, signal);
  }
}

/**
 * Waits for a media job that already has a jobId and stores the result.
 * Used both right after the job starts and to resume one after a reload.
 */
export async function finishMediaTool(
  callId: string,
  media: MediaInfo,
  signal: AbortSignal,
  onUpdate: (m: MediaInfo) => void
): Promise<MediaInfo> {
  const id = media.jobId!;
  const onAbort = () => {
    if (media.kind === "image") deleteImageJob("images", id);
    else deleteVideo(id, media.model).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const keys: string[] = [];
    if (media.kind === "image") {
      const result = await waitForImageJob<ImageGenerationResponse>("images", id, signal);
      const blobs = await Promise.all(
        (result.data ?? []).map(async (d) =>
          d.b64_json ? b64ToBlob(d.b64_json) : d.url ? await (await fetch(d.url)).blob() : null
        )
      );
      for (const blob of blobs) {
        if (!blob) continue;
        const key = `${callId}/${keys.length}`;
        await putMedia(key, blob);
        keys.push(key);
      }
      if (keys.length === 0) throw new Error("the image model returned no pictures");
    } else {
      const blob = await waitForVideo(id, media.model, signal);
      const key = `${callId}/0`;
      await putMedia(key, blob);
      keys.push(key);
    }
    const done: MediaInfo = { ...media, status: "done", keys };
    onUpdate(done);
    return done;
  } catch (err) {
    const ended: MediaInfo = isAbort(err) || signal.aborted
      ? { ...media, status: "cancelled" }
      : { ...media, status: "error", error: err instanceof Error ? err.message : String(err) };
    onUpdate(ended);
    return ended;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Runs one media tool call from start to end. Never throws; the outcome is in the returned MediaInfo. */
export async function runMediaTool(
  callId: string,
  name: string,
  rawArguments: string,
  ctx: MediaToolContext,
  signal: AbortSignal,
  onUpdate: (m: MediaInfo) => void
): Promise<MediaInfo> {
  const kind = name === VIDEO_TOOL ? "video" : "image";
  let args: unknown;
  try {
    args = JSON.parse(rawArguments || "{}");
  } catch {
    args = null;
  }
  const parsed = args === null ? { error: "the tool arguments were not valid JSON" } : parseMediaArgs(name, args, ctx);
  if ("error" in parsed) {
    const failed: MediaInfo = { kind, status: "error", prompt: "", model: "", error: parsed.error };
    onUpdate(failed);
    return failed;
  }

  let media: MediaInfo =
    parsed.kind === "image"
      ? { kind: "image", status: "running", prompt: parsed.prompt, model: ctx.imageModel, size: parsed.size }
      : { kind: "video", status: "running", prompt: parsed.prompt, model: ctx.videoModel, size: parsed.size, seconds: parsed.seconds };
  onUpdate(media);

  try {
    if (parsed.kind === "image") {
      const body = buildImageRequest(ctx.imageModel, parsed.prompt, parsed.size, {
        n: parsed.n,
        negativePrompt: parsed.negativePrompt,
      });
      const job = await createImageJob("images", body, signal);
      media = { ...media, jobId: job.id };
    } else {
      const job = await createVideoJob(ctx.videoModel, parsed.prompt, { size: parsed.size, seconds: parsed.seconds }, null, signal);
      media = { ...media, jobId: job.id };
    }
  } catch (err) {
    const ended: MediaInfo = isAbort(err)
      ? { ...media, status: "cancelled" }
      : { ...media, status: "error", error: err instanceof Error ? err.message : String(err) };
    onUpdate(ended);
    return ended;
  }
  onUpdate(media);
  return finishMediaTool(callId, media, signal, onUpdate);
}
