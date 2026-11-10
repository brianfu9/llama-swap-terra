import type { ToolDefinition } from "./chatApi";
import type { ImageGenerationResponse, MediaInfo } from "./types";
import { buildImageRequest } from "./imageApi";
import {
  createFormServerJob,
  createImageJob,
  deleteImageJob,
  getJobContent,
  waitForImageJob,
  waitForJob,
  type ImageJobKind,
} from "./imageJobs";
import { buildVideoFormData } from "./videoApi";
import { putMedia } from "./mediaStore";

/**
 * terra fork: the Chat tab's generate_image / edit_image / generate_video tools.
 *
 * The browser runs them, not the model's backend, as llama-swap jobs
 * (/api/jobs/images, /api/jobs/edits and /api/jobs/videos).
 * They use the model picked on the Images or Video tab. Loading that model
 * unloads the chat model, so the turn ends when the media is shown instead of
 * swapping the chat model back in just to comment on it. The model gets a
 * short text result, and the generated pictures themselves in its next turn.
 *
 * Every picture in a chat has an id the model can name: att1, att2, ... for
 * the user's attachments in message order, img1, img2, ... for generated ones
 * (stored in MediaInfo.ids). edit_image and generate_video's `image` take them.
 */

export const IMAGE_TOOL = "generate_image";
export const EDIT_TOOL = "edit_image";
export const VIDEO_TOOL = "generate_video";

// The Images and Video tabs' size lists (Qwen-Image 2.1 and LTX-2.5 on Radiance).
export const IMAGE_SIZES = [
  "1024x1024", "1536x1536", "2048x2048",
  "1664x928", "2720x1536", "1536x1024", "2528x1696", "1408x1056", "2400x1792",
  "928x1664", "1536x2720", "1024x1536", "1696x2528", "1056x1408", "1792x2400",
];
export const VIDEO_SIZES = ["960x544", "1280x704", "1664x896", "1408x1088", "544x960", "704x1280", "896x1664", "1088x1408", "768x768", "1216x1216"];
export const MAX_IMAGES = 4;
/** Qwen-Image edits take at most this many source pictures. */
export const MAX_EDIT_SOURCES = 3;
export const MIN_VIDEO_SECONDS = 0.7;
export const MAX_VIDEO_SECONDS = 6.7;
// terra fork: an H3 clip is 7 chunks = 17 * 7 + 5 = 124 frames at 24 fps. Send exactly that: "5.17" is
// 124.08 frames, which the engine rounds up to 8 chunks and refuses ("makes 5.17 to 5.17 seconds").
export const H3_SECONDS = 124 / 24;

// terra fork: H3's chat default is 20 res_multistep steps at half size then the upscale (210 s at 1152x640,
// as clean as 50 steps); the hmnsfw LoRA is served (<lora:hmnsfw:0.7> in the prompt, or "loras").
// terra fork: H3 runs on one card with caps (llama-swap entry minimax-h3: 5.17 s clips,
// area <= 1152x640, text to video only); latent_upscale 2 renders the first steps at
// half size, 286 s instead of 727 s for 1152x640. A start picture pins the clip at its
// size, and Radiance refuses latent_upscale alongside a keyframe, so buildVideoFormData
// drops it from i2va requests (the single stage then runs the full-size 20 steps).
export interface VideoProfile {
  sizes: string[];
  defaultSize: string;
  minSeconds: number;
  maxSeconds: number;
  /** The form field a start picture goes in; null = not supported. */
  startImage: "input_reference" | "first_frame" | null;
  /** LoRA names the server's --lora-dir holds for this model (LORA_INFO). */
  loras: string[];
  /** Reference pictures allowed; 0 = none. */
  maxRefs: number;
  extra: Record<string, unknown>;
  describe: string;
}
export const VIDEO_PROFILES: Record<string, VideoProfile> = {
  ltx: {
    sizes: VIDEO_SIZES,
    defaultSize: "960x544",
    minSeconds: MIN_VIDEO_SECONDS,
    maxSeconds: MAX_VIDEO_SECONDS,
    startImage: "input_reference",
    maxRefs: 0,
    loras: [],
    extra: {},
    describe: "ltx: LTX-2.5, fast (about 25 s for 5 s at 960x544), from text or a start picture, 0.7 to 6.7 s",
  },
  "minimax-h3": {
    sizes: ["1152x640", "960x544", "672x384", "640x1152", "544x960", "768x768"],
    defaultSize: "1152x640",
    minSeconds: H3_SECONDS,
    maxSeconds: H3_SECONDS,
    startImage: "first_frame",
    maxRefs: 9,
    loras: ["hmnsfw"],
    extra: { latent_upscale: 2, num_inference_steps: 20, sampler: "res_multistep" },
    describe:
      "minimax-h3: MiniMax-H3, higher quality with richer sound, slow (about 3.5 minutes), from text, a start picture or up to 9 reference pictures, always 5.17 s, at most 1152x640",
  },
  "minimax-h3-ref": {
    sizes: ["1152x640", "960x544", "672x384", "640x1152", "544x960", "768x768"],
    defaultSize: "1152x640",
    minSeconds: H3_SECONDS,
    maxSeconds: H3_SECONDS,
    startImage: "first_frame",
    maxRefs: 9,
    loras: ["hmnsfw"],
    extra: { latent_upscale: 2, num_inference_steps: 20, sampler: "res_multistep" },
    describe:
      "minimax-h3-ref: MiniMax-H3's Ref2VA model, best for putting the subject of reference pictures into a new scene; same sizes and length as minimax-h3",
  },
};
export function videoProfile(model: string): VideoProfile {
  return VIDEO_PROFILES[model] ?? VIDEO_PROFILES.ltx;
}

