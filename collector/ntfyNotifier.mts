/**
 * Pushes the recorder's news to an ntfy topic: the link going down (reported
 * when it comes back, with how long and why), and the alerts the alert catalogue
 * marks as worth interrupting someone for — the same `notify` / `notifyClear`
 * policy the desktop app's notifications follow.
 *
 * Why "when it comes back": while Starlink is down nothing on this network can
 * reach a phone, so a "down now" push would only ever arrive alongside the
 * "back up" one. Posting to the ntfy server's LAN address still matters — a
 * message for an alert raised during an outage is accepted at once, stamped
 * with when it happened, and delivered the moment the link returns.
 *
 * Configured from the environment; absent DISHYLINK_NTFY_URL it is off.
 */
import { outageEventKind, outageEventLabel, type TelemetrySample } from "../core/telemetry.ts";
import type { AlertTransition } from "../core/alertEngine.ts";
import type { StoredEvent } from "./eventStore.mts";

export interface NtfyConfig {
  /** Server base URL, e.g. http://192.168.1.34 — not the topic URL. */
  serverUrl: string;
  topic: string;
  token: string | null;
  /** Opened when the notification is tapped. */
  clickUrl: string | null;
  /** How long the link must fail before it counts as down. */
  downAfterMs: number;
  /** How long it must hold up again before the outage is declared over. */
  upAfterMs: number;
}

export function ntfyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NtfyConfig | null {
  const serverUrl = env.DISHYLINK_NTFY_URL?.trim().replace(/\/+$/, "");
  if (!serverUrl) return null;
  const downAfterS = Number(env.DISHYLINK_NTFY_DOWN_AFTER_S);
  return {
    serverUrl,
    topic: env.DISHYLINK_NTFY_TOPIC?.trim() || "starlink",
    token: env.DISHYLINK_NTFY_TOKEN?.trim() || null,
    clickUrl: env.DISHYLINK_NTFY_CLICK?.trim() || null,
    downAfterMs: (Number.isFinite(downAfterS) && downAfterS > 0 ? downAfterS : 30) * 1000,
    upAfterMs: 10_000,
  };
}

export interface NtfyMessage {
  title: string;
  message: string;
  /** ntfy's 1 (min) to 5 (max). */
  priority: number;
  tags: string[];
}

// ---------- link watch ----------

export type LinkTransition =
  { kind: "down"; startMs: number } | { kind: "up"; startMs: number; endMs: number };

/** A sample that carried no usable connection: every ping lost, or near enough. */
function failing(sample: TelemetrySample): boolean {
  return sample.latencyMs === null || sample.dropRate >= 0.99;
}

/**
 * Turns the overlapping per-poll sample windows into down/up transitions.
 * Samples at or before the newest one already seen are skipped, so re-seeing a
 * window changes nothing; samples from before the watch started are ignored, so
 * a restart doesn't re-announce an outage still visible in the dish's buffer.
 */
export class LinkWatch {
  private lastMs: number;
  private failingSince: number | null = null;
  private healthySince: number | null = null;
  private downSince: number | null = null;

  constructor(
    private readonly downAfterMs: number,
    private readonly upAfterMs: number,
    startMs: number,
  ) {
    this.lastMs = startMs;
  }

  get isDown(): boolean {
    return this.downSince !== null;
  }

  ingest(samples: readonly TelemetrySample[]): LinkTransition[] {
    const out: LinkTransition[] = [];
    for (const sample of samples) {
      const at = sample.timestampMs;
      if (at <= this.lastMs) continue;
      this.lastMs = at;
      if (failing(sample)) {
        this.healthySince = null;
        this.failingSince ??= at;
        if (this.downSince === null && at - this.failingSince >= this.downAfterMs) {
          this.downSince = this.failingSince;
          out.push({ kind: "down", startMs: this.downSince });
        }
        continue;
      }
      this.failingSince = null;
      if (this.downSince === null) continue;
      this.healthySince ??= at;
      if (at - this.healthySince >= this.upAfterMs) {
        out.push({ kind: "up", startMs: this.downSince, endMs: this.healthySince });
        this.downSince = null;
        this.healthySince = null;
      }
    }
    return out;
  }
}

