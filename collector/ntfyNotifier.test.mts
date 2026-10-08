import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetrySample } from "../core/telemetry.ts";
import type { AlertTransition } from "../core/alertEngine.ts";
import { SYSTEM_ALERTS } from "../core/alertDefinitions.ts";
import {
  LinkWatch,
  NtfyNotifier,
  alertMessage,
  formatDuration,
  ntfyConfigFromEnv,
  outageCauses,
  restoredMessage,
  type NtfyConfig,
} from "./ntfyNotifier.mts";

const T0 = 1_800_000_000_000;

/** One sample per second from `fromS` for `count` seconds. */
function run(fromS: number, count: number, up: boolean): TelemetrySample[] {
  return Array.from({ length: count }, (_, i) => ({
    timestampMs: T0 + (fromS + i) * 1000,
    latencyMs: up ? 30 : null,
    dropRate: up ? 0 : 1,
    downlinkBps: 0,
    uplinkBps: 0,
    powerW: 50,
    routerLatencyMs: null,
    routerPingSuccessPercent: null,
  }));
}

describe("LinkWatch", () => {
  it("declares down after the threshold and up after holding steady", () => {
    const watch = new LinkWatch(30_000, 10_000, T0);
    const samples = [...run(1, 10, true), ...run(11, 60, false), ...run(71, 20, true)];
    expect(watch.ingest(samples)).toEqual([
      { kind: "down", startMs: T0 + 11_000 },
      { kind: "up", startMs: T0 + 11_000, endMs: T0 + 71_000 },
    ]);
  });

  it("ignores a drop shorter than the threshold", () => {
    const watch = new LinkWatch(30_000, 10_000, T0);
    expect(watch.ingest([...run(1, 5, true), ...run(6, 20, false), ...run(26, 20, true)])).toEqual(
      [],
    );
  });

  it("re-seeing an overlapping window announces nothing twice", () => {
    const watch = new LinkWatch(30_000, 10_000, T0);
    const first = [...run(1, 50, false)];
    expect(watch.ingest(first)).toHaveLength(1);
    expect(watch.ingest([...first, ...run(51, 5, false)])).toEqual([]);
  });

  it("does not re-announce an outage from before it started watching", () => {
    const watch = new LinkWatch(30_000, 10_000, T0 + 100_000);
    expect(watch.ingest([...run(1, 60, false), ...run(61, 20, true)])).toEqual([]);
  });

  it("a blip while recovering restarts the hold, not the outage", () => {
    const watch = new LinkWatch(30_000, 10_000, T0);
    const out = watch.ingest([
      ...run(1, 40, false),
      ...run(41, 5, true),
      ...run(46, 2, false),
      ...run(48, 15, true),
    ]);
    expect(out.at(-1)).toEqual({ kind: "up", startMs: T0 + 1000, endMs: T0 + 48_000 });
  });
});

describe("wording", () => {
  it("names the dish's causes and the span", () => {
    const events = [
      { startMs: T0 + 12_000, durationMs: 50_000, cause: "NO_SATS", severity: "warning" as const },
      {
        startMs: T0 + 20_000,
        durationMs: 0,
        cause: "EVENT_REASON_CLIENT_SWITCHING_BAND",
        severity: "advisory" as const,
      },
    ];
    const causes = outageCauses(events, T0 + 11_000, T0 + 71_000);
    expect(causes).toHaveLength(1);
    const message = restoredMessage(T0 + 11_000, T0 + 71_000, causes, "UTC");
    expect(message.title).toBe("Starlink was down for 1m");
    expect(message.message).toContain(causes[0]);
    expect(message.priority).toBe(3);
  });

  it("raises priority for a long outage", () => {
    expect(restoredMessage(T0, T0 + 6 * 60_000, [], "UTC").priority).toBe(4);
  });

  it("formats durations", () => {
    expect(formatDuration(432_000)).toBe("7m 12s");
    expect(formatDuration(3_660_000)).toBe("1h 1m");
  });

  it("words a fired and a cleared alert, with how long it lasted", () => {
    const spec = SYSTEM_ALERTS.dishUnreachable;
    const fired: AlertTransition = {
      kind: "fired",
      source: "system",
      key: spec.key,
      atMs: T0,
      spec,
    };
    const cleared: AlertTransition = { ...fired, kind: "cleared", atMs: T0 + 90_000 };
    expect(alertMessage(fired, null, "UTC")?.title).toBe(spec.firing);
    expect(alertMessage(cleared, T0, "UTC")?.message).toContain("after 1m 30s");
  });

  it("stays quiet for alerts not marked to notify", () => {
    const spec = SYSTEM_ALERTS.recorderOff;
    expect(
      alertMessage({ kind: "fired", source: "system", key: spec.key, atMs: T0, spec }, null),
    ).toBeNull();
  });
});

describe("ntfyConfigFromEnv", () => {
  it("is off without a server URL and defaults the rest", () => {
    expect(ntfyConfigFromEnv({})).toBeNull();
    expect(ntfyConfigFromEnv({ DISHYLINK_NTFY_URL: "http://ntfy.lan/" })).toMatchObject({
      serverUrl: "http://ntfy.lan",
      topic: "starlink",
      token: null,
      downAfterMs: 30_000,
    });
  });
});

