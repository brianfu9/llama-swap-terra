import { playgroundSessionHeaders } from "./playgroundSession";

/**
 * terra fork: client for llama-swap's /api/jobs (internal/server/jobs.go).
 *
 * A job runs a synchronous image request inside llama-swap, so the picture
 * is still made when a phone locks or the browser drops the page. The client
 * keeps the job id and fetches the result when it comes back.
 */
export type ImageJobKind = "images" | "sdapi-txt2img" | "videos";

export interface ImageJob<T = unknown> {
  id: string;
  kind: ImageJobKind;
  model: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  created_at: string;
  finished_at?: string;
  status_code?: number;
  error?: string;
  result?: T;
}

/** Thrown when the server no longer has the job (expired, or llama-swap restarted). */
export class ImageJobGoneError extends Error {
  constructor(id: string) {
    super(`The image job ${id} is gone (it expired or llama-swap restarted)`);
    this.name = "ImageJobGoneError";
  }
}

const POLL_INTERVAL_MS = 1500;

function jobUrl(kind: ImageJobKind, id: string): string {
  return `/api/jobs/${kind}/${encodeURIComponent(id)}`;
}

export async function createImageJob(kind: ImageJobKind, body: object, signal?: AbortSignal): Promise<ImageJob> {
  const response = await fetch(`/api/jobs/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...playgroundSessionHeaders },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Image job error: ${response.status} - ${await response.text()}`);
  }
  return response.json();
}

export async function getImageJob<T>(kind: ImageJobKind, id: string, signal?: AbortSignal): Promise<ImageJob<T>> {
  const response = await fetch(jobUrl(kind, id), { headers: playgroundSessionHeaders, signal, cache: "no-store" });
  if (response.status === 404) throw new ImageJobGoneError(id);
  if (!response.ok) {
    throw new Error(`Image job error: ${response.status} - ${await response.text()}`);
  }
  return response.json();
}

/**
 * Starts a video job from a /v1/videos form. llama-swap holds the video model
 * for the whole job, so another client cannot swap it out mid-video, and
 * loads reloadModel again once the clip is done.
 */
export async function createVideoServerJob(form: FormData, reloadModel?: string, signal?: AbortSignal): Promise<ImageJob> {
  const query = reloadModel ? `?reload_model=${encodeURIComponent(reloadModel)}` : "";
  const response = await fetch(`/api/jobs/videos${query}`, {
    method: "POST",
    headers: playgroundSessionHeaders,
    body: form,
    signal,
  });
  if (!response.ok) {
    throw new Error(`Video job error: ${response.status} - ${await response.text()}`);
  }
  return response.json();
}

/** A finished job's result bytes (a video job's clip). */
export async function getJobContent(kind: ImageJobKind, id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${jobUrl(kind, id)}/content`, { headers: playgroundSessionHeaders, signal });
  if (response.status === 404) throw new ImageJobGoneError(id);
  if (!response.ok) {
    throw new Error(`Job content error: ${response.status} - ${await response.text()}`);
  }
  return response.blob();
}

/** Cancels a running job, or forgets a finished one. A missing job is not an error. */
export async function deleteImageJob(kind: ImageJobKind, id: string): Promise<void> {
  try {
    await fetch(jobUrl(kind, id), { method: "DELETE", headers: playgroundSessionHeaders });
  } catch {
    // Best effort: an unreachable server drops the job on its own.
  }
}

function sleepUnlessVisible(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const doc = typeof document === "undefined" ? null : document;
    const done = () => {
      clearTimeout(timer);
      doc?.removeEventListener("visibilitychange", onVisible);
      signal.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    // Coming back to the page polls at once instead of after a throttled timer.
    const onVisible = () => {
      if (doc?.visibilityState === "visible") {
        done();
        resolve();
      }
    };
    const onAbort = () => {
      done();
      reject(new DOMException("Aborted", "AbortError"));
    };
    doc?.addEventListener("visibilitychange", onVisible);
    signal.addEventListener("abort", onAbort);
  });
}

/**
 * Polls a job until it ends and returns its result. A failed poll (the phone
 * was asleep, the network dropped) is retried, not reported: the job runs on
 * regardless. Throws for a failed or cancelled job and when the job is gone.
 */
export async function waitForImageJob<T>(kind: ImageJobKind, id: string, signal: AbortSignal): Promise<T> {
  const job = await waitForJob<T>(kind, id, signal);
  if (job.result === undefined) throw new Error("The image job finished without a JSON result");
  return job.result;
}

/** Polls a job until it succeeds and returns it; throws as waitForImageJob does. */
export async function waitForJob<T>(kind: ImageJobKind, id: string, signal: AbortSignal): Promise<ImageJob<T>> {
  for (;;) {
    let job: ImageJob<T> | null = null;
    try {
      job = await getImageJob<T>(kind, id, signal);
    } catch (err) {
      if (err instanceof ImageJobGoneError || (err instanceof Error && err.name === "AbortError")) throw err;
    }
    if (job) {
      if (job.status === "succeeded") return job;
      if (job.status === "failed") {
        throw new Error(`${kind === "videos" ? "Video" : "Image"} API error: ${job.status_code ?? ""} - ${job.error ?? "unknown error"}`);
      }
      if (job.status === "cancelled") throw new DOMException("Cancelled", "AbortError");
    }
    await sleepUnlessVisible(POLL_INTERVAL_MS, signal);
  }
}
