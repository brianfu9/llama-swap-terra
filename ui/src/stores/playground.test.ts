import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import {
  playgroundTabs,
  resetUnknownPlaygroundTab,
  selectedPlaygroundTab,
  type PlaygroundTab,
} from "./playground";

// "docs" was the Help tab. It is a page of its own now, so a browser that
// still has it stored would open the Playground on a tab that no longer
// exists: every panel hidden, and a header reading "Playground /".
const removedTab = "docs" as unknown as PlaygroundTab;

describe("selectedPlaygroundTab", () => {
  it("falls back to the first tab when the stored one was removed", () => {
    selectedPlaygroundTab.set(removedTab);
    resetUnknownPlaygroundTab();
    expect(get(selectedPlaygroundTab)).toBe(playgroundTabs[0].id);
  });

  it("leaves a tab that still exists alone", () => {
    selectedPlaygroundTab.set("video");
    resetUnknownPlaygroundTab();
    expect(get(selectedPlaygroundTab)).toBe("video");
  });

  it("offers only chat, images and video (terra fork)", () => {
    expect(playgroundTabs.map((tab) => tab.id)).toEqual(["chat", "images", "video"]);
  });

  it("no longer offers Help as a tab", () => {
    expect(playgroundTabs.map((tab) => tab.id)).not.toContain("docs");
    expect(playgroundTabs.map((tab) => tab.label)).not.toContain("Help");
  });
});