// terra fork: the LoRAs terra's llama-swap serves for the minimax entries (/root/models/loras/h3, slot rank 16).
// `shift` is the video sigma shift the LoRA's author asks for, sent unless the call already sets one.
export const LORA_INFO: Record<string, { note: string; shift?: number }> = {
  hmnsfw: { note: "HMNSFW V2.5: explicit adult content (nudity and sex acts); strength 0.5-0.9, 0.7 typical", shift: 6 },
};

/**
 * terra fork: MiniMax-H3's prompt format, condensed from MiniMax's VIDEO_PROMPT_WRITING_GUIDE_base_en.md and
 * VIDEO_PROMPT_WRITING_GUIDE_ref_en.md (huggingface.co/MiniMaxAI/MiniMax-H3/docs). The model was trained on these
 * structured rewrites, not on short captions. Radiance shows reference pictures to the text encoder as
 * <Picture 1>, <Picture 2>, ... in front of the prompt, in the order of `references`.
 */
export const H3_PROMPT_GUIDE =
  "MiniMax-H3 prompt format (minimax models): write the prompt in English as MiniMax's structured rewrite, not a " +
  "caption. The clip is 5.17 s, so cut times stay under 00:05. " +
  "(A) Text only: three fields separated by blank lines: " +
  "'integrated_multimodal_description: [Shot 1] <style, e.g. Live-action, cinematic,> <shot size and framing>, " +
  "<subject appearance, position, action>, <setting and light>, <camera motion as type + amplitude + speed, e.g. " +
  "the camera pushes in with small amplitude at slow speed>. [Shot 2] At 00:03.000, the camera cuts to ...' then " +
  "'overall_soundscape: <ambience, action sounds, non-verbal human sounds>' then 'non_diegetic_music: <genre, " +
  "instruments, tempo, dynamics, or N/A>'. Speakers get stable ids with a voice description, e.g. 'the calm, " +
  "slightly raspy baker (S1) says: <d>[English] First batch of the morning.</d>'; keep dialogue short enough to " +
  "speak in the time. " +
  "(B) With a start picture (image): the FIRST line must be exactly 'For the target video, at 0.00 seconds into the " +
  "target video, <Picture 1> (from [Shot 1]) is fully referenced.' then a blank line, then the three fields of (A), " +
  "where [Shot 1] starts from what <Picture 1> shows ('the young woman shown in <Picture 1> remains beside the " +
  "window, preserving her appearance, clothing and the layout') and develops forward. " +
  "(C) With reference pictures (references): <Picture N> is the N-th id in `references`. Write six sections " +
  "separated by blank lines: 'subject_definitions:' one line per reusable item, '<Subject 1> is the <thing> in " +
  "<Picture 1>, with <key visible features>.'; 'summary: [reference generation] <one short paragraph: what the " +
  "video shows and which subjects it uses>'; 'retention_analysis: <Subject 1> (appears in [Shot 1]): fully_preserved " +
  "- <what is kept>.'; 'detailed_description: <one or two sentences of overall style>. [Shot 1] ...' (as (A), but use " +
  "the <Subject N> labels at each appearance and restate their features; 350-500 words); 'overall_soundscape: ...'; " +
  "'non_diegetic_music: ...'. Use 'the shot begins from <Picture N>' only when a picture is a frame of the video. " +
  "LoRAs: pass them in `loras` (e.g. {\"hmnsfw\": 0.7}) rather than as <lora:...> tags in the prompt.";

