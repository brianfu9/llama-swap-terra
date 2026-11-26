import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./mediaStore", () => ({ putMedia: vi.fn().mockResolvedValue("k") }));

import { putMedia } from "./mediaStore";
import { buildVideoFormData, videoSecondsField } from "./videoApi";
import {
  EDIT_TOOL,
  IMAGE_TOOL,
  MEDIA_TOOLS,
  VIDEO_TOOL,
  mediaResultText,
  parseMediaArgs,
  runMediaTool,
  type MediaToolContext,
  H3_PROMPT_GUIDE,
  H3_SECONDS,
} from "./mediaTools";
import type { MediaInfo } from "./types";

const ctx: MediaToolContext = {
  imageModel: "qwen-image",
  imageSize: "1536x1024",
  videoModel: "ltx",
  videoSize: "960x544",
  videoSeconds: 5,
};

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    blob: async () => new Blob(["v"], { type: "video/mp4" }),
  };
}

describe("MEDIA_TOOLS", () => {
  it("defines generate_image, edit_image and generate_video as OpenAI functions", () => {
    expect(MEDIA_TOOLS.map((t) => t.function.name)).toEqual([IMAGE_TOOL, EDIT_TOOL, VIDEO_TOOL]);
    const required = MEDIA_TOOLS.map((t) => (t.function.parameters as { required: string[] }).required);
    expect(required).toEqual([["prompt"], ["images", "prompt"], ["prompt"]]);
    for (const t of MEDIA_TOOLS) expect(t.type).toBe("function");
  });

  it("offers all video models in generate_video's model enum", () => {
    const video = MEDIA_TOOLS.find((t) => t.function.name === VIDEO_TOOL)!;
    const model = (video.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties.model!;
    expect(model.enum).toContain("ltx");
    expect(model.enum).toContain("minimax-h3");
    expect(model.enum).toContain("minimax-h3-ref");
  });
});

describe("parseMediaArgs", () => {
  it("fills image defaults from the Images tab", () => {
    expect(parseMediaArgs(IMAGE_TOOL, { prompt: " a cat " }, ctx)).toEqual({
      kind: "image", prompt: "a cat", size: "1536x1024", n: 1, negativePrompt: undefined,
    });
  });

  it("replaces a size the model cannot make and clamps n", () => {
    expect(parseMediaArgs(IMAGE_TOOL, { prompt: "x", size: "1000x1000", n: 99, negative_prompt: "blur" }, ctx)).toEqual({
      kind: "image", prompt: "x", size: "1536x1024", n: 4, negativePrompt: "blur",
    });
  });

  it("clamps video seconds and keeps a listed size", () => {
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", size: "544x960", seconds: 30 }, ctx)).toMatchObject({
      kind: "video", prompt: "waves", size: "544x960", seconds: 6.7,
    });
  });

  it("refuses an empty prompt, a missing model and an unknown tool", () => {
    expect(parseMediaArgs(IMAGE_TOOL, { prompt: "  " }, ctx)).toHaveProperty("error");
    expect(parseMediaArgs(IMAGE_TOOL, { prompt: "x" }, { ...ctx, imageModel: "" })).toEqual({
      error: "no image model is selected on the Images tab",
    });
    expect(parseMediaArgs("rm_rf", { prompt: "x" }, ctx)).toHaveProperty("error");
  });
});

describe("parseMediaArgs for edits and image to video", () => {
  it("takes picture ids, a lone id, and leaves the size to the source", () => {
    expect(parseMediaArgs(EDIT_TOOL, { prompt: "night", images: ["att1", "img2"] }, ctx)).toEqual({
      kind: "edit", prompt: "night", images: ["att1", "img2"], size: undefined, n: 1, negativePrompt: undefined,
    });
    expect(parseMediaArgs(EDIT_TOOL, { prompt: "night", images: "att1" }, ctx)).toMatchObject({ images: ["att1"] });
    expect(parseMediaArgs(EDIT_TOOL, { prompt: "night", images: [] }, ctx)).toHaveProperty("error");
    expect(parseMediaArgs(EDIT_TOOL, { prompt: "x", images: ["a", "b", "c", "d"] }, ctx)).toHaveProperty("error");
  });

  it("passes a video's start picture", () => {
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", image: "img1" }, ctx)).toMatchObject({ kind: "video", image: "img1" });
  });
});

