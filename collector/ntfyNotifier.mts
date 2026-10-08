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
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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

/** Samples are 1 Hz; a longer silence means the dish wasn't heard at all. */
const GAP_MS = 5_000;

/**
 * Turns the recorder's 1 Hz samples into down/up transitions. Samples at or
 * before the newest one already seen are skipped; samples from before the watch
 * started are ignored, so a restart doesn't re-announce an outage still in the
 * dish's buffer (an outage already declared survives a restart via restore()).
 * A gap in the samples breaks a run: time the dish wasn't heard counts toward
 * neither the down threshold nor the recovery hold.
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

  /** When the current outage began, if one has been declared. */
  get downSinceMs(): number | null {
    return this.downSince;
  }

  /** Carry a declared outage across a restart. */
  restore(downSinceMs: number): void {
    this.downSince = downSinceMs;
  }

  ingest(samples: readonly TelemetrySample[]): LinkTransition[] {
    const out: LinkTransition[] = [];
    for (const sample of samples) {
      const at = sample.timestampMs;
      if (at <= this.lastMs) continue;
      if (at - this.lastMs > GAP_MS) {
        this.failingSince = null;
        this.healthySince = null;
      }
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
  /**
   * Where to keep undelivered messages and the outage in progress, so a restart
   * neither drops an alert raised while ntfy was unreachable nor forgets an
   * outage it has already declared. Omitted (tests), state is memory-only.
   */
  statePath?: string;
}

const QUEUE_LIMIT = 50;

interface PersistedState {
  queue: NtfyMessage[];
  downSinceMs: number | null;
  firedAt: [string, number][];
  /** Recovered outages whose message waits on the event log catching up. */
  recoveries: { startMs: number; endMs: number }[];
}

export class NtfyNotifier {
  private readonly watch: LinkWatch;
  private readonly firedAt = new Map<string, number>();
  private readonly queue: NtfyMessage[] = [];
  private sending = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fetchImpl: Fetch;
  private recoveries: { startMs: number; endMs: number }[] = [];

  constructor(
    private readonly config: NtfyConfig,
    private readonly options: NotifierOptions,
  ) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.watch = new LinkWatch(config.downAfterMs, config.upAfterMs, (options.now ?? Date.now)());
    const saved = this.load();
    if (saved) {
      this.queue.push(...saved.queue);
      if (saved.downSinceMs !== null) this.watch.restore(saved.downSinceMs);
      for (const [id, atMs] of saved.firedAt) this.firedAt.set(id, atMs);
      for (const recovery of saved.recoveries) this.scheduleRecovery(recovery);
      if (this.queue.length) void this.flush();
    }
  }

  samples(samples: readonly TelemetrySample[]): void {
    const wasDown = this.watch.isDown;
    for (const transition of this.watch.ingest(samples)) {
      if (transition.kind === "up") this.scheduleRecovery(transition);
    }
    if (this.watch.isDown !== wasDown) this.save();
  }

  private scheduleRecovery(recovery: { startMs: number; endMs: number }): void {
    this.recoveries.push(recovery);
    this.save();
    setTimeout(() => {
      this.recoveries = this.recoveries.filter((pending) => pending !== recovery);
      const causes = outageCauses(this.options.events(), recovery.startMs, recovery.endMs);
      this.enqueue(
        restoredMessage(recovery.startMs, recovery.endMs, causes, this.options.timeZone),
      );
    }, this.options.causeDelayMs ?? 15_000).unref?.();
  }

  alerts(transitions: readonly AlertTransition[]): void {
    for (const transition of transitions) {
      // The link watch reports the same outage once, on recovery, with its
      // length and cause. This alert's fired/cleared pair would only ever reach
      // a phone together, after the link is back, as two more messages.
      if (transition.source === "system" && transition.key === "starlinkOutage") continue;
      const id = `${transition.source}:${transition.key}`;
      const firedAt = this.firedAt.get(id) ?? null;
      if (transition.kind === "fired") this.firedAt.set(id, transition.atMs);
      else this.firedAt.delete(id);
      const message = alertMessage(transition, firedAt, this.options.timeZone);
      if (message) this.enqueue(message);
    }
    this.save();
  }

  enqueue(message: NtfyMessage): void {
    this.queue.push(message);
    // A long unreachable spell must not grow without bound; the oldest go
    // first — but never the head while it is being posted, or the shift() that
    // follows its delivery would remove the wrong message.
    const excess = this.queue.length - QUEUE_LIMIT;
    if (excess > 0) this.queue.splice(this.sending ? 1 : 0, excess);
    this.save();
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
        this.save();
      }
    } finally {
      this.sending = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private load(): PersistedState | null {
    if (!this.options.statePath || !existsSync(this.options.statePath)) return null;
    try {
      return JSON.parse(readFileSync(this.options.statePath, "utf8")) as PersistedState;
    } catch (error) {
      console.warn(`[ntfy] ignoring unreadable state: ${(error as Error).message}`);
      return null;
    }
  }

  private save(): void {
    const path = this.options.statePath;
    if (!path) return;
    const state: PersistedState = {
      queue: this.queue,
      downSinceMs: this.watch.downSinceMs,
      firedAt: [...this.firedAt],
      recoveries: this.recoveries,
    };
    try {
      // temp + rename, so a crash mid-write never leaves half a file.
      writeFileSync(`${path}.tmp`, JSON.stringify(state));
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      console.warn(`[ntfy] could not save state: ${(error as Error).message}`);
    }
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