// ---------- wording ----------

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function clock(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

/** The dish's own reasons for an outage overlapping [startMs, endMs], deduplicated. */
export function outageCauses(
  events: readonly StoredEvent[],
  startMs: number,
  endMs: number,
): string[] {
  const slackMs = 5_000;
  const labels = events
    .filter(
      (event) =>
        outageEventKind(event.cause) === "outage" &&
        event.startMs <= endMs + slackMs &&
        event.startMs + event.durationMs >= startMs - slackMs,
    )
    .map((event) => outageEventLabel(event.cause));
  return [...new Set(labels)];
}

export function restoredMessage(
  startMs: number,
  endMs: number,
  causes: readonly string[],
  timeZone?: string,
): NtfyMessage {
  const lasted = endMs - startMs;
  const span = `${clock(startMs, timeZone)}–${clock(endMs, timeZone)}`;
  return {
    title: `Starlink was down for ${formatDuration(lasted)}`,
    message: causes.length ? `${span} · ${causes.join(", ")}` : span,
    priority: lasted >= 5 * 60_000 ? 4 : 3,
    tags: ["satellite", "white_check_mark"],
  };
}

const SOURCE_NAME = { dish: "Dish", router: "Router", system: "Recorder" } as const;

export function alertMessage(
  transition: AlertTransition,
  firedAtMs: number | null,
  timeZone?: string,
): NtfyMessage | null {
  const { kind, spec, source, atMs } = transition;
  if (!spec.notify) return null;
  if (kind === "fired") {
    const lines = [`${SOURCE_NAME[source]} · since ${clock(atMs, timeZone)}`];
    if (spec.advice) lines.push(spec.advice);
    return {
      title: spec.firing,
      message: lines.join("\n"),
      priority: spec.severity === "advisory" ? 3 : 4,
      tags: [spec.severity === "critical" ? "rotating_light" : "warning"],
    };
  }
  if (spec.notifyClear === false) return null;
  const lasted = firedAtMs === null ? "" : ` after ${formatDuration(atMs - firedAtMs)}`;
  return {
    title: spec.ok,
    message: `${SOURCE_NAME[source]} · cleared ${clock(atMs, timeZone)}${lasted} (was: ${spec.firing})`,
    priority: 2,
    tags: ["white_check_mark"],
  };
}

// ---------- delivery ----------

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface NotifierOptions {
  /** The recorded event log, for an outage's causes. */
  events: () => readonly StoredEvent[];
  fetch?: Fetch;
  now?: () => number;
  timeZone?: string;
  /** Wait for the dish's event log to catch up before naming a cause. */
  causeDelayMs?: number;
  retryMs?: number;
}

const QUEUE_LIMIT = 50;

export class NtfyNotifier {
  private readonly watch: LinkWatch;
  private readonly firedAt = new Map<string, number>();
  private readonly queue: NtfyMessage[] = [];
  private sending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchImpl: Fetch;

  constructor(
    private readonly config: NtfyConfig,
    private readonly options: NotifierOptions,
  ) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.watch = new LinkWatch(config.downAfterMs, config.upAfterMs, (options.now ?? Date.now)());
  }

  samples(samples: readonly TelemetrySample[]): void {
    for (const transition of this.watch.ingest(samples)) {
      if (transition.kind !== "up") continue;
      const { startMs, endMs } = transition;
      setTimeout(() => {
        const causes = outageCauses(this.options.events(), startMs, endMs);
        this.enqueue(restoredMessage(startMs, endMs, causes, this.options.timeZone));
      }, this.options.causeDelayMs ?? 15_000).unref?.();
    }
  }

  alerts(transitions: readonly AlertTransition[]): void {
    for (const transition of transitions) {
      const id = `${transition.source}:${transition.key}`;
      const firedAt = this.firedAt.get(id) ?? null;
      if (transition.kind === "fired") this.firedAt.set(id, transition.atMs);
      else this.firedAt.delete(id);
      const message = alertMessage(transition, firedAt, this.options.timeZone);
      if (message) this.enqueue(message);
    }
  }

  enqueue(message: NtfyMessage): void {
    this.queue.push(message);
    // A long unreachable spell must not grow without bound; the oldest go first.
    if (this.queue.length > QUEUE_LIMIT) this.queue.splice(0, this.queue.length - QUEUE_LIMIT);
    void this.flush();
  }

  /** Sends in order; on a failure keeps the rest and tries again later. */
  async flush(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        if (!(await this.post(this.queue[0]))) {
          this.scheduleRetry();
          return;
        }
        this.queue.shift();
      }
    } finally {
      this.sending = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, this.options.retryMs ?? 30_000);
    this.retryTimer.unref?.();
  }

  private async post(message: NtfyMessage): Promise<boolean> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Cloudflare in front of a public ntfy refuses anonymous user agents.
      "user-agent": "dishylink",
    };
    if (this.config.token) headers.authorization = `Bearer ${this.config.token}`;
    try {
      const response = await this.fetchImpl(this.config.serverUrl + "/", {
        method: "POST",
        headers,
        body: JSON.stringify({
          topic: this.config.topic,
          ...message,
          ...(this.config.clickUrl ? { click: this.config.clickUrl } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return true;
      console.warn(`[ntfy] ${response.status} posting "${message.title}"`);
      // A refused message (bad token, too large) will be refused again; drop it
      // rather than wedging everything queued behind it.
      return response.status >= 400 && response.status < 500 && response.status !== 429;
    } catch (error) {
      console.warn(`[ntfy] unreachable: ${(error as Error).message}`);
      return false;
    }
  }
}