describe("NtfyNotifier delivery", () => {
  afterEach(() => vi.useRealTimers());

  const config: NtfyConfig = {
    serverUrl: "http://ntfy.test",
    topic: "starlink",
    token: "tk_test",
    clickUrl: "https://dash.test/",
    downAfterMs: 30_000,
    upAfterMs: 10_000,
  };

  it("posts JSON with the token, and keeps messages queued until the server answers", async () => {
    vi.useFakeTimers();
    let up = false;
    const fetch = vi.fn(async () => {
      if (!up) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    });
    const notifier = new NtfyNotifier(config, {
      events: () => [],
      fetch,
      retryMs: 1000,
      now: () => T0,
    });
    notifier.enqueue({ title: "one", message: "a", priority: 3, tags: [] });
    notifier.enqueue({ title: "two", message: "b", priority: 3, tags: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(notifier.pending).toBe(2);

    up = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(notifier.pending).toBe(0);
    const [url, init] = fetch.mock.calls.at(-1)! as unknown as [string, RequestInit];
    expect(url).toBe("http://ntfy.test/");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tk_test");
    expect(JSON.parse(init.body as string)).toMatchObject({
      topic: "starlink",
      title: "two",
      click: "https://dash.test/",
    });
  });

  it("leaves the outage alert to the link watch's single recovery message", () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const notifier = new NtfyNotifier(config, { events: () => [], fetch, now: () => T0 });
    const spec = SYSTEM_ALERTS.starlinkOutage;
    notifier.alerts([{ kind: "fired", source: "system", key: spec.key, atMs: T0, spec }]);
    expect(notifier.pending).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a message the server refuses instead of blocking the queue", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 403 }));
    const notifier = new NtfyNotifier(config, { events: () => [], fetch, now: () => T0 });
    notifier.enqueue({ title: "x", message: "", priority: 3, tags: [] });
    await vi.waitFor(() => expect(notifier.pending).toBe(0));
  });

  it("announces a recovered outage with its cause after the log catches up", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const events = [
      { startMs: T0 + 12_000, durationMs: 50_000, cause: "NO_SATS", severity: "warning" as const },
    ];
    const notifier = new NtfyNotifier(config, {
      events: () => events,
      fetch,
      now: () => T0,
      causeDelayMs: 100,
      timeZone: "UTC",
    });
    notifier.samples([...run(1, 10, true), ...run(11, 60, false), ...run(71, 20, true)]);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.title).toBe("Starlink was down for 1m");
  });
});

describe("review fixes", () => {
  afterEach(() => vi.useRealTimers());

  const config: NtfyConfig = {
    serverUrl: "http://ntfy.test",
    topic: "starlink",
    token: null,
    clickUrl: null,
    downAfterMs: 30_000,
    upAfterMs: 10_000,
  };

  it("a silence in the samples counts toward neither going down nor coming back", () => {
    const watch = new LinkWatch(30_000, 10_000, T0);
    // Failing either side of an hour with no samples: not 3600 s of failure.
    expect(watch.ingest([...run(1, 1, false), ...run(3601, 1, false)])).toEqual([]);
    // Declared down, then healthy either side of a gap: the hold restarts.
    const down = new LinkWatch(30_000, 10_000, T0);
    down.ingest(run(1, 40, false));
    expect(down.ingest([...run(41, 1, true), ...run(3600, 1, true)])).toEqual([]);
    expect(down.isDown).toBe(true);
  });

  it("evicting for space never drops the message being posted", async () => {
    let release!: () => void;
    const delivered: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const { title } = JSON.parse(init.body as string);
      if (title === "m1") await new Promise<void>((resolve) => (release = resolve));
      delivered.push(title);
      return new Response("{}", { status: 200 });
    });
    const notifier = new NtfyNotifier(config, { events: () => [], fetch, now: () => T0 });
    for (let i = 1; i <= 51; i++) {
      notifier.enqueue({ title: `m${i}`, message: "", priority: 3, tags: [] });
      if (i === 1) await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    }
    release();
    await vi.waitFor(() => expect(notifier.pending).toBe(0));
    // m1 was in flight; one of the waiting ones (m2) made way for m51.
    expect(delivered[0]).toBe("m1");
    expect(delivered).not.toContain("m2");
    expect(delivered).toContain("m3");
    expect(delivered.at(-1)).toBe("m51");
  });

  it("keeps undelivered messages and a declared outage across a restart", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const statePath = join(mkdtempSync(join(tmpdir(), "ntfy-")), "state.json");
    const offline = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const first = new NtfyNotifier(config, {
      events: () => [],
      fetch: offline,
      now: () => T0,
      statePath,
      retryMs: 60_000,
    });
    first.samples(run(1, 40, false)); // declared down
    first.enqueue({ title: "queued", message: "", priority: 3, tags: [] });
    await vi.waitFor(() => expect(offline).toHaveBeenCalled());

    vi.useFakeTimers();
    const delivered: string[] = [];
    const online = vi.fn(async (_url: string, init: RequestInit) => {
      delivered.push(JSON.parse(init.body as string).title);
      return new Response("{}", { status: 200 });
    });
    // Restarted after the outage began: recovery 20 s later still reports it.
    const second = new NtfyNotifier(config, {
      events: () => [],
      fetch: online,
      now: () => T0 + 41_000,
      statePath,
      causeDelayMs: 100,
      timeZone: "UTC",
    });
    second.samples([...run(42, 2, false), ...run(44, 15, true)]);
    await vi.advanceTimersByTimeAsync(200);
    expect(delivered).toEqual(["queued", "Starlink was down for 43s"]);
  });
});
