import { describe, expect, it } from "vitest";
import { attachments, maxImageNumber, messagesForModel, pictureIds } from "./chatMedia";
import type { ChatMessage } from "./types";

const img = (url: string) => ({ type: "image_url" as const, image_url: { url } });

const chat: ChatMessage[] = [
  { role: "user", content: [{ type: "text", text: "edit this" }, img("data:a"), img("data:b")] },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "edit_image", arguments: "{}" } }] },
  {
    role: "tool", tool_call_id: "c1", name: "edit_image", content: "Edited",
    media: { kind: "image", status: "done", prompt: "p", model: "m", keys: ["c1/0", "c1/1"], ids: ["img1", "img2"], sources: ["att1"] },
  },
  { role: "user", content: [{ type: "text", text: "and this" }, img("data:c")] },
];

describe("chatMedia", () => {
  it("numbers attachments in message order and lists every picture id", () => {
    expect(attachments(chat).map((a) => [a.id, a.url, a.msgIndex])).toEqual([
      ["att1", "data:a", 0], ["att2", "data:b", 0], ["att3", "data:c", 3],
    ]);
    expect(pictureIds(chat)).toEqual(["att1", "att2", "att3", "img1", "img2"]);
    expect(maxImageNumber(chat)).toBe(2);
  });

  it("labels attachments and shows the model the pictures its tools made", async () => {
    const out = await messagesForModel(chat, async (key) => (key === "c1/1" ? null : `data:jpeg-${key}`));
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "user"]);
    expect(out[0].content).toEqual([{ type: "text", text: "[Attached pictures: att1, att2]" }, { type: "text", text: "edit this" }, img("data:a"), img("data:b")]);
    // c1/1 could not be loaded, so only img1 is shown.
    expect(out[3].content).toEqual([
      { type: "text", text: "[Pictures from the tool calls above, as the user sees them: img1]" },
      img("data:jpeg-c1/0"),
    ]);
    expect((out[4].content as { text?: string }[])[0].text).toBe("[Attached pictures: att3]");
    // The stored conversation is not changed.
    expect(chat[0].content).toHaveLength(3);
  });
});
