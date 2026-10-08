import { describe, expect, it } from "vitest";
import type { TelemetrySample } from "@core/telemetry";
import { STALE_MS, formatDuration, summarize } from "./summary";

const NOW = 1_800_000_000_000;

function sample(offsetMs: number, overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    timestampMs: NOW + offsetMs,
    latencyMs: 30,
    dropRate: 0,
    downlinkBps: 100_000_000,
    uplinkBps: 10_000_000,
    powerW: 50,
    routerLatencyMs: null,
    routerPingSuccessPercent: null,
    ...overrides,
  };
}

describe("summarize", () => {
  it("reads a fresh healthy sample as online with its rates", () => {
    const result = summarize([sample(-2000), sample(-1000)], [], NOW);
    expect(result.state).toBe("online");
    expect(result.downBps).toBe(100_000_000);
    expect(result.pingSuccessPercent).toBe(100);
  });

  it("clears every reading when the recorder returns no samples", () => {
    const result = summarize([], [], NOW);
    expect(result.state).toBe("not-recording");
    expect(result.downBps).toBeNull();
    expect(result.upBps).toBeNull();
    expect(result.latencyMs).toBeNull();
    expect(result.pingSuccessPercent).toBeNull();
  });

  it("reads a stale last sample as not recording, not online", () => {
    expect(summarize([sample(-STALE_MS - 1)], [], NOW).state).toBe("not-recording");
  });

  it("reads total drop as offline and partial loss as degraded", () => {
    expect(summarize([sample(-1000, { dropRate: 1, latencyMs: null })], [], NOW).state).toBe(
      "offline",
    );
    expect(summarize([sample(-1000, { dropRate: 0.2 })], [], NOW).state).toBe("degraded");
  });

  it("counts only outage-kind events as the last outage", () => {
    const outage = { startMs: NOW - 3_600_000, durationMs: 90_000, cause: "NO_SATS" };
    const handoff = {
      startMs: NOW - 60_000,
      durationMs: 0,
      cause: "EVENT_REASON_CLIENT_SWITCHING_UPSTREAM_MAC",
    };
    expect(summarize([], [outage, handoff], NOW).lastOutage).toEqual(outage);
    expect(summarize([], [handoff], NOW).lastOutage).toBeNull();
  });
});

describe("formatDuration", () => {
  it("keeps seconds under an hour instead of rounding to whole minutes", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_590_000)).toBe("59m 50s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(4_000)).toBe("4s");
  });
});
