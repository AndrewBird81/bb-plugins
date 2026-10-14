// Answers Plannotator's Ask AI questions with the thread's own agent, in a
// hidden fork of the thread: the same pattern as bb's side chat. The user's
// thread is never interrupted or waited on, and gets no transcript noise. Each
// Ask AI chat (askId `<chat id>:<n>`) keeps one fork for its follow-ups.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Threads = BbPluginApi["sdk"]["threads"];
export type ForkAskerThreads = Pick<Threads, "fork" | "send" | "wait" | "output" | "stop" | "archive" | "list"> & {
  events: Pick<Threads["events"], "list" | "wait">;
};

/** An answer may take this long before the fork is stopped. */
export const ASK_TIMEOUT_MS = 10 * 60_000;
/** The Q&A summary appended to the session's result message. */
export const MAX_QA_SUMMARY_CHARS = 4_000;
const MAX_QA_QUESTION_CHARS = 400;
const MAX_QA_ANSWER_CHARS = 800;
const EVENT_WAIT_MS = 60_000;
/** A new fork starts its provider session before it can take a turn. */
const FORK_READY_MS = 2 * 60_000;

export type AskExchange = { question: string; answer?: string; error?: string };

export type ForkAsker = {
  ask(question: { askId: string; text: string }, signal: AbortSignal): Promise<string>;
  /** Questions asked so far, with their answers or errors. */
  exchanges(): readonly AskExchange[];
  /** Stop and archive every fork. Idempotent. */
  dispose(): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSessionUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "fork_source_session_unavailable"
  );
}

/** The Ask AI chat a question belongs to: the askId without its `:<n>` suffix. */
export function askChatId(askId: string): string {
  const colon = askId.lastIndexOf(":");
  return colon > 0 ? askId.slice(0, colon) : askId;
}

/**
 * The user's question without Plannotator's header. Upstream sends the header,
 * a `Surface:` line, a blank line, then the question.
 */
export function askQuestionText(text: string): string {
  const surface = text.search(/^Surface:.*$/mu);
  if (surface === -1) return text.trim();
  const blank = text.indexOf("\n\n", surface);
  return blank === -1 ? text.trim() : text.slice(blank + 2).trim();
}

