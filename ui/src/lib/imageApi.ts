import type { ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResponse } from "./types";
import { playgroundSessionHeaders } from "./playgroundSession";

export function buildImageRequest(
  model: string,
  prompt: string,
  size: string,
  options: ImageGenerationOptions = {}
): ImageGenerationRequest {
  const request: ImageGenerationRequest = {
    model,
    prompt,
    n: options.n && options.n > 1 ? Math.floor(options.n) : 1,
    size,
  };
  // terra fork: a field is sent only when set, so a model that refuses it (Turbo refuses a step count) is unaffected.
  if (options.seed !== undefined && options.seed >= 0) request.seed = Math.floor(options.seed);
  if (options.steps && options.steps > 0) request.num_inference_steps = Math.floor(options.steps);
  if (options.negativePrompt && options.negativePrompt.trim()) request.negative_prompt = options.negativePrompt.trim();
  if (options.trueCfgScale && options.trueCfgScale > 1 && request.negative_prompt) request.true_cfg_scale = options.trueCfgScale;
  return request;
}

export async function generateImage(
  model: string,
  prompt: string,
  size: string,
  signal?: AbortSignal,
  options: ImageGenerationOptions = {}
): Promise<ImageGenerationResponse> {
  const request = buildImageRequest(model, prompt, size, options);

  const response = await fetch("/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...playgroundSessionHeaders,
    },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}
