import { describe, expect, it } from "vitest";
import {
  BRIDGE_EVENT_PATH,
  BRIDGE_POLL_PATH,
  runBridgeClient,
  type BridgeAnswerer,
  type BridgeTransport,
} from "./bridge-client";

type Event = Record<string, unknown> & { type: string };

/**
 * A fake of plannotator 0.28.6's pull bridge (session-bridge-pull.ts): a
 * command is re-sent on every poll until the host acknowledges it with any
 * event for that question, and events for a question that is no longer
 * running get 409.
 */
function fakeBridge() {
  const pending: Array<Record<string, unknown>> = [];
  const acknowledged = new Set<string>();
  const active = new Set<string>();
  const events: Event[] = [];
  const polls: Array<Record<string, unknown>> = [];
  let exited = false;
  let refuseWith: number | null = null;
  let closing = false;
  let waiters: Array<() => void> = [];
  const wake = () => {
    const current = waiters;
    waiters = [];
    for (const resolve of current) resolve();
  };

  const transport: BridgeTransport = async (path, body, { signal }) => {
    if (exited) throw new Error("connect ECONNREFUSED 127.0.0.1:54321");
    if (path === BRIDGE_POLL_PATH) {
      polls.push(JSON.parse(body) as Record<string, unknown>);
      if (refuseWith !== null) return { status: refuseWith, body: "" };
      const deliver = () => pending.filter((command) => !acknowledged.has(String(command.askId ?? command.interruptId)));
      if (deliver().length === 0 && !closing) {
        // A short long-poll so tests stay fast.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      if (exited) throw new Error("socket hang up");
      return { status: 200, body: JSON.stringify({ commands: deliver(), features: ["taken_over"], ...(closing ? { closing: true } : {}) }) };
    }
    expect(path).toBe(BRIDGE_EVENT_PATH);
    const event = JSON.parse(body) as Event;
    events.push(event);
    const askId = typeof event.askId === "string" ? event.askId : null;
    if (askId) {
      acknowledged.add(askId);
      if (!active.has(askId)) return { status: 409, body: '{"ok":false,"code":"ask_not_active"}' };
      if (event.type === "done" || event.type === "error") active.delete(askId);
    }
    return { status: 200, body: '{"ok":true}' };
  };

  return {
    transport,
    events,
    polls,
    ask(askId: string, text = "Why step 1?") {
      active.add(askId);
      pending.push({ type: "ask", askId, text, mode: "turn" });
      wake();
    },
    cancel(askId: string) {
      acknowledged.delete(askId);
      pending.push({ type: "cancel", askId });
      wake();
    },
    /** The reviewer stopped the question before the host answered. */
    deactivate(askId: string) {
      active.delete(askId);
    },
    exit() {
      exited = true;
      wake();
    },
    refuse(status: number) {
      refuseWith = status;
      wake();
    },
    close() {
      closing = true;
      wake();
    },
  };
}

const noSleep = async () => undefined;

function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error("condition not met"));
      setTimeout(check, 5);
    };
    check();
  });
}