const ID_HINT = "Pictures are named by id: att1, att2, ... are the user's attachments, img1, img2, ... generated ones.";

// Every model takes only its own sizes; the union is what the tool can offer.
const VIDEO_TOOL_SIZES = [...new Set(Object.values(VIDEO_PROFILES).flatMap((p) => p.sizes))];
const VIDEO_MIN_SECONDS = Math.min(...Object.values(VIDEO_PROFILES).map((p) => p.minSeconds));
const VIDEO_MAX_SECONDS = Math.max(...Object.values(VIDEO_PROFILES).map((p) => p.maxSeconds));

export const MEDIA_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: IMAGE_TOOL,
      description:
        "Generate new pictures from a text prompt with a diffusion model and show them to the user. " +
        "Write a detailed visual description in English: subject, setting, style, lighting, composition. " +
        "You see the pictures in your next turn.",
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
      name: EDIT_TOOL,
      description:
        "Change existing pictures (image to image): restyle, retouch, add or remove things, or combine up to " +
        `${MAX_EDIT_SOURCES} pictures into one. ${ID_HINT} The prompt says what to change, in English. ` +
        "You see the result in your next turn.",
      parameters: {
        type: "object",
        properties: {
          images: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_EDIT_SOURCES,
            description: "Ids of the source pictures, e.g. [\"att1\"] or [\"img2\", \"att1\"].",
          },
          prompt: { type: "string", description: "What to change, e.g. \"make it night, add snow on the roof\"." },
          size: {
            type: "string",
            enum: IMAGE_SIZES,
            description: "Optional WIDTHxHEIGHT; leave it out to keep the first source picture's shape.",
          },
          n: { type: "integer", minimum: 1, maximum: MAX_IMAGES, description: "Number of results, default 1." },
          negative_prompt: { type: "string", description: "Optional. What the result must not show." },
        },
        required: ["images", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: VIDEO_TOOL,
      description:
        "Generate a short video clip from a text prompt and show it to the user, optionally starting from a " +
        `picture (image to video, works with ltx and the minimax models) or using reference pictures (works with the ` +
        `minimax models). ${ID_HINT} For ltx, describe the scene, the motion and the camera in English. ` +
        H3_PROMPT_GUIDE + " Takes minutes; use it only when the user asks for a video.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The video prompt. ltx: a detailed English description of the scene, motion and camera. minimax models: " +
              "the structured MiniMax-H3 format from the tool description (fields, [Shot N], <d>[Language] ...</d>, " +
              "<Picture N> / <Subject N>).",
          },
          model: {
            type: "string",
            enum: Object.keys(VIDEO_PROFILES),
            description:
              "Video model; default: the one picked on the Video tab. " +
              Object.values(VIDEO_PROFILES).map((p) => p.describe).join("; "),
          },
          image: {
            type: "string",
            description: "Optional id of the picture the video starts from, e.g. \"img1\" (ltx and the minimax models).",
          },
          references: {
            type: "array",
            items: { type: "string" },
            description:
              "Up to 9 picture ids whose subjects, objects or style the video should use (MiniMax-H3 models only; " +
              "the pictures are shown to the model as <Picture 1>, <Picture 2>, ... in that order, so the prompt may refer to them).",
          },
          loras: {
            type: "object",
            additionalProperties: { type: "number" },
            description:
              "Optional LoRA name -> strength (minimax models only). Available: " +
              Object.entries(LORA_INFO).map(([k, v]) => `${k} (${v.note})`).join("; ") +
              ". Use one only when the user asks for what it is for.",
          },
          size: {
            type: "string",
            enum: VIDEO_TOOL_SIZES,
            description:
              "WIDTHxHEIGHT; each model takes only its own sizes (ltx default 960x544, minimax-h3 default 1152x640).",
          },
          seconds: {
            type: "number",
            minimum: VIDEO_MIN_SECONDS,
            maximum: VIDEO_MAX_SECONDS,
            description: "Clip length in seconds, default 5 (minimax-h3 is always 5.17 s).",
          },
        },
        required: ["prompt"],
      },
    },
  },
];

