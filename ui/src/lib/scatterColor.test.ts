import { describe, expect, it } from "vitest";
import {
  acceptBucket,
  acceptColor,
  assignSessionSlots,
  dotRadius,
  OTHER_DARK,
  OTHER_LIGHT,
  shortSession,
} from "./scatterColor";

describe("scatter color helpers", () => {
  it("assigns slots to the three latest sessions", () => {
    const input = ["a", "a", "a", "b", "b", "c", "c", "d", "e"];
    const slots = assignSessionSlots(input);
    expect([...slots.entries()].sort((x, y) => x[1] - y[1])).toEqual([
      ["e", 0],
      ["d", 1],
      ["c", 2],
    ]);
    expect(slots.has("a")).toBe(false);
    expect(slots.has("b")).toBe(false);
  });

  it("ranks sessions by their most recent appearance", () => {
    const slots = assignSessionSlots(["z", "y", "z", "y", "a"]);
    expect(slots.get("a")).toBe(0);
    expect(slots.get("y")).toBe(1);
    expect(slots.get("z")).toBe(2);
  });

  it("never assigns a slot to the empty session", () => {
    const slots = assignSessionSlots(["", "", "a"]);
    expect(slots.has("")).toBe(false);
    expect(slots.get("a")).toBe(0);
  });

  it("produces the same mapping for the same input", () => {
    const input = ["s1", "s2", "s3", "s4", "s1", "s3"];
    expect(assignSessionSlots(input)).toEqual(assignSessionSlots(input));
  });

  it("buckets acceptance at the documented boundaries", () => {
    expect(acceptBucket(-1)).toBe(-1);
    expect(acceptBucket(0)).toBe(0);
    expect(acceptBucket(0.49)).toBe(0);
    expect(acceptBucket(0.5)).toBe(1);
    expect(acceptBucket(0.69)).toBe(2);
    expect(acceptBucket(0.7)).toBe(3);
    expect(acceptBucket(0.79)).toBe(3);
    expect(acceptBucket(0.8)).toBe(4);
    expect(acceptBucket(1)).toBe(4);
  });

  it("uses the neutral gray for missing draft data in both modes", () => {
    expect(acceptColor(-1, false)).toBe(OTHER_LIGHT);
    expect(acceptColor(-1, true)).toBe(OTHER_DARK);
  });

  it("keeps dot radius bounded at 1.5 when cap is zero and never NaN", () => {
    expect(dotRadius(0, 0)).toBe(1.5);
    expect(dotRadius(42, 0)).toBe(1.5);
    expect(dotRadius(Number.NaN, 100)).toBe(1.5);
  });

  it("keeps dot radius monotonic in output", () => {
    const cap = 1_000;
    let previous = dotRadius(0, cap);
    for (const output of [1, 10, 100, 500, 1_000, 9_999]) {
      const radius = dotRadius(output, cap);
      expect(Number.isNaN(radius)).toBe(false);
      expect(radius).toBeGreaterThanOrEqual(previous);
      previous = radius;
    }
  });

  it("shortens long session ids to six characters", () => {
    expect(shortSession("abc")).toBe("abc");
    expect(shortSession("abcdef")).toBe("abcdef");
    expect(shortSession("ses_01J9ZKQVX4M8N2P6R7T3W5Y8A1")).toBe("W5Y8A1");
    expect(shortSession("")).toBe("");
  });
});
