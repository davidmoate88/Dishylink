// What the embed card shows, worked out from recorded /api data alone. Kept free
// of the DOM so the rules — what counts as an outage, when the link reads as
// down — can be tested directly.
import { outageEventKind, type TelemetrySample } from "@core/telemetry";

export type LinkState = "online" | "degraded" | "offline" | "not-recording";

export interface RecordedEvent {
  startMs: number;
  durationMs: number;
  cause: string;
}

export interface EmbedSummary {
  state: LinkState;
  latestMs: number | null;
  downBps: number | null;
  upBps: number | null;
  latencyMs: number | null;
  pingSuccessPercent: number | null;
  /** The most recent event that was an outage — not a handoff or a loss blip. */
  lastOutage: RecordedEvent | null;
  /** Down-rate peaks across the window, ~100 points, null where unsampled. */
  spark: (number | null)[];
}

/** No sample this recent means the recorder has stopped, not that the link is up. */
export const STALE_MS = 90_000;
const SPARK_POINTS = 100;

function mean(values: (number | null)[]): number | null {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function summarize(
  samples: readonly TelemetrySample[],
  events: readonly RecordedEvent[],
  nowMs: number,
): EmbedSummary {
  const latest = samples.at(-1) ?? null;
  // Headline rates smooth over the last ~10 s so one quiet second doesn't read
  // as the link dropping to zero; ping success over the last minute.
  const recent = samples.slice(-10);
  const lastMinute = samples.slice(-60);
  const drop = mean(lastMinute.map((sample) => sample.dropRate));

  let state: LinkState = "not-recording";
  if (latest && nowMs - latest.timestampMs < STALE_MS) {
    if (latest.latencyMs === null || latest.dropRate >= 0.99) state = "offline";
    else if (latest.dropRate > 0.05) state = "degraded";
    else state = "online";
  }

  const outages = events.filter((event) => outageEventKind(event.cause) === "outage");
  const lastOutage = outages.reduce<RecordedEvent | null>(
    (newest, event) => (!newest || event.startMs > newest.startMs ? event : newest),
    null,
  );

  const spark: (number | null)[] = Array.from({ length: SPARK_POINTS }, () => null);
  if (samples.length >= 2) {
    const startMs = samples[0].timestampMs;
    const widthMs = Math.max(1, samples[samples.length - 1].timestampMs - startMs);
    for (const sample of samples) {
      const index = Math.min(
        SPARK_POINTS - 1,
        Math.floor(((sample.timestampMs - startMs) / widthMs) * SPARK_POINTS),
      );
      spark[index] = Math.max(spark[index] ?? 0, sample.downlinkBps);
    }
  }

  return {
    state,
    latestMs: latest?.timestampMs ?? null,
    downBps: mean(recent.map((sample) => sample.downlinkBps)),
    upBps: mean(recent.map((sample) => sample.uplinkBps)),
    latencyMs: mean(recent.map((sample) => sample.latencyMs)),
    pingSuccessPercent: drop === null ? null : 100 * (1 - drop),
    lastOutage,
    spark,
  };
}

/** "<1s", "1m 30s", "59m 50s", "2h 5m" — seconds kept below an hour. */
export function formatDuration(ms: number): string {
  // The dish logs real sub-second drops; "0s" would read as nothing happened.
  if (ms > 0 && ms < 500) return "<1s";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** [number, unit] for a bit rate. */
export function formatRate(bps: number): [string, string] {
  if (bps >= 1e9) return [(bps / 1e9).toFixed(2), "Gbps"];
  if (bps >= 1e6) return [(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1), "Mbps"];
  return [Math.round(bps / 1e3).toString(), "kbps"];
}