export function isMediaTool(name: string): boolean {
  return name === IMAGE_TOOL || name === EDIT_TOOL || name === VIDEO_TOOL;
}

/** Defaults taken from the Images and Video tabs, and the chat's pictures. */
export interface MediaToolContext {
  imageModel: string;
  imageSize: string;
  videoModel: string;
  videoSize: string;
  videoSeconds: number;
  /**
   * A model to load again once the media is done (the chat model). llama-swap
   * does it at the end of the job, after the last running job, so it happens
   * while a locked phone is not polling.
   */
  reloadModel?: string;
  /** The bytes of a picture by id (att1, img2), or null when there is no such picture. */
  resolveImage?: (id: string) => Promise<Blob | null>;
  /** Every picture id the chat has, for the error a wrong id gets. */
  imageIds?: () => string[];
  /** A fresh img id for a generated picture. */
  nextImageId?: () => string;
}

export interface ParsedImageArgs {
  kind: "image";
  prompt: string;
  size: string;
  n: number;
  negativePrompt?: string;
}
export interface ParsedEditArgs {
  kind: "edit";
  prompt: string;
  images: string[];
  size?: string;
  n: number;
  negativePrompt?: string;
}
export interface ParsedVideoArgs {
  kind: "video";
  prompt: string;
  model: string;
  size: string;
  seconds: number;
  extra: Record<string, unknown>;
  image?: string;
  /** Reference picture ids, de-duplicated, order kept. */
  references: string[];
}

function countArg(v: unknown): number {
  const raw = Number(v);
  return Number.isFinite(raw) ? Math.min(MAX_IMAGES, Math.max(1, Math.floor(raw))) : 1;
}

function textArg(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
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
): ParsedImageArgs | ParsedEditArgs | ParsedVideoArgs | { error: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
  if (!prompt) return { error: "the prompt is empty" };

  if (name === IMAGE_TOOL) {
    if (!ctx.imageModel) return { error: "no image model is selected on the Images tab" };
    const size = typeof a.size === "string" && IMAGE_SIZES.includes(a.size) ? a.size : ctx.imageSize;
    return { kind: "image", prompt, size, n: countArg(a.n), negativePrompt: textArg(a.negative_prompt) };
  }
  if (name === EDIT_TOOL) {
    if (!ctx.imageModel) return { error: "no image model is selected on the Images tab" };
    // A lone id where a list belongs is a common slip; take it.
    const raw = Array.isArray(a.images) ? a.images : typeof a.images === "string" ? [a.images] : typeof a.image === "string" ? [a.image] : [];
    const images = raw.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    if (images.length === 0) return { error: "edit_image needs at least one picture id in images" };
    if (images.length > MAX_EDIT_SOURCES) return { error: `edit_image takes at most ${MAX_EDIT_SOURCES} pictures` };
    const size = typeof a.size === "string" && IMAGE_SIZES.includes(a.size) ? a.size : undefined;
    return { kind: "edit", prompt, images, size, n: countArg(a.n), negativePrompt: textArg(a.negative_prompt) };
  }
  if (name === VIDEO_TOOL) {
    const model = typeof a.model === "string" && a.model in VIDEO_PROFILES ? a.model : ctx.videoModel;
    if (!model) return { error: "no video model is selected on the Video tab" };
    const profile = videoProfile(model);
    const size =
      typeof a.size === "string" && profile.sizes.includes(a.size)
        ? a.size
        : profile.sizes.includes(ctx.videoSize)
          ? ctx.videoSize
          : profile.defaultSize;
    const rawS = Number(a.seconds);
    const base = Number.isFinite(rawS) && rawS > 0 ? rawS : ctx.videoSeconds;
    const seconds = Math.min(profile.maxSeconds, Math.max(profile.minSeconds, base));
    const image = textArg(a.image);
    const references = [
      ...new Set(
        (Array.isArray(a.references) ? a.references : [])
          .filter((v): v is string => typeof v === "string" && v.trim() !== "")
          .map((v) => v.trim())
      ),
    ];
    if (references.length > 0 && profile.maxRefs === 0) {
      return { error: `${model} takes no reference pictures; use minimax-h3 or minimax-h3-ref` };
    }
    if (references.length > profile.maxRefs) {
      return { error: `${model} takes at most ${profile.maxRefs} reference pictures` };
    }
    if (image && references.length > 0) {
      return { error: "give either a start picture (image) or reference pictures (references), not both" };
    }
    if (image && !profile.startImage) {
      return {
        error: `${model} makes video from text only; call generate_video again without image, or with model "ltx" to start from a picture`,
      };
    }
    const loras: Record<string, number> = {};
    if (a.loras && typeof a.loras === "object" && !Array.isArray(a.loras)) {
      for (const [k, v] of Object.entries(a.loras as Record<string, unknown>)) {
        const w = Number(v);
        if (!Number.isFinite(w) || w === 0) continue;
        if (!profile.loras.includes(k)) {
          return {
            error: profile.loras.length
              ? `${model} has no LoRA "${k}"; available: ${profile.loras.join(", ")}`
              : `${model} takes no LoRAs; use minimax-h3 or minimax-h3-ref`,
          };
        }
        loras[k] = Math.max(-2, Math.min(2, w));
      }
    }
    const extra: Record<string, unknown> = { ...profile.extra };
    if (Object.keys(loras).length) {
      extra.loras = loras;
      const shift = Object.keys(loras).map((k) => LORA_INFO[k]?.shift).find((v) => v !== undefined);
      if (shift !== undefined && extra.shift === undefined) extra.shift = shift;
    }
    return { kind: "video", prompt, model, size, seconds, extra, image, references };
  }
  return { error: `unknown tool ${name}` };
}

