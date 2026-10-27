import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./mediaStore", () => ({ putMedia: vi.fn().mockResolvedValue("k") }));

import { putMedia } from "./mediaStore";
import {
  EDIT_TOOL,
  IMAGE_TOOL,
  MEDIA_TOOLS,
  VIDEO_TOOL,
  mediaResultText,
  parseMediaArgs,
  runMediaTool,
  type MediaToolContext,
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
    expect(parseMediaArgs(VIDEO_TOOL, { prompt: "waves", size: "544x960", seconds: 30 }, ctx)).toEqual({
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
