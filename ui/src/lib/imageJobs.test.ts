import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageJobGoneError, createImageJob, waitForImageJob } from "./imageJobs";

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("imageJobs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("creates a job with a POST to /api/jobs/{kind}", async () => {
    const f = vi.fn().mockResolvedValue(reply(202, { id: "job_1", status: "running" }));
    vi.stubGlobal("fetch", f);
    const job = await createImageJob("images", { model: "m", prompt: "p" });
    expect(job.id).toBe("job_1");
    expect(f.mock.calls[0][0]).toBe("/api/jobs/images");
    expect(f.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ model: "m", prompt: "p" });
  });

  it("keeps polling through network errors and returns the result", async () => {
    vi.useFakeTimers();
    const f = vi
      .fn()
      .mockResolvedValueOnce(reply(200, { id: "job_1", status: "running" }))
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(reply(200, { id: "job_1", status: "succeeded", result: { data: [{ b64_json: "AA" }] } }));
    vi.stubGlobal("fetch", f);
    const done = waitForImageJob("images", "job_1", new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(done).resolves.toEqual({ data: [{ b64_json: "AA" }] });
    expect(f).toHaveBeenCalledTimes(3);
    expect(f.mock.calls[0][0]).toBe("/api/jobs/images/job_1");
  });

  it("reports a failed job with its upstream error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, { status: "failed", status_code: 400, error: "bad size" })));
    await expect(waitForImageJob("images", "job_1", new AbortController().signal)).rejects.toThrow("400 - bad size");
  });

  it("reports a job the server no longer has", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(404, "job not found")));
    await expect(waitForImageJob("images", "job_1", new AbortController().signal)).rejects.toBeInstanceOf(ImageJobGoneError);
  });

  it("treats a cancelled job as an abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, { status: "cancelled" })));
    await expect(waitForImageJob("images", "job_1", new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
