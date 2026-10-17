import { describe, expect, it } from "vitest";
import { lastFinishedReply, type LastReplyThreads } from "./last-reply";

type Row = { seq: number; type: string; scope?: unknown; data?: unknown };

/** A thread's event log, filtered and paged the way bb's events.list is. */
function threadsWith(rows: Row[], output: string): LastReplyThreads {
  return {
    output: async () => ({ output }) as never,
    events: {
      list: (async (args: { types?: string[]; order?: string; limit?: string; beforeSeq?: string; afterSeq?: string }) => {
        let selected = rows.filter((row) => !args.types || args.types.includes(row.type));
        if (args.beforeSeq !== undefined) selected = selected.filter((row) => row.seq < Number(args.beforeSeq));
        if (args.afterSeq !== undefined) selected = selected.filter((row) => row.seq > Number(args.afterSeq));
        if (args.order === "desc") selected = [...selected].reverse();
        return selected.slice(0, Number(args.limit ?? 100));
      }) as never,
    },
  };
}

const turn = (turnId: string) => ({ kind: "turn", turnId });

describe("lastFinishedReply", () => {
  it("finds the running top-level turn behind more sub-agent turns than one page holds", async () => {
    const rows: Row[] = [
      { seq: 1, type: "turn/started", scope: turn("t-1") },
      { seq: 2, type: "item/completed", scope: turn("t-1"), data: { item: { type: "agentMessage", text: "Finished reply" } } },
      { seq: 3, type: "turn/completed", scope: turn("t-1") },
      { seq: 4, type: "turn/started", scope: turn("t-2") },
      ...Array.from({ length: 150 }, (_, index) => ({
        seq: 5 + index,
        type: "turn/started",
        scope: turn(`sub-${index}`),
        data: { parentToolCallId: `call-${index}` },
      })),
    ];

    await expect(lastFinishedReply(threadsWith(rows, "Partial text of t-2"), "thread-1")).resolves.toEqual({
      reply: "Finished reply",
      running: true,
    });
  });
});
