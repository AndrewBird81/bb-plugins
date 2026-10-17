// The thread's last finished assistant reply. `threads.output` returns the
// latest agent message even while a turn is running, so an agent that calls
// `plannotator_annotate_reply` mid-turn would annotate its own preamble.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Threads = BbPluginApi["sdk"]["threads"];
export type LastReplyThreads = Pick<Threads, "output"> & { events: Pick<Threads["events"], "list"> };

type Row = { seq: number; type: string; scope?: unknown; data?: unknown };
const TURN_PAGE_SIZE = 100;

function turnIdOf(row: Row): string | null {
  const scope = row.scope as { kind?: unknown; turnId?: unknown } | undefined;
  return scope?.kind === "turn" && typeof scope.turnId === "string" ? scope.turnId : null;
}

function agentMessageText(row: Row): string | null {
  const item = (row.data as { item?: { type?: unknown; text?: unknown } } | undefined)?.item;
  return item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim() ? item.text : null;
}

/**
 * The text of the thread's last finished assistant reply, or null. `running`
 * says a turn is in progress, whose text is never used.
 */
export async function lastFinishedReply(
  threads: LastReplyThreads,
  threadId: string,
  signal?: AbortSignal,
): Promise<{ reply: string | null; running: boolean }> {
  // The latest top-level turn; nested (sub-agent) turns carry a parent tool
  // call. A turn can start more of them than one page holds.
  let latest: Row | undefined;
  for (let beforeSeq: number | undefined; ; ) {
    const started = (await threads.events.list({
      threadId,
      types: ["turn/started"],
      order: "desc",
      limit: String(TURN_PAGE_SIZE),
      ...(beforeSeq !== undefined ? { beforeSeq: String(beforeSeq) } : {}),
      ...(signal ? { signal } : {}),
    })) as Row[];
    latest = started.find((row) => !(row.data as { parentToolCallId?: unknown } | undefined)?.parentToolCallId);
    if (latest || started.length < TURN_PAGE_SIZE) break;
    beforeSeq = started.at(-1)!.seq;
  }
  const latestTurnId = latest ? turnIdOf(latest) : null;
  const output = async () => ({
    reply: (await threads.output({ threadId, ...(signal ? { signal } : {}) })).output,
    running: false,
  });
  if (!latest || !latestTurnId) return output();

  const completed = (await threads.events.list({
    threadId,
    types: ["turn/completed"],
    order: "desc",
    limit: "20",
    afterSeq: String(latest.seq),
    ...(signal ? { signal } : {}),
  })) as Row[];
  if (completed.some((row) => turnIdOf(row) === latestTurnId)) return output();

  // A turn is running: its messages are not finished. Use the last agent
  // message before it started.
  const messages = (await threads.events.list({
    threadId,
    types: ["item/completed"],
    order: "desc",
    limit: "100",
    beforeSeq: String(latest.seq),
    ...(signal ? { signal } : {}),
  })) as Row[];
  for (const row of messages) {
    const text = agentMessageText(row);
    if (text) return { reply: text, running: true };
  }
  return { reply: null, running: true };
}
