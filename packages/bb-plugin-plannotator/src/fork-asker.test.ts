import { describe, expect, it } from "vitest";
import {
  askChatId,
  askQuestionText,
  createForkAsker,
  summarizeExchanges,
  sweepForks,
  type ForkAskerThreads,
} from "./fork-asker";

const ASK_TEXT =
  "[Plannotator Ask AI] The user is asking about this. Answer it briefly, here in the session. Do not edit files.\nSurface: plan review\n\nWhy step 1?";

type Call = { method: string; args: Record<string, unknown> };

/** A fake bb threads SDK where each sent question becomes a completed turn. */
function fakeThreads(
  options: {
    forkError?: (args: Record<string, unknown>) => unknown;
    /** No turn ever completes (the agent hangs). */
    hang?: boolean;
    turnStatus?: string;
    answers?: string[];
    listed?: Array<Record<string, unknown>>;
  } = {},
) {
  const calls: Call[] = [];
  const answers = [...(options.answers ?? ["Because it is first."])];
  let forks = 0;
  let seq = 100;
  let lastOutput: string | null = null;
  const threads = {
    async fork(args: Record<string, unknown>) {
      calls.push({ method: "fork", args });
      const error = options.forkError?.(args);
      if (error) throw error;
      forks += 1;
      return { id: `fork-${forks}` };
    },
    async send(args: Record<string, unknown>) {
      calls.push({ method: "send", args });
      seq += 5;
      lastOutput = answers.shift() ?? "Another answer.";
      return {};
    },
    events: {
      async list(args: Record<string, unknown>) {
        calls.push({ method: "events.list", args });
        return [{ seq }];
      },
      async wait(args: Record<string, unknown>) {
        calls.push({ method: "events.wait", args });
        if (options.hang) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          if ((args.signal as AbortSignal | undefined)?.aborted) throw new Error("aborted");
          return null;
        }
        return { seq, type: "turn/completed", data: { status: options.turnStatus ?? "completed" } };
      },
    },
    async output(args: Record<string, unknown>) {
      calls.push({ method: "output", args });
      return { output: lastOutput };
    },
    async stop(args: Record<string, unknown>) {
      calls.push({ method: "stop", args });
      return {};
    },
    async archive(args: Record<string, unknown>) {
      calls.push({ method: "archive", args });
      return {};
    },
    async list(args: Record<string, unknown>) {
      calls.push({ method: "list", args });
      const rows = options.listed ?? [];
      options.listed = [];
      return rows;
    },
  };
  return { threads: threads as unknown as ForkAskerThreads, calls };
}

const signal = () => new AbortController().signal;
const methods = (calls: Call[]) => calls.map(({ method }) => method);

