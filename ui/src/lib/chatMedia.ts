import type { ChatMessage, ContentPart } from "./types";

/**
 * terra fork: the pictures of a Chat conversation, by id, and what the chat
 * model is sent about them (see lib/mediaTools.ts).
 *
 * att1, att2, ... are the user's attached pictures in message order; they are
 * derived, never stored, so they stay the same as long as the messages do.
 * img1, img2, ... are generated pictures; the tool stores them in
 * MediaInfo.ids when the job finishes.
 */

/** The attached pictures by id (att1 ...) with their data URLs, in message order. */
export function attachments(messages: ChatMessage[]): { id: string; url: string; msgIndex: number }[] {
  const out: { id: string; url: string; msgIndex: number }[] = [];
  messages.forEach((m, i) => {
    if (m.role !== "user" || typeof m.content === "string") return;
    for (const part of m.content) {
      if (part.type === "image_url") out.push({ id: `att${out.length + 1}`, url: part.image_url.url, msgIndex: i });
    }
  });
  return out;
}

/** The generated pictures by id (img1 ...) with their IndexedDB keys. */
export function generated(messages: ChatMessage[]): { id: string; key: string }[] {
  const out: { id: string; key: string }[] = [];
  for (const m of messages) {
    const media = m.media;
    if (!media || media.status !== "done" || !media.ids) continue;
    media.ids.forEach((id, i) => {
      const key = media.keys?.[i];
      if (key) out.push({ id, key });
    });
  }
  return out;
}

/** Every picture id in the conversation. */
export function pictureIds(messages: ChatMessage[]): string[] {
  return [...attachments(messages).map((a) => a.id), ...generated(messages).map((g) => g.id)];
}

/** The highest img number in use, 0 when there is none. */
export function maxImageNumber(messages: ChatMessage[]): number {
  let max = 0;
  for (const m of messages) for (const id of m.media?.ids ?? []) {
    const n = Number(/^img(\d+)$/.exec(id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max;
}

/**
 * The conversation as the chat model gets it. A user message with pictures
 * gains a first text part naming their ids, and each run of tool results that
 * made pictures is followed by a user message holding those pictures, so the
 * model sees what it made. loadPicture returns a picture's data URL by its
 * IndexedDB key (scaled down by the caller), or null when it is gone.
 */
export async function messagesForModel(
  messages: ChatMessage[],
  loadPicture: (key: string) => Promise<string | null>
): Promise<ChatMessage[]> {
  const attIds = new Map<number, string[]>();
  for (const a of attachments(messages)) attIds.set(a.msgIndex, [...(attIds.get(a.msgIndex) ?? []), a.id]);

  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const ids = attIds.get(i);
    if (ids && typeof m.content !== "string") {
      out.push({ ...m, content: [{ type: "text", text: `[Attached pictures: ${ids.join(", ")}]` }, ...m.content] });
    } else {
      out.push(m);
    }

    // At the end of a run of tool results, show the model the pictures they made.
    const runEnds = m.role === "tool" && messages[i + 1]?.role !== "tool";
    if (!runEnds) continue;
    let start = i;
    while (start > 0 && messages[start - 1].role === "tool") start--;
    const parts: ContentPart[] = [];
    const shown: string[] = [];
    for (const t of messages.slice(start, i + 1)) {
      const media = t.media;
      if (!media || media.kind !== "image" || media.status !== "done" || !media.ids) continue;
      for (let k = 0; k < media.ids.length; k++) {
        const key = media.keys?.[k];
        const url = key ? await loadPicture(key) : null;
        if (!url) continue;
        shown.push(media.ids[k]);
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
    if (shown.length) {
      out.push({
        role: "user",
        content: [{ type: "text", text: `[Pictures from the tool calls above, as the user sees them: ${shown.join(", ")}]` }, ...parts],
      });
    }
  }
  return out;
}