/** The text the chat model gets back. */
export function mediaResultText(media: MediaInfo): string {
  const from = media.sources?.length ? ` from ${media.sources.join(", ")}` : "";
  const what =
    media.kind === "image"
      ? `${media.keys?.length ?? 0} picture(s)${media.ids?.length ? ` ${media.ids.join(", ")}` : ""}${from}, ${media.size ?? "the source's size"}`
      : `a ${media.seconds?.toFixed(1)} s video${from}, ${media.size}`;
  const seen = media.kind === "image" ? " You see them in your next turn." : "";
  switch (media.status) {
    case "done":
      return `${media.sources?.length && media.kind === "image" ? "Edited" : "Generated"} ${what} with ${media.model}. They are shown to the user.${seen} Prompt: ${media.prompt}`;
    case "cancelled":
      return "The user cancelled the generation.";
    case "error":
      return `Error: ${media.error ?? "the generation failed"}`;
    default:
      return "The generation is still running.";
  }
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

function extFor(type: string): string {
  return type.includes("jpeg") ? "jpg" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "png";
}

/** The source pictures' bytes, in order, or the error naming the ids that do not exist. */
async function resolveAll(ids: string[], ctx: MediaToolContext): Promise<File[] | { error: string }> {
  if (!ctx.resolveImage) return { error: "this chat cannot look pictures up" };
  const files: File[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const blob = await ctx.resolveImage(id);
    if (!blob) missing.push(id);
    else files.push(new File([blob], `${id}.${extFor(blob.type)}`, { type: blob.type || "image/png" }));
  }
  if (missing.length) {
    const known = ctx.imageIds?.() ?? [];
    return { error: `no picture ${missing.join(", ")}; the chat has ${known.length ? known.join(", ") : "no pictures"}` };
  }
  return files;
}

/** The job kind a media tool's jobId belongs to. */
function jobKindOf(media: MediaInfo): ImageJobKind {
  return media.jobKind ?? (media.kind === "video" ? "videos" : "images");
}

/**
 * Waits for a media job that already has a jobId and stores the result.
 * Used both right after the job starts and to resume one after a reload.
 * nextImageId names the generated pictures (img ids); without it they get none.
 */
export async function finishMediaTool(
  callId: string,
  media: MediaInfo,
  signal: AbortSignal,
  onUpdate: (m: MediaInfo) => void,
  nextImageId?: () => string
): Promise<MediaInfo> {
  const id = media.jobId!;
  const kind = jobKindOf(media);
  const onAbort = () => deleteImageJob(kind, id);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const keys: string[] = [];
    const ids: string[] = [];
    if (media.kind === "image") {
      const result = await waitForImageJob<ImageGenerationResponse>(kind, id, signal);
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
        if (nextImageId) ids.push(nextImageId());
      }
      if (keys.length === 0) throw new Error("the image model returned no pictures");
    } else {
      await waitForJob("videos", id, signal);
      const blob = await getJobContent("videos", id, signal);
      const key = `${callId}/0`;
      await putMedia(key, blob);
      keys.push(key);
    }
    const done: MediaInfo = { ...media, status: "done", keys, ...(ids.length ? { ids } : {}) };
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
      ? { kind: "image", jobKind: "images", status: "running", prompt: parsed.prompt, model: ctx.imageModel, size: parsed.size }
      : parsed.kind === "edit"
        ? { kind: "image", jobKind: "edits", status: "running", prompt: parsed.prompt, model: ctx.imageModel, size: parsed.size, sources: parsed.images }
        : {
            kind: "video",
            jobKind: "videos",
            status: "running",
            prompt: parsed.prompt,
            model: parsed.model,
            size: parsed.size,
            seconds: parsed.seconds,
            ...(parsed.image
              ? { sources: [parsed.image] }
              : parsed.references.length
                ? { sources: parsed.references }
                : {}),
          };
  onUpdate(media);

  const fail = (error: string) => {
    const ended: MediaInfo = { ...media, status: "error", error };
    onUpdate(ended);
    return ended;
  };

  try {
    if (parsed.kind === "image") {
      const body = buildImageRequest(ctx.imageModel, parsed.prompt, parsed.size, {
        n: parsed.n,
        negativePrompt: parsed.negativePrompt,
      });
      const job = await createImageJob("images", ctx.reloadModel ? { ...body, reload_model: ctx.reloadModel } : body, signal);
      media = { ...media, jobId: job.id };
    } else if (parsed.kind === "edit") {
      const files = await resolveAll(parsed.images, ctx);
      if ("error" in files) return fail(files.error);
      const form = new FormData();
      form.append("model", ctx.imageModel);
      form.append("prompt", parsed.prompt);
      if (parsed.n > 1) form.append("n", String(parsed.n));
      if (parsed.size) form.append("size", parsed.size);
      if (parsed.negativePrompt) form.append("negative_prompt", parsed.negativePrompt);
      for (const f of files) form.append("image[]", f);
      const job = await createFormServerJob("edits", form, ctx.reloadModel, signal);
      media = { ...media, jobId: job.id };
    } else {
      let start: File | null = null;
      if (parsed.image) {
        const files = await resolveAll([parsed.image], ctx);
        if ("error" in files) return fail(files.error);
        start = files[0];
      }
      let refs: File[] = [];
      if (parsed.references.length) {
        const files = await resolveAll(parsed.references, ctx);
        if ("error" in files) return fail(files.error);
        refs = files;
      }
      const profile = videoProfile(parsed.model);
      let form: FormData;
      if (profile.startImage === "input_reference") {
        form = buildVideoFormData(parsed.model, parsed.prompt, {
          size: parsed.size,
          seconds: parsed.seconds,
          advanced: parsed.extra,
        }, start);
      } else if (profile.startImage === "first_frame") {
        const task = start ? "i2va" : refs.length ? "ref2va" : undefined;
        form = buildVideoFormData(parsed.model, parsed.prompt, {
          size: parsed.size,
          seconds: parsed.seconds,
          advanced: { ...parsed.extra, task },
        }, null, start);
        refs.forEach((file, i) => form.append(`ref_image_${i + 1}`, file));
      } else {
        form = buildVideoFormData(parsed.model, parsed.prompt, {
          size: parsed.size,
          seconds: parsed.seconds,
          advanced: parsed.extra,
        }, null);
      }
      const job = await createFormServerJob("videos", form, ctx.reloadModel, signal);
      media = { ...media, jobId: job.id };
    }
  } catch (err) {
    if (isAbort(err)) {
      const ended: MediaInfo = { ...media, status: "cancelled" };
      onUpdate(ended);
      return ended;
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
  onUpdate(media);
  return finishMediaTool(callId, media, signal, onUpdate, ctx.nextImageId);
}