describe("ForkAsker", () => {
  it("answers in an idle hidden fork of the thread, waiting for the question's own turn", async () => {
    const { threads, calls } = fakeThreads();
    const asker = createForkAsker({ threads, sourceThreadId: "thr_main", sourceSeqEnd: 42, sessionId: "s-1" });

    await expect(asker.ask({ askId: "chat-1:1", text: ASK_TEXT }, signal())).resolves.toBe("Because it is first.");

    expect(calls[0]).toEqual({
      method: "fork",
      args: {
        sourceThreadId: "thr_main",
        lifecycleOwnerThreadId: "thr_main",
        visibility: "hidden",
        title: "Plannotator Ask AI",
        pluginMetadata: { plannotatorSessionId: "s-1" },
        sourceSeqEnd: 42,
      },
    });
    expect(methods(calls)).toEqual(["fork", "events.list", "send", "events.wait", "output"]);
    expect(calls[2]!.args).toMatchObject({
      threadId: "fork-1",
      mode: "queue-if-active",
      input: [{ type: "text", text: ASK_TEXT, mentions: [] }],
    });
    // The wait starts after the sequence read before the question was sent.
    expect(calls[3]!.args).toMatchObject({ threadId: "fork-1", type: "turn/completed", afterSeq: "100" });
    expect(asker.exchanges()).toEqual([{ question: "Why step 1?", answer: "Because it is first." }]);
  });

  it("reuses the chat's fork for a follow-up and opens a new one for another chat", async () => {
    const { threads, calls } = fakeThreads({ answers: ["One.", "Two.", "Three."] });
    const asker = createForkAsker({ threads, sourceThreadId: "thr_main", sessionId: "s-1" });

    await asker.ask({ askId: "chat-1:1", text: "first" }, signal());
    await expect(asker.ask({ askId: "chat-1:2", text: "follow-up" }, signal())).resolves.toBe("Two.");
    await asker.ask({ askId: "chat-2:1", text: "other chat" }, signal());

    expect(calls.filter(({ method }) => method === "fork")).toHaveLength(2);
    expect(calls.filter(({ method }) => method === "send").map(({ args }) => args.threadId)).toEqual([
      "fork-1",
      "fork-1",
      "fork-2",
    ]);
  });

  it("reports a failed fork, and lets the chat's next question try again", async () => {
    let fail = true;
    const { threads, calls } = fakeThreads({
      forkError: () => (fail ? Object.assign(new Error("provider cannot fork"), { code: "fork_unsupported" }) : null),
    });
    const asker = createForkAsker({ threads, sourceThreadId: "thr_main", sourceSeqEnd: 7, sessionId: "s-1" });

    await expect(asker.ask({ askId: "chat-1:1", text: "q" }, signal())).rejects.toThrow("provider cannot fork");
    expect(calls.filter(({ method }) => method === "fork")).toHaveLength(1);
    expect(asker.exchanges()[0]).toEqual({ question: "q", error: "provider cannot fork" });

    fail = false;
    await expect(asker.ask({ askId: "chat-1:2", text: "q again" }, signal())).resolves.toBeTruthy();
  });

  it("forks at the tip when the pinned point is not a completed turn", async () => {
    const { threads, calls } = fakeThreads({
      forkError: (args) =>
        args.sourceSeqEnd !== undefined
          ? Object.assign(new Error("the turn containing it has not completed"), {
              code: "fork_source_session_unavailable",
            })
          : null,
    });
    const asker = createForkAsker({ threads, sourceThreadId: "thr_main", sourceSeqEnd: 7, sessionId: "s-1" });

    await expect(asker.ask({ askId: "chat-1:1", text: "q" }, signal())).resolves.toBeTruthy();

    const forkCalls = calls.filter(({ method }) => method === "fork").map(({ args }) => args);
    expect(forkCalls).toHaveLength(2);
    expect(forkCalls[0]).toMatchObject({ sourceSeqEnd: 7 });
    expect(forkCalls[1]).not.toHaveProperty("sourceSeqEnd");
  });

  it("stops the fork and fails when the answer takes too long", async () => {
    const { threads, calls } = fakeThreads({ hang: true });
    const asker = createForkAsker({ threads, sourceThreadId: "thr_main", sessionId: "s-1", timeoutMs: 20 });

    await expect(asker.ask({ askId: "chat-1:1", text: "q" }, signal())).rejects.toThrow("did not answer");

    expect(calls).toContainEqual({ method: "stop", args: { threadId: "fork-1" } });
  });

  it("stops the fork when the question is cancelled, and reports a failed turn", async () => {
    const hanging = fakeThreads({ hang: true });
    const controller = new AbortController();
    const asker = createForkAsker({ threads: hanging.threads, sourceThreadId: "thr_main", sessionId: "s-1" });
    const pending = asker.ask({ askId: "chat-1:1", text: "q" }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 15));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(hanging.calls).toContainEqual({ method: "stop", args: { threadId: "fork-1" } });
    expect(asker.exchanges()[0]).toEqual({ question: "q", error: "cancelled" });

    const failed = fakeThreads({ turnStatus: "failed" });
    const other = createForkAsker({ threads: failed.threads, sourceThreadId: "thr_main", sessionId: "s-2" });
    await expect(other.ask({ askId: "c:1", text: "q" }, signal())).rejects.toThrow("could not answer (failed)");
  });

  it("stops and archives every fork once on dispose, and refuses later questions", async () => {
    const { threads, calls } = fakeThreads();
    const asker = createForkAsker({ threads, sourceThreadId: "thr_main", sessionId: "s-1" });
    await asker.ask({ askId: "chat-1:1", text: "q" }, signal());
    await asker.ask({ askId: "chat-2:1", text: "q" }, signal());

    await Promise.all([asker.dispose(), asker.dispose()]);

    const cleanup = calls.filter(({ method }) => method === "stop" || method === "archive");
    expect(cleanup).toHaveLength(4);
    expect(cleanup).toEqual(
      expect.arrayContaining(
        ["fork-1", "fork-2"].flatMap((threadId) => [
          { method: "stop", args: { threadId } },
          { method: "archive", args: { threadId } },
        ]),
      ),
    );
    await expect(asker.ask({ askId: "chat-3:1", text: "q" }, signal())).rejects.toThrow("ended");
  });

  it("sweeps only this plugin's live hidden forks", async () => {
    const thread = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      originKind: "fork",
      originPluginId: "plannotator",
      visibility: "hidden",
      archivedAt: null,
      ...overrides,
    });
    const { threads, calls } = fakeThreads({
      listed: [
        thread("fork-a"),
        thread("fork-b", { originPluginId: "side-chat" }),
        thread("fork-c", { visibility: "visible" }),
        thread("fork-d", { archivedAt: 1 }),
      ],
    });

    await expect(sweepForks(threads, "plannotator")).resolves.toBe(1);

    expect(calls[0]).toEqual({
      method: "list",
      args: { includeHidden: true, originKind: "fork", originPluginId: "plannotator", archived: false, limit: 100 },
    });
    expect(calls.filter(({ method }) => method === "archive")).toEqual([
      { method: "archive", args: { threadId: "fork-a" } },
    ]);
  });
});

describe("Ask AI summaries", () => {
  it("keys chats by askId prefix and strips upstream's header from questions", () => {
    expect(askChatId("3f1c-ai-session:2")).toBe("3f1c-ai-session");
    expect(askChatId("plain")).toBe("plain");
    expect(askQuestionText(ASK_TEXT)).toBe("Why step 1?");
    expect(askQuestionText("Just a question")).toBe("Just a question");
  });

  it("summarizes exchanges within a few KB", () => {
    expect(summarizeExchanges([], "review")).toBeNull();
    const short = summarizeExchanges(
      [
        { question: "Why step 1?", answer: "Because it is first." },
        { question: "And step 2?", error: "cancelled" },
      ],
      "review",
    );
    expect(short).toBe(
      "Ask AI exchanges during this review (answered in a hidden fork of this thread):\n1. Q: Why step 1?\n   A: Because it is first.\n2. Q: And step 2?\n   A: (no answer: cancelled)",
    );
    const long = summarizeExchanges(
      Array.from({ length: 20 }, (_, index) => ({ question: `Q${index} ${"x".repeat(1000)}`, answer: "y".repeat(2000) })),
      "code review",
    )!;
    expect(long.length).toBeLessThanOrEqual(4_100);
    expect(long).toMatch(/more exchange\(s\) omitted\)$/u);
  });
});