describe("session bridge client", () => {
  it("polls as ready and answers a question with started, delta and done", async () => {
    const bridge = fakeBridge();
    const controller = new AbortController();
    const answer: BridgeAnswerer = async ({ text }) => `Answer to: ${text}`;
    const run = runBridgeClient({ transport: bridge.transport, answer, signal: controller.signal, pollWaitMs: 50 });

    bridge.ask("chat:1");
    await until(() => bridge.events.some((event) => event.type === "done"));
    controller.abort();
    await expect(run).resolves.toBe("aborted");

    expect(bridge.polls[0]).toEqual({ status: "ready", modes: { turn: true, transient: false }, waitMs: 50 });
    expect(bridge.events).toEqual([
      { type: "started", askId: "chat:1" },
      { type: "delta", askId: "chat:1", text: "Answer to: Why step 1?" },
      { type: "done", askId: "chat:1", answer: "Answer to: Why step 1?" },
    ]);
  });

  it("answers a command the server re-sends only once", async () => {
    const bridge = fakeBridge();
    const controller = new AbortController();
    let answers = 0;
    let release!: () => void;
    const answer: BridgeAnswerer = () => {
      answers += 1;
      return new Promise((resolve) => {
        release = () => resolve("ok");
      });
    };
    // Hold back acknowledgements so the fake keeps re-sending the ask.
    const delayed: BridgeTransport = async (path, body, options) => {
      if (path === BRIDGE_EVENT_PATH) await until(() => bridge.polls.length >= 4);
      return bridge.transport(path, body, options);
    };
    const run = runBridgeClient({ transport: delayed, answer, signal: controller.signal, pollWaitMs: 50 });

    bridge.ask("chat:1");
    await until(() => bridge.polls.length >= 4);
    release();
    await until(() => bridge.events.some((event) => event.type === "done"));
    controller.abort();
    await run;

    expect(answers).toBe(1);
    expect(bridge.events.filter((event) => event.type === "started")).toHaveLength(1);
  });

  it("aborts a running answer on cancel, and confirms a cancel for a question it never saw", async () => {
    const bridge = fakeBridge();
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const answer: BridgeAnswerer = (_question, signal) => {
      seenSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      });
    };
    const run = runBridgeClient({ transport: bridge.transport, answer, signal: controller.signal, pollWaitMs: 50 });

    bridge.ask("chat:1");
    await until(() => seenSignal !== undefined);
    bridge.cancel("chat:1");
    await until(() => bridge.events.some((event) => event.type === "error" && event.askId === "chat:1"));
    bridge.cancel("never-seen:1");
    await until(() => bridge.events.some((event) => event.askId === "never-seen:1"));
    controller.abort();
    await run;

    expect(seenSignal!.aborted).toBe(true);
    expect(bridge.events).toContainEqual({ type: "error", askId: "chat:1", code: "aborted" });
    expect(bridge.events).toContainEqual({ type: "error", askId: "never-seen:1", code: "aborted" });
    expect(bridge.events.filter((event) => event.type === "done")).toHaveLength(0);
  });

  it("stops the answer when the server answers an event with 409", async () => {
    const bridge = fakeBridge();
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const answer: BridgeAnswerer = (_question, signal) => {
      seenSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      });
    };
    const run = runBridgeClient({ transport: bridge.transport, answer, signal: controller.signal, pollWaitMs: 50 });

    // The reviewer stopped the question before the host's `started` arrived.
    const original = bridge.ask.bind(bridge);
    original("chat:1");
    bridge.deactivate("chat:1");
    await until(() => seenSignal?.aborted === true);
    controller.abort();
    await run;

    expect(bridge.events[0]).toEqual({ type: "started", askId: "chat:1" });
  });

  it("ends as gone after the server exits, and stops running answers", async () => {
    const bridge = fakeBridge();
    let seenSignal: AbortSignal | undefined;
    const answer: BridgeAnswerer = (_question, signal) => {
      seenSignal = signal;
      return new Promise(() => undefined);
    };
    const run = runBridgeClient({
      transport: bridge.transport,
      answer,
      signal: new AbortController().signal,
      pollWaitMs: 50,
      sleep: noSleep,
    });

    bridge.ask("chat:1");
    await until(() => seenSignal !== undefined);
    bridge.exit();

    await expect(run).resolves.toBe("gone");
    expect(seenSignal!.aborted).toBe(true);
  });

  it("stops when the server refuses the bridge or says it is closing", async () => {
    for (const [setup, end] of [
      [(bridge: ReturnType<typeof fakeBridge>) => bridge.refuse(404), "refused"],
      [(bridge: ReturnType<typeof fakeBridge>) => bridge.refuse(401), "refused"],
      [(bridge: ReturnType<typeof fakeBridge>) => bridge.close(), "closing"],
    ] as const) {
      const bridge = fakeBridge();
      setup(bridge);
      await expect(
        runBridgeClient({
          transport: bridge.transport,
          answer: async () => "x",
          signal: new AbortController().signal,
          pollWaitMs: 50,
        }),
      ).resolves.toBe(end);
    }
  });

  it("does not spin on a server that answers empty polls at once", async () => {
    let polls = 0;
    const controller = new AbortController();
    const run = runBridgeClient({
      transport: async () => {
        polls += 1;
        return { status: 200, body: '{"commands":[]}' };
      },
      answer: async () => "x",
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await run;
    expect(polls).toBeLessThanOrEqual(2);
  });
});
