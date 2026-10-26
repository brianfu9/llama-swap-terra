import { afterEach, describe, expect, it, vi } from "vitest";
import { generateImage } from "./imageApi";

// terra fork: the OpenAI-mode settings are sent only when set.
function lastBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}
function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ created: 0, data: [] }) });
}

describe("generateImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only model, prompt, n and size by default", async () => {
    const f = okFetch(); vi.stubGlobal("fetch", f);
    await generateImage("m", "p", "1024x1024");
    expect(lastBody(f)).toEqual({ model: "m", prompt: "p", n: 1, size: "1024x1024" });
  });

  it("leaves -1 seed, 0 steps, empty negative and cfg unset", async () => {
    const f = okFetch(); vi.stubGlobal("fetch", f);
    await generateImage("m", "p", "1024x1024", undefined, { n: 1, seed: -1, steps: 0, negativePrompt: " ", trueCfgScale: 4 });
    expect(lastBody(f)).toEqual({ model: "m", prompt: "p", n: 1, size: "1024x1024" });
  });

  it("sends seed, steps, n, negative prompt and true_cfg_scale when set", async () => {
    const f = okFetch(); vi.stubGlobal("fetch", f);
    await generateImage("m", "p", "2048x2048", undefined, { n: 3, seed: 7, steps: 40, negativePrompt: "blur", trueCfgScale: 4 });
    expect(lastBody(f)).toEqual({
      model: "m", prompt: "p", n: 3, size: "2048x2048", seed: 7, num_inference_steps: 40, negative_prompt: "blur", true_cfg_scale: 4,
    });
  });
});
