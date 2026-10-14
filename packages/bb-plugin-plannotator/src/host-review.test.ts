import { describe, expect, it } from "vitest";
import type { HostReviewState } from "./host-contract";
import { startHostPlanReview, type PlannotatorHostClient } from "./host-review";

const SESSION_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

function fakeClient(states: Array<HostReviewState | Error>, behavior: { stopped?: boolean } = {}) {
  const calls: Array<{ method: string; input: unknown; hostId: string; timeoutMs?: number }> = [];
  const client: PlannotatorHostClient = {
    async call(method, input, options) {
      calls.push({ method, input, hostId: options.hostId, timeoutMs: options.timeoutMs });
      if (method === "startReview") return { url: "https://mac.tail1b968e.ts.net:19500", port: 19500 } as never;
      if (method === "stopReview") return { stopped: behavior.stopped ?? true } as never;
      const next = states.length > 1 ? states.shift()! : states[0]!;
      if (next instanceof Error) throw next;
      return next as never;
    },
  };
  return { client, calls };
}

function start(
  client: PlannotatorHostClient,
  pollIntervalMs = 5,
  extra: { disconnectGraceMs?: number; now?: () => number } = {},
) {
  return startHostPlanReview({
    ...extra,
    client,
    hostId: "host_mac",
    sessionId: SESSION_ID,
    planMarkdown: "# Plan",
    cwd: "/Users/me/repo",
    origin: "codex",
    signal: new AbortController().signal,
    pollIntervalMs,
  });
}

describe("host plan review handle", () => {
  it("starts on the host with a long timeout and resolves from polled status", async () => {
    const { client, calls } = fakeClient([
      { status: "pending" },
      { status: "decided", decision: { approved: true } },
    ]);
    const review = await start(client);

    expect(review.url).toBe("https://mac.tail1b968e.ts.net:19500");
    expect(calls[0]).toMatchObject({
      method: "startReview",
      hostId: "host_mac",
      timeoutMs: 60_000,
      input: { sessionId: SESSION_ID, cwd: "/Users/me/repo", origin: "codex", planMarkdown: "# Plan" },
    });
    await expect(review.result).resolves.toEqual({ approved: true });
  });

  it("polls immediately when a host signal arrives", async () => {
    const { client, calls } = fakeClient([{ status: "decided", decision: { approved: true } }]);
    const review = await start(client, 60_000);

    review.refresh();

    await expect(review.result).resolves.toEqual({ approved: true });
    expect(calls.filter(({ method }) => method === "getReview")).toHaveLength(1);
  });

  it("ends the review only after polls fail for the whole grace period", async () => {
    const { client } = fakeClient([new Error("Host is not connected")]);
    let clock = 0;
    const review = await start(client, 5, { disconnectGraceMs: 120_000, now: () => clock });
    let settled = false;
    const outcome = review.result.catch((error: Error) => {
      settled = true;
      return error.message;
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    clock = 119_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);

    clock = 120_000;
    expect(await outcome).toBe(
      "Lost contact with the thread's machine during the review: Host is not connected",
    );
  });

  it("keeps the review through a short disconnect", async () => {
    let clock = 0;
    const { client } = fakeClient([
      new Error("Host is not connected"),
      new Error("Host is not connected"),
      new Error("Host is not connected"),
      new Error("Host is not connected"),
      { status: "pending" },
      { status: "decided", decision: { approved: true } },
    ]);
    const review = await start(client, 5, {
      disconnectGraceMs: 120_000,
      now: () => {
        clock += 13_000;
        return clock;
      },
    });

    await expect(review.result).resolves.toEqual({ approved: true });
  });

  it("tolerates a single failed poll", async () => {
    const { client } = fakeClient([
      new Error("blip"),
      { status: "decided", decision: { approved: false, feedback: "No" } },
    ]);
    const review = await start(client);

    await expect(review.result).resolves.toEqual({ approved: false, feedback: "No" });
  });

  it("ends the review when the host worker no longer knows it", async () => {
    const { client } = fakeClient([{ status: "unknown" }]);
    const review = await start(client);

    await expect(review.result).rejects.toThrow("restarted, so the review ended");
  });

  it("ends the review when the host worker exits", async () => {
    const { client } = fakeClient([{ status: "pending" }]);
    const review = await start(client, 60_000);

    review.workerExited();

    await expect(review.result).rejects.toThrow("The Plannotator worker on the thread's machine exited.");
  });

  it("reports a stop that could not reach the host", async () => {
    const { client } = fakeClient([{ status: "pending" }]);
    let stopFailed = 0;
    const review = await startHostPlanReview({
      client: {
        call: (method, input, options) =>
          method === "stopReview" ? Promise.reject(new Error("host offline")) : client.call(method, input, options),
      },
      hostId: "host_mac",
      sessionId: SESSION_ID,
      planMarkdown: "# Plan",
      cwd: "/Users/me/repo",
      origin: "codex",
      signal: new AbortController().signal,
      pollIntervalMs: 60_000,
      onCleanupNeeded: () => {
        stopFailed += 1;
      },
    });
    void review.result.catch(() => undefined);

    await review.stop();

    expect(stopFailed).toBe(1);
  });

  it("asks for cleanup when a fresh worker no longer knows the review", async () => {
    const { client, calls } = fakeClient([{ status: "unknown" }], { stopped: false });
    let cleanups = 0;
    const review = await startHostPlanReview({
      client,
      hostId: "host_mac",
      sessionId: SESSION_ID,
      planMarkdown: "# Plan",
      cwd: "/Users/me/repo",
      origin: "codex",
      signal: new AbortController().signal,
      pollIntervalMs: 5,
      onCleanupNeeded: () => {
        cleanups += 1;
      },
    });
    await expect(review.result).rejects.toThrow("restarted");

    await review.stop();
    await review.stop();

    expect(cleanups).toBe(1);
    expect(calls.filter(({ method }) => method === "stopReview")).toHaveLength(1);
  });

  it("polls again when a signal arrives during an in-flight poll", async () => {
    let releaseFirst!: () => void;
    const firstPoll = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let polls = 0;
    const client: PlannotatorHostClient = {
      async call(method) {
        if (method === "startReview") return { url: "https://mac.tail1b968e.ts.net:19500", port: 19500 } as never;
        if (method === "stopReview") return { stopped: true } as never;
        polls += 1;
        if (polls === 1) {
          await firstPoll;
          return { status: "pending" } as never;
        }
        return { status: "decided", decision: { approved: true } } as never;
      },
    };
    const review = await start(client, 60_000);

    review.refresh();
    review.refresh();
    releaseFirst();

    await expect(review.result).resolves.toEqual({ approved: true });
    expect(polls).toBe(2);
  });

  it("stops the host review and rejects the result as cancelled", async () => {
    const { client, calls } = fakeClient([{ status: "pending" }]);
    const review = await start(client, 60_000);
    const outcome = review.result.catch((error: Error) => error.message);

    await review.stop();

    expect(await outcome).toBe("Plannotator review was cancelled");
    expect(calls.at(-1)).toMatchObject({ method: "stopReview", input: { sessionId: SESSION_ID } });
  });
});
