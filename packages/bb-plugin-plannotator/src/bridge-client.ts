// The host half of Plannotator's "Ask this session" pull bridge, run by the
// plugin server for each open session. It long-polls the session for Ask AI
// questions, has them answered (by a hidden fork of the thread, see
// fork-asker.ts), and posts the answer back.
//
// Protocol: plannotator 0.28.6 `packages/ai/session-bridge-pull.ts`. This is a
// smaller equivalent of its `session-bridge-pull-client.ts` (Plannotator,
// https://github.com/backnotprop/plannotator, MIT OR Apache-2.0): one answer
// per question, a constant `ready` status, and no interrupts.

export const BRIDGE_POLL_PATH = "/api/ai/bridge/poll";
export const BRIDGE_EVENT_PATH = "/api/ai/bridge/event";
export type BridgePath = typeof BRIDGE_POLL_PATH | typeof BRIDGE_EVENT_PATH;

/** Upstream clamps a poll to 25 s. */
export const BRIDGE_POLL_WAIT_MS = 25_000;
const EMPTY_POLL_FLOOR_MS = 500;

/**
 * Sends one bridge request to the session: a direct loopback fetch on the
 * server machine, or the host entry's `bridgeFetch` for another machine.
 * Rejects when the session cannot be reached at all.
 */
export type BridgeTransport = (
  path: BridgePath,
  body: string,
  options: { waitMs?: number; signal: AbortSignal },
) => Promise<{ status: number; body: string }>;

/** Answers one Ask AI question; rejects with an error to report it failed. */
export type BridgeAnswerer = (
  question: { askId: string; text: string },
  signal: AbortSignal,
) => Promise<string>;

type BridgeCommand =
  | { type: "ask"; askId: string; text: string; mode?: string }
  | { type: "cancel"; askId: string }
  | { type: "interrupt"; interruptId: string };

type BridgeEvent =
  | { type: "started"; askId: string }
  | { type: "delta"; askId: string; text: string }
  | { type: "done"; askId: string; answer: string }
  | { type: "error"; askId: string; code: "aborted" | "failed"; message?: string }
  | { type: "interrupted"; interruptId: string; ok: false; message: string };

/** Why the client stopped. */
export type BridgeClientEnd = "aborted" | "closing" | "refused" | "gone";

type Ask = { controller: AbortController; finished: boolean };

function isCommand(value: unknown): value is BridgeCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Record<string, unknown>;
  if (command.type === "ask") return typeof command.askId === "string" && typeof command.text === "string";
  if (command.type === "cancel") return typeof command.askId === "string";
  if (command.type === "interrupt") return typeof command.interruptId === "string";
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

