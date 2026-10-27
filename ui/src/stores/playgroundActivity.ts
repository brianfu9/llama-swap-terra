import { writable, derived } from "svelte/store";

const chatStreaming = writable(false);
const imageGenerating = writable(false);
const videoGenerating = writable(false);

/**
 * The Docs Agent's flag. It is not part of playgroundActivity: Help is its own
 * page, so its sidebar link is the one that should show the work.
 */
export const docsAgentStreaming = writable(false);

export const playgroundActivity = derived(
  [chatStreaming, imageGenerating, videoGenerating],
  ([$chat, $image, $video]) => $chat || $image || $video
);

export const playgroundStores = {
  chatStreaming,
  imageGenerating,
  videoGenerating,
};
