// Projects BB timeline rows into the rows the guest page renders.
//
// The grouping and ids follow BB's own thread view: within a turn, each run of
// tool and thinking rows between messages becomes one summary row whose id is
// `<threadId>:<turnId>:work-summary:<first row id>`. Matching ids is what lets
// a cursor on a row in BB land on the same row on the guest page.
import type { Row, WorkItem } from "./shared.js";

const MAX_ROW_TEXT = 20_000;
const MAX_ITEM_TEXT = 3_000;
const MAX_ROWS = 400;

type Raw = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** BB reply directives such as `::next{…}` render as UI in BB, not as text. */
export function stripDirectives(text: string): string {
  return text.replace(/^::[a-z][\w-]*\{[^\n]*\}[ \t]*$/gmu, "").trimEnd();
}

function isReasoning(row: Raw): boolean {
  return row.kind === "system" && row.systemKind === "operation" && row.operationKind === "reasoning";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

type Category = "explored" | "ran-command" | "ran-tool" | "researched" | "created" | "edited";

/** "Explored 2 searches, 1 file, ran 1 command", in order of first use. */
export function summaryLabel(rows: ReadonlyArray<Raw>): string {
  const categories = new Map<Category, Map<string, number>>();
  const seenFiles = new Set<string>();
  const bump = (category: Category, unit: string, path?: string) => {
    // BB counts a file read twice in one run as one file.
    if (path) {
      const key = `${category}:${path}`;
      if (seenFiles.has(key)) return;
      seenFiles.add(key);
    }
    const units = categories.get(category) ?? new Map<string, number>();
    units.set(unit, (units.get(unit) ?? 0) + 1);
    categories.set(category, units);
  };
  for (const row of rows) {
    switch (row.workKind) {
      case "command": {
        const intents = Array.isArray(row.activityIntents) ? (row.activityIntents as Raw[]) : [];
        const explored = intents.filter((intent) => ["list_files", "search", "read"].includes(str(intent.type)));
        if (explored.length === 0) bump("ran-command", "command");
        for (const intent of explored) {
          if (intent.type === "read") bump("explored", "file", str(intent.path) || undefined);
          else bump("explored", intent.type === "list_files" ? "list" : "search");
        }
        break;
      }
      case "file-read":
        bump("explored", "file", str(row.path) || undefined);
        break;
      case "file-change": {
        const change = (row.change ?? {}) as Raw;
        bump(change.kind === "add" ? "created" : "edited", "file", str(change.path) || undefined);
        break;
      }
      case "web-search":
        bump("researched", "query");
        break;
      case "web-fetch":
        bump("researched", "page");
        break;
      default:
        bump("ran-tool", "tool");
    }
  }
  const nouns: Record<string, [string, string]> = {
    list: ["list", "lists"],
    search: ["search", "searches"],
    file: ["file", "files"],
    command: ["command", "commands"],
    tool: ["tool", "tools"],
    query: ["search query", "search queries"],
    page: ["web page", "web pages"],
  };
  const verbs: Record<Category, string> = {
    explored: "explored",
    "ran-command": "ran",
    "ran-tool": "ran",
    researched: "researched",
    created: "created",
    edited: "edited",
  };
  const parts = [...categories].map(([category, units]) => {
    const counts = [...units].map(([unit, count]) => plural(count, ...nouns[unit]!));
    return `${verbs[category]} ${counts.join(", ")}`;
  });
  const label = parts.join(", ");
  return label ? label[0]!.toUpperCase() + label.slice(1) : "Worked";
}

function itemTitle(row: Raw): string {
  const presentation = (row.presentation ?? {}) as {
    label?: { completed?: string; pending?: string };
    title?: string;
  };
  const pending = row.status === "pending";
  let label = (pending ? presentation.label?.pending : presentation.label?.completed) ?? str(row.workKind);
  // "Ran command" + "ls -la" reads better as "Ran ls -la".
  label = label.replace(/ (command|tool)$/u, "");
  const subject = presentation.title ?? str(row.toolName);
  return subject ? `${label} ${subject}` : label;
}

function itemDetail(row: Raw): string {
  if (row.workKind === "file-change") {
    const change = (row.change ?? {}) as Raw;
    return str(change.diff);
  }
  return str(row.output);
}

function durationLabel(row: Raw): string | null {
  const started = Number(row.startedAt);
  const completed = Number(row.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed <= started) return null;
  const seconds = Math.round((completed - started) / 1000);
  if (seconds < 1) return null;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function projectTimeline(threadId: string, rows: ReadonlyArray<Raw>): Row[] {
  const out: Row[] = [];
  let group: { turnId: string; rows: Raw[] } | null = null;

  const flush = () => {
    if (!group) return;
    const work = group.rows.filter((row) => row.kind === "work");
    if (work.length > 0) {
      const items: WorkItem[] = work.slice(-200).map((row) => ({
        id: str(row.id),
        title: truncate(itemTitle(row), 400),
        detail: truncate(itemDetail(row), MAX_ITEM_TEXT),
        duration: durationLabel(row),
        status: str(row.status) || null,
      }));
      out.push({
        kind: "work",
        id: `${threadId}:${group.turnId}:work-summary:${str(group.rows[0]!.id)}`,
        label: summaryLabel(work),
        pending: work.some((row) => row.status === "pending"),
        items,
      });
    } else {
      for (const row of group.rows) {
        out.push({ kind: "note", id: str(row.id), title: str(row.title) || "Thought", text: "", tone: "muted" });
      }
    }
    group = null;
  };

  for (const row of rows) {
    const id = str(row.id);
    if (!id) continue;
    const turnId = str(row.turnId);
    if (turnId && (row.kind === "work" || isReasoning(row))) {
      if (group && group.turnId !== turnId) flush();
      group ??= { turnId, rows: [] };
      group.rows.push(row);
      continue;
    }
    flush();
    if (row.kind === "conversation") {
      const role = row.role === "assistant" ? "assistant" : "user";
      const text = role === "assistant" ? stripDirectives(str(row.text)) : str(row.text);
      // A reply that was only a directive has nothing to show.
      if (!text.trim()) continue;
      out.push({ kind: "message", id, role, text: truncate(text, MAX_ROW_TEXT) });
    } else if (row.kind === "system") {
      const title = str(row.title);
      if (!title) continue;
      const error = row.systemKind === "error";
      out.push({
        kind: "note",
        id,
        title: truncate(title, 400),
        text: error ? truncate(str(row.detail), MAX_ITEM_TEXT) : "",
        tone: error ? "error" : "muted",
      });
    }
  }
  flush();
  return out.slice(-MAX_ROWS);
}