function clip(text: string, max: number): string {
  const single = text.trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** "Ask AI exchanges during this …" for the agent's result message, or null. */
export function summarizeExchanges(exchanges: readonly AskExchange[], noun: string): string | null {
  if (exchanges.length === 0) return null;
  const lines = [`Ask AI exchanges during this ${noun} (answered in a hidden fork of this thread):`];
  let length = lines[0]!.length;
  for (const [index, exchange] of exchanges.entries()) {
    const reply = exchange.answer ?? (exchange.error ? `(no answer: ${exchange.error})` : "(no answer)");
    const entry = `${index + 1}. Q: ${clip(exchange.question, MAX_QA_QUESTION_CHARS)}\n   A: ${clip(reply, MAX_QA_ANSWER_CHARS).replace(/\n/gu, "\n   ")}`;
    if (length + entry.length + 1 > MAX_QA_SUMMARY_CHARS) {
      lines.push(`(${exchanges.length - index} more exchange(s) omitted)`);
      break;
    }
    lines.push(entry);
    length += entry.length + 1;
  }
  return lines.join("\n");
}

async function latestSequence(threads: ForkAskerThreads, threadId: string): Promise<number> {
  const rows = await threads.events.list({ threadId, order: "desc", limit: "1" });
  return rows[0]?.seq ?? 0;
}

export function createForkAsker(options: {
  threads: ForkAskerThreads;
  sourceThreadId: string;
  /** Pin forks to the thread's history when the session opened. */
  sourceSeqEnd?: number;
  /** Marks the forks as this session's. */
  sessionId: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}): ForkAsker {
  const { threads, sourceThreadId } = options;
  const timeoutMs = options.timeoutMs ?? ASK_TIMEOUT_MS;
  const log = options.log ?? (() => undefined);
  const forks = new Map<string, Promise<string>>();
  const exchanges: AskExchange[] = [];
  let disposed: Promise<void> | null = null;

  async function createFork(): Promise<string> {
    const args = {
      sourceThreadId,
      lifecycleOwnerThreadId: sourceThreadId,
      visibility: "hidden" as const,
      title: "Plannotator Ask AI",
      pluginMetadata: { plannotatorSessionId: options.sessionId },
    };
    try {
      return (
        await threads.fork({
          ...args,
          ...(options.sourceSeqEnd !== undefined ? { sourceSeqEnd: options.sourceSeqEnd } : {}),
        })
      ).id;
    } catch (error) {
      // The pinned point is not a completed turn yet (the agent that opened
      // the session is still in its turn): fork at the tip instead.
      if (options.sourceSeqEnd === undefined || !isSessionUnavailable(error)) throw error;
      return (await threads.fork(args)).id;
    }
  }

  /** Wait for the turn the question started, after `afterSeq`, to complete. */
  async function waitForTurn(threadId: string, afterSeq: number, signal: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    while (!signal.aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const event = await threads.events.wait({
        threadId,
        type: "turn/completed",
        afterSeq: String(afterSeq),
        waitMs: String(Math.min(EVENT_WAIT_MS, remaining)),
        signal,
      });
      if (event) return event;
    }
    return null;
  }

  async function ask(question: { askId: string; text: string }, signal: AbortSignal): Promise<string> {
    if (disposed) throw new Error("This Plannotator session has ended.");
    const exchange: AskExchange = { question: askQuestionText(question.text) };
    exchanges.push(exchange);
    const chatId = askChatId(question.askId);
    let forkId: string | undefined;
    try {
      let fork = forks.get(chatId);
      if (!fork) {
        fork = createFork();
        forks.set(chatId, fork);
        // A failed fork must not poison the chat's follow-ups.
        fork.catch(() => forks.delete(chatId));
      }
      forkId = await fork;
      // Start the question as a turn of an idle fork. A send to a fork that
      // is still starting would be queued, and a hidden fork's queue does not
      // drain on its own. Waiting from the sequence before the send cannot
      // match a turn copied from the source.
      await threads.wait({ threadId: forkId, status: "idle", timeoutMs: FORK_READY_MS, signal });
      const afterSeq = await latestSequence(threads, forkId);
      await threads.send({
        threadId: forkId,
        mode: "start",
        input: [{ type: "text", text: question.text, mentions: [] }],
      });
      const completed = await waitForTurn(forkId, afterSeq, signal);
      if (signal.aborted) throw new Error("The question was cancelled.");
      if (!completed) {
        await threads.stop({ threadId: forkId }).catch(() => undefined);
        throw new Error(`The thread's agent did not answer within ${Math.round(timeoutMs / 60_000)} minutes.`);
      }
      const data = (completed as { data?: { status?: unknown; error?: { message?: unknown } } }).data;
      if (data?.status !== undefined && data.status !== "completed") {
        const reason = typeof data.error?.message === "string" ? `: ${data.error.message}` : "";
        throw new Error(`The thread's agent could not answer (${String(data.status)}${reason}).`);
      }
      const { output } = await threads.output({ threadId: forkId });
      const answer = output?.trim() ? output : "The thread's agent gave no answer.";
      exchange.answer = answer;
      return answer;
    } catch (error) {
      if (signal.aborted && forkId) await threads.stop({ threadId: forkId }).catch(() => undefined);
      exchange.error = signal.aborted ? "cancelled" : errorMessage(error);
      throw error;
    }
  }

  return {
    ask,
    exchanges: () => exchanges,
    dispose() {
      disposed ??= (async () => {
        const ids = await Promise.all(
          [...forks.values()].map((fork) => fork.catch(() => null)),
        );
        await Promise.all(
          ids
            .filter((id): id is string => id !== null)
            .map(async (threadId) => {
              await threads.stop({ threadId }).catch(() => undefined);
              await threads.archive({ threadId }).catch((error: unknown) => {
                log(`Could not archive Plannotator fork ${threadId}: ${errorMessage(error)}`);
              });
            }),
        );
      })();
      return disposed;
    },
  };
}

/** Archive hidden forks this plugin left behind, for example after a crash. */
export async function sweepForks(
  threads: Pick<Threads, "list" | "stop" | "archive">,
  pluginId: string,
  log: (message: string) => void = () => undefined,
): Promise<number> {
  let swept = 0;
  for (let page = 0; page < 20; page += 1) {
    const rows = await threads.list({
      includeHidden: true,
      originKind: "fork",
      originPluginId: pluginId,
      archived: false,
      limit: 100,
    });
    const own = rows.filter(
      (thread) =>
        thread.originKind === "fork" &&
        thread.originPluginId === pluginId &&
        thread.visibility === "hidden" &&
        thread.archivedAt === null,
    );
    if (own.length === 0) break;
    for (const thread of own) {
      await threads.stop({ threadId: thread.id }).catch(() => undefined);
      try {
        await threads.archive({ threadId: thread.id });
        swept += 1;
      } catch (error) {
        log(`Could not archive Plannotator fork ${thread.id}: ${errorMessage(error)}`);
      }
    }
    if (rows.length < 100 || swept === 0) break;
  }
  return swept;
}