describe("LoRAs and the MiniMax-H3 prompt format", () => {
  it("sends hmnsfw with the shift its author asks for", () => {
    const r = parseMediaArgs(VIDEO_TOOL, { prompt: "p", model: "minimax-h3", loras: { hmnsfw: 0.7 } }, ctx);
    expect(r).toMatchObject({ kind: "video", extra: { loras: { hmnsfw: 0.7 }, shift: 6 } });
  });
  it("refuses a LoRA the model does not have", () => {
    const r = parseMediaArgs(VIDEO_TOOL, { prompt: "p", model: "minimax-h3", loras: { nope: 1 } }, ctx);
    expect("error" in r && r.error).toContain('no LoRA "nope"');
  });
  it("refuses LoRAs on ltx", () => {
    const r = parseMediaArgs(VIDEO_TOOL, { prompt: "p", model: "ltx", loras: { hmnsfw: 0.7 } }, ctx);
    expect("error" in r && r.error).toContain("takes no LoRAs");
  });
  it("leaves extra alone without LoRAs", () => {
    const r = parseMediaArgs(VIDEO_TOOL, { prompt: "p", model: "minimax-h3" }, ctx);
    expect(r).toMatchObject({ extra: { latent_upscale: 2 } });
    expect("extra" in r && r.extra).not.toHaveProperty("loras");
  });
  it("teaches the start-picture instruction and the reference labels", () => {
    expect(H3_PROMPT_GUIDE).toContain(
      "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."
    );
    expect(H3_PROMPT_GUIDE).toContain("<Subject 1> is the");
    expect(H3_PROMPT_GUIDE).toContain("<d>[English]");
    const video = MEDIA_TOOLS.find((t) => t.function.name === VIDEO_TOOL)!;
    expect(video.function.description).toContain("integrated_multimodal_description");
    expect(JSON.stringify(video.function.parameters)).toContain("hmnsfw");
  });
});

describe("parseMediaArgs for video models", () => {
  it("falls back to minimax-h3's default size and clamps seconds to its range", () => {
    expect(
      parseMediaArgs(
        VIDEO_TOOL,
        { prompt: "waves", model: "minimax-h3", size: "1280x704", seconds: 3 },
        { ...ctx, videoSize: "1664x896" }
      )
    ).toEqual({
      kind: "video", prompt: "waves", model: "minimax-h3", size: "1152x640", seconds: H3_SECONDS,
      extra: { latent_upscale: 2, num_inference_steps: 20, sampler: "res_multistep" }, image: undefined, references: [],
    });
  });

  it("sends minimax-h3 a length the engine reads as its 7 chunks", () => {
    // Radiance videos.cpp: frames = ceil(s * 24 - 1e-9), chunks = ceil((frames - 5) / 17), refused above 7.
    for (const seconds of [3, 5, 5.17, 6.7, undefined]) {
      const parsed = parseMediaArgs(VIDEO_TOOL, { prompt: "waves", model: "minimax-h3", seconds }, ctx);
      const s = (parsed as { seconds: number }).seconds;
      const frames = Math.ceil(Number(videoSecondsField(s)) * 24 - 1e-9);
      expect(Math.ceil((frames - 5) / 17)).toBe(7);
    }
  });

  it("accepts a start picture for minimax-h3", () => {
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", model: "minimax-h3", image: "img1" }, ctx)).toMatchObject({
      kind: "video", image: "img1",
    });
  });

  it("defaults to the Video tab's model (ltx) with the old behaviour", () => {
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", image: "img1" }, ctx)).toEqual({
      kind: "video", prompt: "waves", model: "ltx", size: "960x544", seconds: 5, extra: {}, image: "img1", references: [],
    });
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", seconds: 0.5 }, ctx)).toMatchObject({ seconds: 0.7 });
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", seconds: 9 }, ctx)).toMatchObject({ seconds: 6.7 });
  });

  it("keeps the tab's size when it is one the selected model can make", () => {
    const out = parseMediaArgs(VIDEO_TOOL, { prompt: "waves" }, { ...ctx, videoModel: "minimax-h3", videoSize: "960x544" });
    expect(out).toMatchObject({ model: "minimax-h3", size: "960x544" });
  });
});

