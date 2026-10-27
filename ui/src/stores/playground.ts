import { get } from "svelte/store";
import { persistentStore } from "./persistent";

export type PlaygroundTab = "chat" | "images" | "video";

export const playgroundTabs: { id: PlaygroundTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "images", label: "Images" },
  { id: "video", label: "Video" },
];

export const selectedPlaygroundTab = persistentStore<PlaygroundTab>("playground-selected-tab", "chat");

/**
 * Drop a stored tab that no longer exists.
 *
 * "docs" was a tab here until Help became its own page; terra fork: speech,
 * audio, rerank and concurrency were dropped too. A browser that last
 * left the Playground on it would select a tab with nothing behind it: every
 * panel hidden, and a header reading "Playground /".
 */
export function resetUnknownPlaygroundTab(): void {
  if (!playgroundTabs.some((tab) => tab.id === get(selectedPlaygroundTab))) {
    selectedPlaygroundTab.set(playgroundTabs[0].id);
  }
}

resetUnknownPlaygroundTab();
