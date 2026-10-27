import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./mediaStore", () => ({ putMedia: vi.fn().mockResolvedValue("k") }));

import { putMedia } from "./mediaStore";
import {
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
  it("defines generate_image and generate_video as OpenAI functions", () => {
    expect(MEDIA_TOOLS.map((t) => t.function.name)).toEqual([IMAGE_TOOL, VIDEO_TOOL]);
    for (const t of MEDIA_TOOLS) {
      expect(t.type).toBe("function");
      expect((t.function.parameters as { required: string[] }).required).toEqual(["prompt"]);
    }
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

describe("mediaResultText", () => {
  it("tells the model what was shown", () => {
    const m: MediaInfo = { kind: "image", status: "done", prompt: "a cat", model: "qwen-image", size: "1024x1024", keys: ["a", "b"] };
    expect(mediaResultText(m)).toBe("Generated 2 picture(s), 1024x1024 with qwen-image. They are shown to the user. Prompt: a cat");
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

  it("runs a video through /v1/videos and stores the clip", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { id: "vid_1", status: "queued" }))
      .mockResolvedValueOnce(reply(200, { id: "vid_1", status: "completed" }))
      .mockResolvedValueOnce(reply(200, {}));
    vi.stubGlobal("fetch", f);
    const out = await runMediaTool("call_2", VIDEO_TOOL, '{"prompt":"waves"}', ctx, new AbortController().signal, () => {});
    expect(out).toMatchObject({ status: "done", keys: ["call_2/0"], jobId: "vid_1", model: "ltx", size: "960x544", seconds: 5 });
    expect(f.mock.calls[0][0]).toBe("/v1/videos");
    expect(f.mock.calls[1][0]).toBe("/v1/videos/vid_1?model=ltx");
    expect(f.mock.calls[2][0]).toBe("/v1/videos/vid_1/content?model=ltx");
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