export async function runBridgeClient(options: {
  transport: BridgeTransport;
  answer: BridgeAnswerer;
  signal: AbortSignal;
  pollWaitMs?: number;
  /** Consecutive failed polls before the session counts as gone. */
  maxFailures?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (message: string) => void;
}): Promise<BridgeClientEnd> {
  const { transport, signal } = options;
  const pollWaitMs = options.pollWaitMs ?? BRIDGE_POLL_WAIT_MS;
  const maxFailures = options.maxFailures ?? 6;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => undefined);
  /** Questions seen so far: the server re-sends a command until acknowledged. */
  const asks = new Map<string, Ask>();
  const interrupts = new Set<string>();
  // Events reach the server in order; posts never run concurrently.
  let sending: Promise<void> = Promise.resolve();

  const post = (event: BridgeEvent): Promise<void> => {
    sending = sending.then(async () => {
      try {
        const response = await transport(BRIDGE_EVENT_PATH, JSON.stringify(event), {
          signal: AbortSignal.timeout(15_000),
        });
        // The server no longer runs this question (the reviewer stopped it).
        if (response.status === 409 && "askId" in event) asks.get(event.askId)?.controller.abort();
      } catch (error) {
        log(`Plannotator bridge event failed: ${errorMessage(error)}`);
      }
    });
    return sending;
  };

  const runAsk = (askId: string, text: string): boolean => {
    if (asks.has(askId)) return false;
    const ask: Ask = { controller: new AbortController(), finished: false };
    asks.set(askId, ask);
    const finish = (event: BridgeEvent) => {
      if (ask.finished) return;
      ask.finished = true;
      void post(event);
    };
    void post({ type: "started", askId });
    options.answer({ askId, text }, ask.controller.signal).then(
      (answer) => {
        if (ask.controller.signal.aborted) return finish({ type: "error", askId, code: "aborted" });
        if (!ask.finished && answer) void post({ type: "delta", askId, text: answer });
        finish({ type: "done", askId, answer });
      },
      (error: unknown) =>
        finish(
          ask.controller.signal.aborted
            ? { type: "error", askId, code: "aborted" }
            : { type: "error", askId, code: "failed", message: errorMessage(error) },
        ),
    );
    return true;
  };

  /** Run a command; false when it is a re-send of one already handled. */
  const handle = (command: BridgeCommand): boolean => {
    if (command.type === "ask") return runAsk(command.askId, command.text);
    if (command.type === "cancel") {
      const ask = asks.get(command.askId);
      // Unknown or finished: confirm so the server frees its slot.
      if (!ask || ask.finished) void post({ type: "error", askId: command.askId, code: "aborted" });
      else ask.controller.abort();
      return true;
    }
    if (interrupts.has(command.interruptId)) return false;
    interrupts.add(command.interruptId);
    void post({
      type: "interrupted",
      interruptId: command.interruptId,
      ok: false,
      message: "Questions are answered in a separate fork, so the thread has nothing to interrupt.",
    });
    return true;
  };

  let failures = 0;
  let end: BridgeClientEnd = "aborted";
  try {
    while (!signal.aborted) {
      let response: { status: number; body: string };
      const polledAt = Date.now();
      try {
        response = await transport(
          BRIDGE_POLL_PATH,
          JSON.stringify({ status: "ready", modes: { turn: true, transient: false }, waitMs: pollWaitMs }),
          { waitMs: pollWaitMs, signal },
        );
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        if (failures >= maxFailures) {
          log(`Plannotator bridge stopped: the session is not answering (${errorMessage(error)}).`);
          end = "gone";
          break;
        }
        await sleep(Math.min(4_000, 500 * 2 ** (failures - 1)), signal);
        continue;
      }
      if ([401, 403, 404, 405, 503].includes(response.status)) {
        // Wrong token, not loopback, no bridge on this binary, or AI disabled.
        log(`Plannotator bridge refused (HTTP ${response.status}).`);
        end = "refused";
        break;
      }
      if (response.status < 200 || response.status >= 300) {
        failures += 1;
        if (failures >= maxFailures) {
          end = "gone";
          break;
        }
        await sleep(Math.min(4_000, 500 * 2 ** (failures - 1)), signal);
        continue;
      }
      failures = 0;
      let body: { commands?: unknown; closing?: unknown } = {};
      try {
        body = JSON.parse(response.body) as typeof body;
      } catch {
        // An empty answer.
      }
      let handled = 0;
      for (const command of Array.isArray(body.commands) ? body.commands : []) {
        if (isCommand(command) && handle(command)) handled += 1;
      }
      if (body.closing === true) {
        end = "closing";
        break;
      }
      // A poll with nothing new that came back at once (a server that ignores
      // waitMs, or re-sends at once) must not make this loop spin.
      if (handled === 0 && Date.now() - polledAt < EMPTY_POLL_FLOOR_MS) {
        await sleep(EMPTY_POLL_FLOOR_MS, signal);
      }
    }
  } finally {
    // Nobody can read an answer once the session is gone: stop the work.
    for (const ask of asks.values()) if (!ask.finished) ask.controller.abort();
    if (end !== "gone" && end !== "refused") await sending.catch(() => undefined);
  }
  return end;
}