describe("parseMediaArgs for video reference pictures", () => {
  it("parses minimax-h3 references, de-duplicating and keeping order", () => {
    const out = parseMediaArgs(
      VIDEO_TOOL,
      { prompt: "waves", model: "minimax-h3", references: ["img1", "img2", "img1"] },
      ctx
    );
    expect(out).toMatchObject({ kind: "video", references: ["img1", "img2"] });
  });

  it("ignores non-string reference entries", () => {
    const out = parseMediaArgs(
      VIDEO_TOOL,
      { prompt: "waves", model: "minimax-h3", references: ["img1", 2, ""] },
      ctx
    );
    expect(out).toMatchObject({ references: ["img1"] });
  });

  it("refuses reference pictures for ltx", () => {
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", model: "ltx", references: ["img1"] }, ctx)).toEqual({
      error: "ltx takes no reference pictures; use minimax-h3 or minimax-h3-ref",
    });
  });

  it("refuses more reference pictures than the model allows", () => {
    const refs = Array.from({ length: 10 }, (_, i) => `img${i + 1}`);
    expect(
      parseMediaArgs(VIDEO_TOOL, { prompt: "waves", model: "minimax-h3", references: refs }, ctx)
    ).toEqual({ error: "minimax-h3 takes at most 9 reference pictures" });
  });

  it("refuses a start picture and reference pictures together", () => {
    expect(
      parseMediaArgs(
        VIDEO_TOOL,
        { prompt: "waves", model: "minimax-h3", image: "img1", references: ["img2"] },
        ctx
      )
    ).toEqual({ error: "give either a start picture (image) or reference pictures (references), not both" });
  });
});

describe("mediaResultText", () => {
  it("tells the model what was shown", () => {
    const m: MediaInfo = { kind: "image", status: "done", prompt: "a cat", model: "qwen-image", size: "1024x1024", keys: ["a", "b"] };
    expect(mediaResultText(m)).toBe(
      "Generated 2 picture(s), 1024x1024 with qwen-image. They are shown to the user. You see them in your next turn. Prompt: a cat"
    );
    expect(mediaResultText({ ...m, ids: ["img3", "img4"], sources: ["att1"] })).toBe(
      "Edited 2 picture(s) img3, img4 from att1, 1024x1024 with qwen-image. They are shown to the user. You see them in your next turn. Prompt: a cat"
    );
    expect(mediaResultText({ ...m, status: "error", error: "boom" })).toBe("Error: boom");
  });
});

