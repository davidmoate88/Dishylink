// Entry for embed.html: a compact, framable summary for home dashboards. It
// reads only what the history recorder already stored (/api/*), never the dish
// or router, so an embed left open all day adds no load to either. Clicking it
// opens the full dashboard in the top window.
//
// Query parameters: open (http/https URL the card links to; default "/"),
// theme (dark | light | system, applied before paint by embed.html), and
// minutes (sparkline window, 5–60; default 15).
import type { TelemetrySample } from "@core/telemetry";
import {
  formatAgo,
  formatDuration,
  formatRate,
  summarize,
  type LinkState,
  type RecordedEvent,
} from "./summary";

const REFRESH_MS = 30_000;
const STATE_LABEL: Record<LinkState, [string, string]> = {
  online: ["Online", "--ok"],
  degraded: ["Degraded", "--warn"],
  offline: ["Offline", "--bad"],
  "not-recording": ["Not recording", "--idle"],
};

const params = new URLSearchParams(location.search);
const minutes = Math.min(60, Math.max(5, Number(params.get("minutes")) || 15));
const open = params.get("open");
if (open && /^https?:\/\//i.test(open)) byId<HTMLAnchorElement>("card").href = open;

let samples: TelemetrySample[] = [];
let events: RecordedEvent[] = [];

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setValue(id: string, value: string, unit = ""): void {
  const node = byId(id);
  node.textContent = value;
  if (unit) {
    const span = document.createElement("span");
    span.className = "unit";
    span.textContent = unit;
    node.appendChild(span);
  }
}

function setRate(id: string, bps: number | null): void {
  if (bps === null) return setValue(id, "–");
  const [value, unit] = formatRate(bps);
  setValue(id, value, unit);
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return (await response.json()) as T;
}

function paint(usage: { totalDownGB?: number; totalUpGB?: number } | null, outagesKnown: boolean) {
  const now = Date.now();
  const summary = summarize(samples, events, now);
  const [label, color] = STATE_LABEL[summary.state];
  byId("dot").style.background = `var(${color})`;
  byId("state").textContent = label;
  byId("age").textContent = summary.latestMs === null ? "" : formatAgo(now - summary.latestMs);

  setRate("down", summary.downBps);
  setRate("up", summary.upBps);
  if (summary.latencyMs === null) setValue("latency", "–");
  else setValue("latency", Math.round(summary.latencyMs).toString(), "ms");
  const ping = summary.pingSuccessPercent;
  if (ping === null) setValue("ping", "–");
  else setValue("ping", ping.toFixed(ping > 99.9 ? 0 : 1), "%");

  const peak = Math.max(1, ...summary.spark.map((value) => value ?? 0));
  const points = summary.spark.flatMap((value, index) =>
    value === null ? [] : [`${index},${(38 - (value / peak) * 36).toFixed(1)}`],
  );
  byId("sparkLine").setAttribute("points", points.join(" "));

  if (usage === null && !outagesKnown) return;
  const parts: string[] = [];
  if (usage && Number.isFinite(usage.totalDownGB) && Number.isFinite(usage.totalUpGB)) {
    parts.push(
      `Today ${usage.totalDownGB!.toFixed(1)} GB down · ${usage.totalUpGB!.toFixed(1)} GB up`,
    );
  }
  if (summary.lastOutage) {
    const { startMs, durationMs } = summary.lastOutage;
    parts.push(
      `last outage ${formatAgo(now - startMs - durationMs)} (${formatDuration(durationMs)})`,
    );
  } else if (outagesKnown) {
    parts.push("no outages recorded");
  }
  byId("foot").textContent = parts.join(" · ");
}

let lastUsage: { totalDownGB?: number; totalUpGB?: number } | null = null;
let outagesKnown = false;

async function refresh(): Promise<void> {
  const [sampleResult, usageResult, outageResult] = await Promise.allSettled([
    getJson<{ samples?: TelemetrySample[] }>(`/api/samples?minutes=${minutes}`),
    getJson<{ totalDownGB?: number; totalUpGB?: number }>("/api/usage?range=today"),
    getJson<{ events?: RecordedEvent[] }>("/api/outages"),
  ]);
  samples = sampleResult.status === "fulfilled" ? (sampleResult.value.samples ?? []) : [];
  lastUsage = usageResult.status === "fulfilled" ? usageResult.value : null;
  outagesKnown = outageResult.status === "fulfilled";
  events =
    outagesKnown && outageResult.status === "fulfilled" ? (outageResult.value.events ?? []) : [];
  paint(lastUsage, outagesKnown);
}

void refresh();
setInterval(() => void refresh(), REFRESH_MS);
// Between fetches, keep "updated Ns ago" and the stale check moving.
setInterval(() => paint(lastUsage, outagesKnown), 5_000);
