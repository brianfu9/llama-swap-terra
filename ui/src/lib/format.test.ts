import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatDuration,
  formatSpeed,
  formatFileSize,
  formatCapacity,
  formatCompact,
  formatRelativeTime,
  formatAbsoluteTime,
} from "./format";

describe("formatDuration", () => {
  it("defaults to seconds with 2 decimals", () => {
    expect(formatDuration(1500)).toBe("1.50s");
    expect(formatDuration(0)).toBe("0.00s");
    expect(formatDuration(250)).toBe("0.25s");
  });

  it("honors custom precision", () => {
    expect(formatDuration(1500, { precision: 1 })).toBe("1.5s");
  });

  it("renders sub-second durations as ms when subSecondMs is set", () => {
    expect(formatDuration(850, { precision: 1, subSecondMs: true })).toBe("850ms");
    expect(formatDuration(1500, { precision: 1, subSecondMs: true })).toBe("1.5s");
    expect(formatDuration(999, { subSecondMs: true })).toBe("999ms");
  });

  it("renders mixed minutes and seconds at 60s and above", () => {
    expect(formatDuration(60000)).toBe("1m 00.00s");
    expect(formatDuration(65430)).toBe("1m 05.43s");
    expect(formatDuration(600000)).toBe("10m 00.00s");
  });

  it("honors precision in the minutes branch", () => {
    expect(formatDuration(65000, { precision: 0 })).toBe("1m 05s");
    expect(formatDuration(65000, { precision: 1 })).toBe("1m 05.0s");
  });
});

describe("formatSpeed", () => {
  it("formats tokens per second", () => {
    expect(formatSpeed(42.5)).toBe("42.50 t/s");
    expect(formatSpeed(0)).toBe("0.00 t/s");
  });

  it("reports negative values as unknown", () => {
    expect(formatSpeed(-1)).toBe("unknown");
  });
});

describe("formatFileSize", () => {
  it("formats bytes", () => {
    expect(formatFileSize(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatFileSize(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatCapacity", () => {
  it("formats binary hardware capacities", () => {
    expect(formatCapacity(24 * 1024 ** 3)).toBe("24.0 GiB");
    expect(formatCapacity(1.5 * 1024 ** 4)).toBe("1.50 TiB");
  });

  it("handles unavailable capacities", () => {
    expect(formatCapacity(0)).toBe("Not detected");
  });
});

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats relative times", () => {
    const now = new Date("2026-06-28T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    expect(formatRelativeTime("2026-06-28T11:59:58Z")).toBe("now");
    expect(formatRelativeTime("2026-06-28T11:59:30Z")).toBe("30s ago");
    expect(formatRelativeTime("2026-06-28T11:55:00Z")).toBe("5m ago");
    expect(formatRelativeTime("2026-06-28T09:00:00Z")).toBe("3h ago");
    const olderThanOneDay = new Date(2026, 5, 25, 12, 34, 56);
    expect(formatRelativeTime(olderThanOneDay.toISOString())).toBe("2026-06-25 12:34:56");
  });
});

describe("formatAbsoluteTime", () => {
  it("formats a timestamp in local time", () => {
    expect(formatAbsoluteTime(new Date(2026, 0, 2, 3, 4, 5).toISOString())).toBe(
      "2026-01-02 03:04:05"
    );
  });

  it("is unaffected by how recent the timestamp is", () => {
    expect(formatAbsoluteTime(new Date(2026, 11, 31, 23, 59, 59).toISOString())).toBe(
      "2026-12-31 23:59:59"
    );
  });
});

describe("formatCompact", () => {
  it("leaves values under a thousand whole", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(1)).toBe("1");
    expect(formatCompact(999)).toBe("999");
  });

  it("abbreviates to k/m/b with one decimal", () => {
    expect(formatCompact(5600)).toBe("5.6k");
    expect(formatCompact(1000)).toBe("1.0k");
    expect(formatCompact(123400000)).toBe("123.4m");
    expect(formatCompact(2500000000)).toBe("2.5b");
  });

  it("promotes rather than printing a four-digit mantissa", () => {
    expect(formatCompact(999.6)).toBe("1.0k");
    expect(formatCompact(999999)).toBe("1.0m");
    expect(formatCompact(999999999)).toBe("1.0b");
  });

  it("caps at billions", () => {
    expect(formatCompact(1e12)).toBe("1000.0b");
  });

  it("preserves the sign", () => {
    expect(formatCompact(-5600)).toBe("-5.6k");
    expect(formatCompact(-12)).toBe("-12");
  });

  it("falls back to zero for non-finite input", () => {
    expect(formatCompact(NaN)).toBe("0");
    expect(formatCompact(Infinity)).toBe("0");
  });
});