describe("runMediaTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(putMedia).mockClear();
  });

  it("runs an image through /api/jobs and stores each picture", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_1", status: "running" }))
      .mockResolvedValueOnce(reply(200, { status: "succeeded", result: { data: [{ b64_json: "AAAA" }, { b64_json: "AAAA" }] } }));
    vi.stubGlobal("fetch", f);
    const updates: MediaInfo[] = [];
    const out = await runMediaTool("call_1", IMAGE_TOOL, '{"prompt":"a cat","n":2}', ctx, new AbortController().signal, (m) =>
      updates.push(m)
    );
    expect(out.status).toBe("done");
    expect(out.keys).toEqual(["call_1/0", "call_1/1"]);
    expect(f.mock.calls[0][0]).toBe("/api/jobs/images");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ model: "qwen-image", prompt: "a cat", n: 2, size: "1536x1024" });
    expect(updates.map((u) => u.status)).toEqual(["running", "running", "done"]);
    expect(updates[1].jobId).toBe("job_1");
    expect(putMedia).toHaveBeenCalledTimes(2);
  });

  it("asks the image job to reload the chat model", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_1" }))
      .mockResolvedValueOnce(reply(200, { status: "succeeded", result: { data: [{ b64_json: "AAAA" }] } }));
    vi.stubGlobal("fetch", f);
    await runMediaTool("call_5", IMAGE_TOOL, '{"prompt":"x"}', { ...ctx, reloadModel: "rad" }, new AbortController().signal, () => {});
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ model: "qwen-image", reload_model: "rad" });
  });

  it("runs a video as a llama-swap job and stores the clip", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_v", status: "running" }))
      .mockResolvedValueOnce(reply(200, { id: "job_v", status: "succeeded", content_type: "video/mp4" }))
      .mockResolvedValueOnce(reply(200, {}));
    vi.stubGlobal("fetch", f);
    const out = await runMediaTool("call_2", VIDEO_TOOL, '{"prompt":"waves"}', { ...ctx, reloadModel: "rad" }, new AbortController().signal, () => {});
    expect(out).toMatchObject({ status: "done", keys: ["call_2/0"], jobId: "job_v", model: "ltx", size: "960x544", seconds: 5 });
    expect(f.mock.calls[0][0]).toBe("/api/jobs/videos?reload_model=rad");
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("ltx");
    expect(form.get("size")).toBe("960x544");
    expect(f.mock.calls[1][0]).toBe("/api/jobs/videos/job_v");
    expect(f.mock.calls[2][0]).toBe("/api/jobs/videos/job_v/content");
    expect(putMedia).toHaveBeenCalledTimes(1);
  });

  it("edits pictures through /api/jobs/edits and names the results", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_e" }))
      .mockResolvedValueOnce(reply(200, { status: "succeeded", result: { data: [{ b64_json: "AAAA" }] } }));
    vi.stubGlobal("fetch", f);
    const resolveImage = vi.fn(async (id: string) => (id === "att1" ? new Blob(["png"], { type: "image/png" }) : null));
    let n = 4;
    const out = await runMediaTool(
      "call_6", EDIT_TOOL, '{"prompt":"make it night","images":["att1"]}',
      { ...ctx, reloadModel: "rad", resolveImage, nextImageId: () => `img${++n}` },
      new AbortController().signal, () => {}
    );
    expect(out).toMatchObject({ status: "done", jobKind: "edits", sources: ["att1"], ids: ["img5"], keys: ["call_6/0"] });
    expect(f.mock.calls[0][0]).toBe("/api/jobs/edits?reload_model=rad");
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get("model")).toBe("qwen-image");
    expect(form.get("prompt")).toBe("make it night");
    expect((form.get("image[]") as File).name).toBe("att1.png");
    expect(form.get("size")).toBeNull();
    expect(f.mock.calls[1][0]).toBe("/api/jobs/edits/job_e");
  });

  it("sends a video's start picture as input_reference", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_v" }))
      .mockResolvedValueOnce(reply(200, { status: "succeeded" }))
      .mockResolvedValueOnce(reply(200, {}));
    vi.stubGlobal("fetch", f);
    const resolveImage = async () => new Blob(["png"], { type: "image/png" });
    const out = await runMediaTool("call_7", VIDEO_TOOL, '{"prompt":"waves","image":"img1"}', { ...ctx, resolveImage }, new AbortController().signal, () => {});
    expect(out).toMatchObject({ status: "done", sources: ["img1"] });
    expect(((f.mock.calls[0][1].body as FormData).get("input_reference") as File).name).toBe("img1.png");
  });

  it("sends a minimax start picture as first_frame with task i2va", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_v" }))
      .mockResolvedValueOnce(reply(200, { status: "succeeded" }))
      .mockResolvedValueOnce(reply(200, {}));
    vi.stubGlobal("fetch", f);
    const resolveImage = async () => new Blob(["png"], { type: "image/png" });
    const out = await runMediaTool(
      "call_9",
      VIDEO_TOOL,
      '{"prompt":"waves","model":"minimax-h3","image":"img1"}',
      { ...ctx, resolveImage },
      new AbortController().signal,
      () => {}
    );
    expect(out).toMatchObject({ status: "done", sources: ["img1"] });
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get("task")).toBe("i2va");
    expect((form.get("first_frame") as File).name).toBe("img1.png");
    expect(form.get("input_reference")).toBeNull();
    expect(form.get("ref_image_1")).toBeNull();
    // A keyframe pins a frame at its size; Radiance refuses latent_upscale alongside it (400),
    // so it is dropped while the step and sampler recipe stays.
    expect(form.get("latent_upscale")).toBeNull();
    expect(form.get("num_inference_steps")).toBe("20");
    expect(form.get("sampler")).toBe("res_multistep");
  });

  it("keeps latent_upscale for text-only minimax-h3", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_v" }))
      .mockResolvedValueOnce(reply(200, { status: "succeeded" }))
      .mockResolvedValueOnce(reply(200, {}));
    vi.stubGlobal("fetch", f);
    await runMediaTool(
      "call_11",
      VIDEO_TOOL,
      '{"prompt":"waves","model":"minimax-h3"}',
      ctx,
      new AbortController().signal,
      () => {}
    );
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get("latent_upscale")).toBe("2");
    expect(form.get("task")).toBeNull();
    expect(form.get("first_frame")).toBeNull();
  });

  it("sends minimax reference pictures as ref_image_1..n with task ref2va", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(202, { id: "job_v" }))
      .mockResolvedValueOnce(reply(200, { status: "succeeded" }))
      .mockResolvedValueOnce(reply(200, {}));
    vi.stubGlobal("fetch", f);
    const resolveImage = async () => new Blob(["png"], { type: "image/png" });
    const out = await runMediaTool(
      "call_10",
      VIDEO_TOOL,
      '{"prompt":"waves","model":"minimax-h3","references":["img1","img2"]}',
      { ...ctx, resolveImage },
      new AbortController().signal,
      () => {}
    );
    expect(out).toMatchObject({ status: "done", sources: ["img1", "img2"] });
    const form = f.mock.calls[0][1].body as FormData;
    expect(form.get("task")).toBe("ref2va");
    expect((form.get("ref_image_1") as File).name).toBe("img1.png");
    expect((form.get("ref_image_2") as File).name).toBe("img2.png");
    expect(form.get("first_frame")).toBeNull();
    // Reference pictures are not keyframes, so the two-stage recipe stays.
    expect(form.get("latent_upscale")).toBe("2");
  });

  it("names the pictures the chat has when an id is wrong", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await runMediaTool(
      "call_8", EDIT_TOOL, '{"prompt":"x","images":["img9"]}',
      { ...ctx, resolveImage: async () => null, imageIds: () => ["att1", "img1"] },
      new AbortController().signal, () => {}
    );
    expect(out.status).toBe("error");
    expect(out.error).toBe("no picture img9; the chat has att1, img1");
    expect(f).not.toHaveBeenCalled();
  });

  it("reports bad arguments without calling the server", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await runMediaTool("call_3", IMAGE_TOOL, "{not json", ctx, new AbortController().signal, () => {});
    expect(out.status).toBe("error");
    expect(f).not.toHaveBeenCalled();
  });

  it("reports a failed image job", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(reply(202, { id: "job_1" }))
        .mockResolvedValueOnce(reply(200, { status: "failed", status_code: 400, error: "bad size" }))
    );
    const out = await runMediaTool("call_4", IMAGE_TOOL, '{"prompt":"x"}', ctx, new AbortController().signal, () => {});
    expect(out).toMatchObject({ status: "error" });
    expect(out.error).toContain("bad size");
  });
});

describe("buildVideoFormData", () => {
  it("drops latent_upscale when a start picture pins the first frame, keeps it otherwise", () => {
    const img = new File(["png"], "a.png", { type: "image/png" });
    const withReference = buildVideoFormData("ltx", "waves", { advanced: { latent_upscale: 2 } }, img);
    expect(withReference.get("input_reference")).toBe(img);
    expect(withReference.get("latent_upscale")).toBeNull();
    const withKeyframe = buildVideoFormData("minimax-h3", "waves", { advanced: { latent_upscale: 2 } }, null, img);
    expect(withKeyframe.get("first_frame")).toBe(img);
    expect(withKeyframe.get("latent_upscale")).toBeNull();
    const textOnly = buildVideoFormData("minimax-h3", "waves", { advanced: { latent_upscale: 2 } });
    expect(textOnly.get("latent_upscale")).toBe("2");
  });
});
