// The guest page served by the share gateway, for people without BB.
//
// It loads BB's own stylesheet and the host's theme, and renders the thread
// with the same markup and classes as BB's thread view, so it looks like BB.
// Rows carry BB's `data-timeline-row-id`, so a cursor on a row in the host's
// BB lands on the same row here, and the other way round.
import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { accessDescriptions, canControl, canSend, guestAccessLabels, type Access } from "../src/access";
import {
  applyScrollPoint,
  createHighlightPainter,
  cursorOver,
  isAtBottom,
  readScrollPoint,
  scrollRatio,
  watchIntent,
  cursorPoint,
  readSelection,
  scrollViewportOf,
  type Locator,
  type Resolver,
} from "../src/sync-dom";
import type {
  Changes,
  ChangedFile,
  Cursor,
  EditorMirror,
  FileView,
  Info,
  PanelRegion,
  PanelTab as PanelTabInfo,
  Selection,
  LoginResponse,
  Participant,
  Region,
  Row,
  ServerMessage,
  Snapshot,
  View,
  WorkItem,
} from "../src/shared";

const shareId = /^\/s\/([a-z0-9]{8,40})\/?$/u.exec(location.pathname)?.[1] ?? null;
const sessionKey = `bb-live-share:${shareId}`;

/**
 * A link may carry the password in its fragment (`#p=…`). Browsers never send
 * the fragment to a server, so the relay and gateway never see it. Read it
 * once and take it out of the address bar and history.
 */
const linkPassword = (() => {
  const value = new URLSearchParams(location.hash.slice(1)).get("p");
  if (value !== null) history.replaceState(null, "", location.pathname + location.search);
  return value;
})();
const NAME_KEY = "bb-live-share:name";
const CURSOR_INTERVAL_MS = 50;

// ------------------------------------------------------------ utilities

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function api<T>(name: string, body: unknown, session?: string): Promise<T> {
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(session ? { "x-live-share-session": session } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    throw new ApiError(response.status, typeof json?.error === "string" ? json.error : `The host answered ${response.status}.`);
  }
  return json as T;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Follows the visitor's light or dark preference, like BB's System theme. */
function useColorScheme() {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.classList.toggle("dark", query.matches);
      document.documentElement.classList.toggle("light", !query.matches);
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}

function useHostTheme() {
  useEffect(() => {
    api<{ css: string }>("theme", {}).then(
      ({ css }) => {
        if (!css) return;
        const style = document.createElement("style");
        style.id = "bb-app-theme";
        style.textContent = css;
        document.head.appendChild(style);
      },
      () => undefined,
    );
  }, []);
}

// ---------------------------------------------------------------- icons

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {children}
    </svg>
  );
}

const ChevronRight = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);
const ArrowUp = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Svg>
);
const StopIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden className={className}>
    <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
  </svg>
);
const ToolIcon = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <path d="M4 17l6-6-6-6M12 19h8" />
  </Svg>
);
const ThoughtIcon = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 0 0 5 0" />
  </Svg>
);

// ------------------------------------------------------------- markdown

const markdownComponents: Components = {
  p: ({ children }) => <p className="mb-2 text-foreground last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 text-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 text-foreground">{children}</ol>,
  li: ({ children }) => <li className="mb-1 text-foreground">{children}</li>,
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-base font-semibold text-foreground first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-semibold text-foreground first:mt-0">{children}</h3>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="break-words underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-surface-selected-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border border-border">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-recessed">{children}</thead>,
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = /language-(\S+)/u.exec(className ?? "")?.[1];
    const text = String(children ?? "");
    if (!language && !text.includes("\n")) {
      return <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs">{children}</code>;
    }
    return (
      <div className="my-2 overflow-hidden rounded-md border border-border bg-surface-recessed">
        {language ? <div className="px-3 pt-2 text-xs text-muted-foreground">{language}</div> : null}
        <pre className="bb-code-highlight overflow-x-auto px-3 pb-3 pt-2">
          <code className="font-mono text-xs">{text.replace(/\n$/u, "")}</code>
        </pre>
      </div>
    );
  },
};

function MarkdownText({ text }: { text: string }) {
  return (
    <div data-markdown-preview="" className="max-w-none break-words text-sm leading-relaxed text-foreground">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>
        {text}
      </Markdown>
    </div>
  );
}

// ------------------------------------------------------------ timeline

/** BB's collapsible timeline row: a muted one-line toggle over its detail. */
function Collapsible({
  label,
  icon,
  meta,
  open,
  onToggle,
  nested,
  pending,
  children,
}: {
  label: string;
  icon?: ReactNode;
  meta?: string | null;
  open: boolean;
  onToggle(): void;
  nested?: boolean;
  pending?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="w-full rounded-md text-muted-foreground">
      <div className="group/timeline-row">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cx(
            "group/toggle flex w-full max-w-full cursor-pointer items-center justify-start gap-1 overflow-hidden py-0 text-left text-sm leading-5 transition-colors",
            nested ? "px-0 text-muted-foreground hover:text-foreground" : "px-2 text-subtle-foreground hover:text-muted-foreground",
          )}
        >
          <span className="min-w-0 max-w-full">
            <span className={cx("inline-flex min-w-0 max-w-full items-center gap-1.5", pending ? "opacity-70" : "opacity-40")}>
              {icon}
              <span className="inline-flex min-w-0 max-w-full items-baseline gap-1 overflow-hidden whitespace-nowrap text-sm leading-5" title={label}>
                <span className={cx("min-w-0 truncate whitespace-pre", nested ? "text-muted-foreground" : "text-subtle-foreground")}>{label}</span>
                {meta ? <span className="shrink-0 whitespace-pre tabular-nums text-muted-foreground">{meta}</span> : null}
              </span>
            </span>
          </span>
          {children ? (
            <ChevronRight
              className={cx(
                "pointer-events-none size-3 shrink-0 text-subtle-foreground/60 transition-[opacity,rotate] duration-200",
                open ? "rotate-90" : "opacity-0 group-hover/toggle:opacity-100",
              )}
            />
          ) : null}
        </button>
      </div>
      {open && children ? <div className={cx("pb-1 pt-0.5", nested ? "px-0" : "px-2")}>{children}</div> : null}
    </div>
  );
}

function WorkItemRow({ item }: { item: WorkItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-timeline-row-id={item.id}>
      <Collapsible
        nested
        label={item.title}
        meta={item.duration}
        icon={<ToolIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        pending={item.status === "pending"}
      >
        {item.detail ? (
          <div className="my-1 overflow-hidden rounded-md border border-border bg-surface-recessed">
            <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-xs text-foreground">{item.detail}</pre>
          </div>
        ) : null}
      </Collapsible>
    </div>
  );
}

function TimelineRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  if (row.kind === "message" && row.role === "user") {
    return (
      <div data-timeline-row-id={row.id}>
        <div className="w-full" data-message-column="">
          <div className="ml-auto flex w-fit max-w-[70%] flex-col items-end">
            <div className="max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground">
              <MarkdownText text={row.text} />
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (row.kind === "message") {
    return (
      <div data-timeline-row-id={row.id}>
        <div className="w-full px-2 text-sm font-normal leading-relaxed" data-message-column="">
          <MarkdownText text={row.text} />
        </div>
      </div>
    );
  }
  if (row.kind === "work") {
    return (
      <div data-timeline-row-id={row.id}>
        <Collapsible label={row.label} open={open} onToggle={() => setOpen((value) => !value)} pending={row.pending}>
          <div className="flex min-w-0 flex-col">
            {row.items.map((item) => (
              <WorkItemRow key={item.id} item={item} />
            ))}
          </div>
        </Collapsible>
      </div>
    );
  }
  return (
    <div data-timeline-row-id={row.id}>
      {row.tone === "error" ? (
        <div className="mx-2 rounded-md border border-border bg-surface-recessed px-3 py-2 text-sm text-destructive">
          {row.title}
          {row.text && row.text !== row.title ? <div className="mt-1 whitespace-pre-wrap text-xs">{row.text}</div> : null}
        </div>
      ) : (
        <Collapsible
          label={row.title}
          icon={/^Thought/u.test(row.title) ? <ThoughtIcon className="size-3.5 shrink-0 text-muted-foreground" /> : undefined}
          open={false}
          onToggle={() => undefined}
        />
      )}
    </div>
  );
}

/** One changed file, styled like a card in BB's diff panel. */
function FileCard({ file }: { file: ChangedFile }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => {
    const all = file.patch.split("\n");
    const start = all.findIndex((line) => line.startsWith("@@"));
    return start === -1 ? [] : all.slice(start);
  }, [file.patch]);
  const name = file.path.split("/").pop() ?? file.path;
  return (
    <div data-ls-anchor={`file:${file.path}`} className="overflow-clip rounded-lg border border-border bg-background">
      <div
        className={cx(
          "sticky top-0 rounded-lg bg-background py-1.5 pl-2 pr-3 text-xs font-medium text-foreground",
          open && "rounded-b-none",
        )}
        style={{ zIndex: 10 }}
      >
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${file.path}`}
            className="flex min-w-0 cursor-pointer items-center"
          >
            <span className="inline-flex w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight className={cx("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-90")} />
            </span>
            <span className="min-w-0 pl-[1ch] text-left font-mono text-xs font-medium leading-5 text-foreground" title={file.path}>
              <span dir="rtl" className="block w-min max-w-full truncate">
                {"\u200e"}
                {file.path === name ? name : file.path}
              </span>
            </span>
          </button>
          <span className="whitespace-nowrap text-xs">
            <span className="text-diff-added">+{file.additions}</span> <span className="text-diff-removed">-{file.deletions}</span>
          </span>
        </div>
      </div>
      {open ? (
        file.patch ? (
          <div className="overflow-x-auto rounded-b-lg border-t border-border bg-background">
            <pre className="py-1 font-mono text-foreground" style={{ fontSize: 12, lineHeight: "18px" }}>
              {lines.map((line, index) => {
                const kind = line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
                return (
                  <div
                    key={index}
                    className={cx("px-3", kind === "hunk" && "text-muted-foreground")}
                    style={
                      kind === "add"
                        ? { background: "color-mix(in srgb, var(--diff-added) 16%, transparent)" }
                        : kind === "del"
                          ? { background: "color-mix(in srgb, var(--diff-removed) 16%, transparent)" }
                          : undefined
                    }
                  >
                    {line || " "}
                  </div>
                );
              })}
            </pre>
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">This file is too large to show.</p>
        )
      ) : null}
    </div>
  );
}

const PanelIcon = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M15 4v16" />
  </Svg>
);
const DiffIcon = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <path d="M12 5v6M9 8h6M9 16h6" />
    <rect x="4" y="3" width="16" height="18" rx="3" />
  </Svg>
);

// -------------------------------------------------------------- cursors

const ROW_SELECTOR = "[data-timeline-row-id]";
const PANEL_ANCHOR = "[data-ls-anchor]";

function CursorSprites({ participants, selfId, resolve }: { participants: Participant[]; selfId: string; resolve: Resolver }) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex: 50 }}>
      {participants.map((participant) => {
        if (participant.id === selfId) return null;
        const point = cursorPoint(participant, resolve, scrollViewportOf);
        if (!point) return null;
        return (
          <div key={participant.id} className="absolute left-0 top-0" style={{ transform: `translate(${point.x}px, ${point.y}px)` }}>
            <svg width="16" height="20" viewBox="0 0 16 20" style={{ filter: "drop-shadow(0 1px 1px rgb(0 0 0 / 0.3))" }}>
              <path d="M1 1 L1 16 L5 12 L8 19 L11 17.8 L8 11 L14 11 Z" fill={participant.color} stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span
              className="absolute whitespace-nowrap rounded-md text-xs font-medium"
              style={{ left: 14, top: 16, padding: "2px 6px", lineHeight: 1.2, color: "white", backgroundColor: participant.color }}
            >
              {participant.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ info tab

/** One row in BB's thread info list. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-ls-anchor={`info:${label}`} className="grid items-center gap-x-3 py-0.5" style={{ gridTemplateColumns: "96px minmax(0,1fr)" }}>
      <dt className="m-0 text-xs leading-5 text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
      </dt>
      <dd className="m-0 min-w-0 truncate text-xs leading-5 text-foreground">{children}</dd>
    </div>
  );
}

function InfoView({ info }: { info: Info | null }) {
  if (!info) return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;
  const missing = <span className="text-muted-foreground">None</span>;
  return (
    <dl className="m-0 flex flex-col py-3">
      <div className="flex flex-col gap-1.5 pb-3">
        <InfoRow label="Project">{info.project ?? missing}</InfoRow>
        <InfoRow label="Environment">{info.environment ?? missing}</InfoRow>
        <InfoRow label="Branch">{info.branch ?? missing}</InfoRow>
        <InfoRow label="Merge base">{info.mergeBase ?? missing}</InfoRow>
        <InfoRow label="Git status">{info.gitStatus ?? missing}</InfoRow>
      </div>
      <div className="flex flex-col gap-1.5 border-t border-border pt-3">
        <div data-ls-anchor="info:Uncommitted files" className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">Uncommitted files</span>
          <span className="rounded-md bg-state-active px-1.5 text-muted-foreground">{info.files.length}</span>
          <span className="ml-auto">
            <span className="text-diff-added">+{info.additions}</span> <span className="text-diff-removed">-{info.deletions}</span>
          </span>
        </div>
        {info.files.length === 0 ? (
          <p className="text-xs text-muted-foreground">No uncommitted changes.</p>
        ) : (
          info.files.map((file) => {
            const name = file.path.split("/").pop() ?? file.path;
            const dir = file.path.slice(0, file.path.length - name.length).replace(/\/$/u, "");
            return (
              <div key={file.path} data-ls-anchor={`info-file:${file.path}`} className="flex min-w-0 items-center gap-2 text-xs leading-5" title={file.path}>
                <span className="min-w-0 truncate text-foreground">
                  {name} {dir ? <span className="text-subtle-foreground">{dir}</span> : null}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  <span className="text-diff-added">+{file.additions}</span> <span className="text-diff-removed">-{file.deletions}</span>
                </span>
              </div>
            );
          })
        )}
      </div>
    </dl>
  );
}

const InfoIcon = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);

/** People in the share. Click someone else to follow their view. */
function Avatars({
  participants,
  selfId,
  following,
  onFollow,
}: {
  participants: Participant[];
  selfId: string;
  following: string | null;
  onFollow(id: string | null): void;
}) {
  return (
    <div className="flex items-center">
      {participants.map((participant, index) => {
        const self = participant.id === selfId;
        const followed = participant.id === following;
        const label = `${participant.name}${self ? " (you)" : participant.role === "owner" ? " (host)" : ""}`;
        return (
          <button
            key={participant.id}
            type="button"
            disabled={self}
            aria-pressed={followed}
            title={self ? label : followed ? `Stop following ${participant.name}` : `Follow ${label}`}
            onClick={() => onFollow(followed ? null : participant.id)}
            className="grid size-6 cursor-pointer place-items-center rounded-full text-xs font-semibold uppercase disabled:cursor-default"
            style={{
              backgroundColor: participant.color,
              color: "white",
              marginLeft: index === 0 ? 0 : -6,
              boxShadow: followed
                ? `0 0 0 2px var(--background, #111), 0 0 0 4px ${participant.color}`
                : "0 0 0 2px var(--background, #111)",
              position: "relative",
              zIndex: followed ? 1 : 0,
            }}
          >
            {participant.name.slice(0, 1)}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- composer

function Composer({
  access,
  running,
  live,
  hostName,
  onSend,
  onStop,
}: {
  access: Access;
  running: boolean;
  live: boolean;
  hostName: string;
  onSend(text: string): Promise<void>;
  onStop(): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canSend(access)) {
    return (
      <div className="mx-auto w-full max-w-[760px] px-4 pb-4">
        <div className="rounded-xl border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
          You can watch this thread. {hostName} has not let you send messages.
        </div>
      </div>
    );
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(value);
      setText("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-4">
      <form onSubmit={submit} className="relative w-full rounded-xl border border-border bg-background shadow-lift">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={8000}
          disabled={!live}
          aria-label="Message"
          placeholder={running ? "Queue a message for the agent" : "Message the agent"}
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed text-foreground outline-none placeholder:text-subtle-foreground"
          style={{ minHeight: 68, maxHeight: "40vh" }}
        />
        <div className="flex items-center gap-3 pb-2 pl-3.5 pr-3 pt-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
            {error ? <span className="text-destructive">{error}</span> : running ? "The agent is working. Your message waits its turn." : `Shared by ${hostName}`}
          </span>
          {running && canControl(access) ? (
            <button
              type="button"
              aria-label="Stop run"
              onClick={() => void onStop().catch((cause) => setError(message(cause)))}
              className="inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md bg-secondary px-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80"
            >
              <StopIcon className="size-3.5" />
            </button>
          ) : null}
          <button
            type="submit"
            aria-label="Send"
            disabled={!text.trim() || busy || !live}
            className="inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md bg-foreground px-2 text-sm font-medium text-background disabled:pointer-events-none disabled:opacity-50"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </form>
    </div>
  );
}

// ----------------------------------------------------------------- views

type Session = LoginResponse;

function JoinScreen({ notice, onJoined }: { notice: string | null; onJoined(session: Session): void }) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  const [password, setPassword] = useState(() => (notice ? "" : linkPassword ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const fromLink = Boolean(linkPassword) && !notice;
  const autoJoined = useRef(false);

  // A link with the password and a remembered name joins without a form.
  useEffect(() => {
    if (fromLink && name.trim() && !autoJoined.current) {
      autoJoined.current = true;
      void submit();
    }
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api<Session>("login", { shareId, password, name: name.trim() });
      localStorage.setItem(NAME_KEY, name.trim());
      onJoined(session);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const input =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <main className="grid min-h-full place-items-center bg-background p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-background p-6 shadow-lift">
        <div className="space-y-1">
          <h1 className="text-base font-semibold text-foreground">Join a shared BB thread</h1>
          <p className="text-sm text-muted-foreground">
            {fromLink ? "Enter your name to join." : "Enter your name and the password the host sent you."}
          </p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-foreground">Your name</span>
          <input className={input} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoComplete="name" required />
        </label>
        {fromLink ? null : (
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-foreground">Password</span>
            <input className={input} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" required />
          </label>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !name.trim() || !password}
          className="inline-flex h-9 w-full cursor-pointer items-center justify-center rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:pointer-events-none disabled:opacity-50"
        >
          {busy ? "Joining…" : "Join"}
        </button>
        <p className="text-xs text-subtle-foreground">End-to-end encrypted. The relay cannot read this page.</p>
      </form>
    </main>
  );
}

function useThrottled(run: () => void, interval = 800) {
  const latest = useRef(run);
  latest.current = run;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(0);
  return useCallback(() => {
    const wait = interval - (Date.now() - last.current);
    if (wait <= 0) {
      last.current = Date.now();
      latest.current();
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        last.current = Date.now();
        latest.current();
      }, wait);
    }
  }, [interval]);
}

type TabRegion = PanelRegion;

/** A file the host has open in a panel tab, shown read-only with line numbers. */
function FileTabView({ file, error }: { file: FileView | null; error: string | null }) {
  if (error) return <p className="py-8 text-center text-sm text-muted-foreground">{error}</p>;
  if (!file) return <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>;
  if (file.binary) return <p className="py-8 text-center text-sm text-muted-foreground">This file is not text.</p>;
  const lines = file.content.split("\n");
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-background">
      <div className="border-b border-border px-3 py-1.5 font-mono text-xs text-foreground" title={file.path}>
        {file.path}
      </div>
      <pre className="overflow-x-auto py-1 font-mono text-foreground" style={{ fontSize: 12, lineHeight: "18px" }}>
        {lines.map((line, index) => (
          <div key={index} className="flex">
            <span className="shrink-0 select-none pr-3 text-right text-subtle-foreground" style={{ width: 48 }}>
              {index + 1}
            </span>
            <span className="whitespace-pre pr-3">{line || " "}</span>
          </div>
        ))}
      </pre>
      {file.truncated ? <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">The rest of the file is not shown.</p> : null}
    </div>
  );
}

/**
 * The host's VS Code tab, mirrored read-only: the file they have open, their
 * selection, and the lines on their screen, refreshed about once a second.
 */
function VSCodeMirror({ region, token, hostName }: { region: string; token: string; hostName: string }) {
  const [mirror, setMirror] = useState<EditorMirror | null>(null);
  const [content, setContent] = useState<{ hash: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLDivElement | null>(null);
  const lastManualScroll = useRef(0);
  const contentRef = useRef(content);
  contentRef.current = content;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = () => {
      api<EditorMirror>("vscode", { region, knownHash: contentRef.current?.hash ?? null }, token).then(
        (next) => {
          if (stopped) return;
          setMirror(next);
          setError(null);
          if (next.file && next.file.content !== null) setContent({ hash: next.file.hash, text: next.file.content });
          timer = setTimeout(poll, 1_000);
        },
        (cause) => {
          if (stopped) return;
          setError(message(cause));
          timer = setTimeout(poll, 3_000);
        },
      );
    };
    poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [region, token]);

  // Keep the host's visible lines in view, unless the guest scrolled lately.
  const visibleStart = mirror?.file?.visible?.startLine ?? null;
  const activePath = mirror?.file?.path ?? null;
  useLayoutEffect(() => {
    const code = codeRef.current;
    const scroller = code ? (code.closest(".thread-scrollbar") as HTMLElement | null) : null;
    if (!code || !scroller || visibleStart === null || Date.now() - lastManualScroll.current < 4_000) return;
    const line = code.querySelector<HTMLElement>(`[data-line="${visibleStart}"]`);
    if (line) scroller.scrollTop += line.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
  }, [visibleStart, activePath, content?.hash]);
  useEffect(() => {
    const scroller = codeRef.current?.closest(".thread-scrollbar");
    if (!scroller) return;
    const mark = (event: Event) => {
      if (event.isTrusted) lastManualScroll.current = Date.now();
    };
    scroller.addEventListener("wheel", mark, { passive: true });
    scroller.addEventListener("touchmove", mark, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", mark);
      scroller.removeEventListener("touchmove", mark);
    };
  }, [mirror !== null]);

  if (error && !mirror) return <p className="py-8 text-center text-sm text-muted-foreground">{error}</p>;
  if (!mirror) return <p className="py-8 text-center text-sm text-muted-foreground">Connecting to {hostName}'s VS Code…</p>;
  if (!mirror.available) return <p className="py-8 text-center text-sm text-muted-foreground">{mirror.message}</p>;
  const file = mirror.file;
  const selection = file?.selection;
  const hasSelection = selection && (selection.startLine !== selection.endLine || selection.startColumn !== selection.endColumn);
  const lines = file && content && file.reason === null ? content.text.split("\n") : [];
  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 text-xs text-muted-foreground">
          {hostName}'s VS Code{mirror.focused ? "" : " · in the background"}
        </span>
        {mirror.openFiles.map((path) => (
          <span
            key={path}
            title={path}
            className={cx(
              "max-w-48 truncate rounded-md px-1.5 py-0.5 font-mono text-xs",
              path === file?.path ? "bg-state-active text-foreground" : "text-muted-foreground",
            )}
          >
            {path.split("/").pop()}
          </span>
        ))}
      </div>
      {!file ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No file is open in {hostName}'s VS Code.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-xs text-foreground" title={file.path}>
            <span className="min-w-0 truncate">{file.path}</span>
            {file.unsaved ? <span className="shrink-0 text-muted-foreground">· unsaved changes not shown</span> : null}
          </div>
          {file.reason ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">{file.reason}</p>
          ) : (
            <div ref={codeRef} className="overflow-x-auto py-1 font-mono text-foreground" style={{ fontSize: 12, lineHeight: "18px" }}>
              {lines.map((line, index) => {
                const number = index + 1;
                const selected = hasSelection && selection && number >= selection.startLine && number <= selection.endLine;
                const cursorLine = !hasSelection && selection && number === selection.startLine;
                return (
                  <div
                    key={index}
                    data-line={number}
                    className="flex"
                    style={
                      selected
                        ? { background: "color-mix(in srgb, #e5484d 22%, transparent)" }
                        : cursorLine
                          ? { background: "color-mix(in srgb, currentColor 7%, transparent)" }
                          : undefined
                    }
                  >
                    <span className="shrink-0 select-none pr-3 text-right text-subtle-foreground" style={{ width: 48 }}>
                      {number}
                    </span>
                    <span className="whitespace-pre pr-3">{line || " "}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A tab only the host can see, such as a terminal or a browser. */
function HostOnlyTab({ title, hostName }: { title: string; hostName: string }) {
  return (
    <div className="flex flex-col items-center gap-1 py-16 text-center">
      <p className="text-sm text-foreground">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        This tab is open on {hostName}'s screen. It runs inside their BB, so it can't be shown here.
      </p>
    </div>
  );
}

function ThreadView({ session, onEnded }: { session: Session; onEnded(reason: string): void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Like BB's right panel: open by default when there is room for it.
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth >= 1100);
  const [panelTab, setPanelTab] = useState<TabRegion>("changes");
  const [tabs, setTabs] = useState<PanelTabInfo[]>([]);
  const [file, setFile] = useState<FileView | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [access, setAccess] = useState<Access>(session.access);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [live, setLive] = useState(false);
  const [, setFrame] = useState(0);
  const [following, setFollowing] = useState<string | null>(null);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const stick = useRef(true);
  const panelRef = useRef({ open: panelOpen, tab: panelTab });
  panelRef.current = { open: panelOpen, tab: panelTab };

  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onEnded(cause.message);
      else setError(message(cause));
    },
    [onEnded],
  );
  const loadSnapshot = useCallback(() => {
    api<Snapshot>("snapshot", {}, session.sessionToken).then((next) => {
      setSnapshot(next);
      setAccess(next.access);
      setError(null);
    }, fail);
  }, [session.sessionToken, fail]);
  const loadPanel = useCallback(() => {
    const { open, tab } = panelRef.current;
    if (!open) return;
    if (tab === "changes") api<Changes>("changes", {}, session.sessionToken).then(setChanges, fail);
    else if (tab === "info") api<Info>("info", {}, session.sessionToken).then(setInfo, fail);
    else {
      const path = tabsRef.current.find((candidate) => candidate.region === tab)?.path;
      if (!path) return;
      api<FileView>("file", { path }, session.sessionToken).then(
        (next) => {
          setFile(next);
          setFileError(null);
        },
        (cause) => setFileError(message(cause)),
      );
    }
  }, [session.sessionToken, fail]);
  // The host opens and closes tabs without thread activity, so poll the list.
  const loadTabs = useCallback(() => {
    api<{ tabs: PanelTabInfo[] }>("tabs", {}, session.sessionToken).then((next) => setTabs(next.tabs), () => undefined);
  }, [session.sessionToken]);
  useEffect(() => {
    loadTabs();
    const timer = setInterval(loadTabs, 4_000);
    return () => clearInterval(timer);
  }, [loadTabs]);
  const tabPaths = tabs.map((tab) => tab.path ?? "").join("\n");
  useEffect(() => {
    setFile(null);
    setFileError(null);
  }, [panelTab]);
  const refresh = useThrottled(() => {
    loadSnapshot();
    loadPanel();
  });

  useEffect(loadSnapshot, [loadSnapshot]);
  useEffect(loadPanel, [panelOpen, panelTab, tabPaths, loadPanel]);

  // One socket for presence, cursors, selections, and "the thread changed" pings.
  useEffect(() => {
    let closed = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const update = (id: string, patch: Partial<Participant>) =>
      setParticipants((current) => current.map((participant) => (participant.id === id ? { ...participant, ...patch } : participant)));
    const connect = () => {
      const url = new URL("/api/socket", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("session", session.sessionToken);
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onmessage = (event) => {
        const data = JSON.parse(String(event.data)) as ServerMessage;
        switch (data.type) {
          case "hello":
            attempts = 0;
            setLive(true);
            setAccess(data.access);
            setParticipants(data.participants);
            refresh();
            break;
          case "participants":
            setParticipants(data.participants);
            break;
          case "cursor":
            update(data.participantId, { region: data.region, cursor: data.cursor });
            break;
          case "selection":
            update(data.participantId, { selection: data.selection });
            break;
          case "view":
            update(data.participantId, { view: data.view });
            break;
          case "thread":
            setSnapshot((current) => (current ? { ...current, status: data.status } : current));
            refresh();
            break;
          case "access":
            setAccess(data.access);
            break;
          case "ended":
            closed = true;
            onEnded(data.reason);
            break;
        }
      };
      socket.onclose = (event) => {
        socketRef.current = null;
        setLive(false);
        if (closed) return;
        if (event.code === 4401) {
          onEnded("Your session ended. Enter the password again.");
          return;
        }
        attempts += 1;
        retry = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(attempts, 5)));
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close(1000);
    };
  }, [session.sessionToken, refresh, onEnded]);

  // Map shared anchors to this page's elements.
  const resolve = useCallback<Resolver>((region, anchor) => {
    if (region === "transcript") {
      if (!anchor) return scrollRef.current;
      return contentRef.current?.querySelector<HTMLElement>(`${ROW_SELECTOR.slice(0, -1)}="${CSS.escape(anchor)}"]`) ?? null;
    }
    const aside = asideRef.current;
    const { open, tab } = panelRef.current;
    if (!aside || !open || tab !== region) return null;
    if (!anchor) return aside;
    return aside.querySelector<HTMLElement>(`[data-ls-anchor="${CSS.escape(anchor)}"]`);
  }, []);

  const locate = useCallback<Locator>((node) => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return null;
    const row = contentRef.current?.contains(element) ? element.closest<HTMLElement>(ROW_SELECTOR) : null;
    if (row?.dataset.timelineRowId) return { region: "transcript", element: row, anchor: row.dataset.timelineRowId };
    const item = asideRef.current?.contains(element) ? element.closest<HTMLElement>(PANEL_ANCHOR) : null;
    if (item?.dataset.lsAnchor) return { region: panelRef.current.tab, element: item, anchor: item.dataset.lsAnchor };
    return null;
  }, []);

  // Send this guest's pointer and selection.
  const send = useCallback((payload: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(payload));
  }, []);
  useEffect(() => {
    let cursorTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingCursor: Cursor | undefined;
    let lastCursor = "";
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSelection = "null";
    const flushCursor = () => {
      cursorTimer = null;
      const cursor = pendingCursor ?? null;
      pendingCursor = undefined;
      const key = JSON.stringify(cursor);
      if (key === lastCursor) return;
      lastCursor = key;
      send({ type: "cursor", region: cursor?.region ?? null, cursor });
    };
    const cursorFor = (event: PointerEvent): Cursor => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return null;
      const aside = asideRef.current;
      if (aside?.contains(target)) {
        const tab = panelRef.current.tab;
        const item = target.closest<HTMLElement>(PANEL_ANCHOR);
        return item ? cursorOver(event, tab, item, item.dataset.lsAnchor ?? null, null, aside) : cursorOver(event, tab, aside, null);
      }
      const content = contentRef.current;
      if (!content || !scrollRef.current?.contains(target)) return null;
      let row = target.closest<HTMLElement>(ROW_SELECTOR);
      if (!row || !content.contains(row)) {
        let best: { element: HTMLElement; distance: number } | null = null;
        for (const element of content.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
          if (element.parentElement?.closest(ROW_SELECTOR)) continue;
          const rect = element.getBoundingClientRect();
          const distance = event.clientY < rect.top ? rect.top - event.clientY : Math.max(0, event.clientY - rect.bottom);
          if (!best || distance < best.distance) best = { element, distance };
        }
        row = best?.element ?? null;
      }
      if (!row) return null;
      const parent = row.parentElement?.closest<HTMLElement>(ROW_SELECTOR);
      return cursorOver(event, "transcript", row, row.dataset.timelineRowId ?? null, parent?.dataset.timelineRowId ?? null);
    };
    const onMove = (event: PointerEvent) => {
      pendingCursor = cursorFor(event);
      cursorTimer ??= setTimeout(flushCursor, CURSOR_INTERVAL_MS);
    };
    const onLeave = () => {
      pendingCursor = null;
      cursorTimer ??= setTimeout(flushCursor, CURSOR_INTERVAL_MS);
    };
    const onSelection = () => {
      selectionTimer ??= setTimeout(() => {
        selectionTimer = null;
        const selection: Selection = readSelection(locate);
        const key = JSON.stringify(selection);
        if (key === lastSelection) return;
        lastSelection = key;
        send({ type: "selection", selection });
      }, 120);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("selectionchange", onSelection);
      if (cursorTimer) clearTimeout(cursorTimer);
      if (selectionTimer) clearTimeout(selectionTimer);
    };
  }, [send, locate]);

  // Share this guest's view so others can follow it.
  const readView = useCallback((): View => {
    const { open, tab } = panelRef.current;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    const panelScroller = panelScrollRef.current;
    return {
      panel: open ? tab : null,
      top:
        scroller && content
          ? readScrollPoint(scroller, content.querySelectorAll<HTMLElement>(ROW_SELECTOR), (element) =>
              element.parentElement?.closest(ROW_SELECTOR) ? null : (element.dataset.timelineRowId ?? null),
            )
          : null,
      ratio: scroller ? scrollRatio(scroller) : null,
      atBottom: scroller ? isAtBottom(scroller) : true,
      panelTop:
        open && panelScroller
          ? readScrollPoint(panelScroller, panelScroller.querySelectorAll<HTMLElement>(PANEL_ANCHOR), (element) => element.dataset.lsAnchor ?? null)
          : null,
    };
  }, []);
  useEffect(() => {
    let last = "";
    const tick = () => {
      const view = readView();
      const key = JSON.stringify(view);
      if (key === last) return;
      last = key;
      send({ type: "view", view });
    };
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [readView, send, live]);

  // Follow: mirror the followed person's panel and scroll positions until
  // this guest scrolls or clicks on their own.
  const leader = following ? participants.find((participant) => participant.id === following) : undefined;
  useEffect(() => {
    if (following && !leader) setFollowing(null);
  }, [following, leader]);
  useEffect(() => {
    if (!following) return;
    return watchIntent(document, () => setFollowing(null));
  }, [following]);
  const leaderView = leader?.view ?? null;
  useLayoutEffect(() => {
    if (!following || !leaderView) return;
    if (leaderView.panel) {
      if (!panelRef.current.open) setPanelOpen(true);
      if (panelRef.current.tab !== leaderView.panel) {
        setPanelTab(leaderView.panel);
        if (!tabsRef.current.some((tab) => tab.region === leaderView.panel)) loadTabs();
      }
    } else if (panelRef.current.open) {
      setPanelOpen(false);
    }
    const scroller = scrollRef.current;
    if (scroller) {
      if (leaderView.atBottom) {
        scroller.scrollTop = scroller.scrollHeight;
        stick.current = true;
      } else if (leaderView.top) {
        const row = resolve("transcript", leaderView.top.anchor);
        if (row) applyScrollPoint(scroller, row, leaderView.top.fraction);
        else if (leaderView.ratio !== null) scroller.scrollTop = leaderView.ratio * (scroller.scrollHeight - scroller.clientHeight);
        stick.current = false;
      }
    }
    const panelScroller = panelScrollRef.current;
    if (panelScroller && leaderView.panel && leaderView.panelTop) {
      const item = panelScroller.querySelector<HTMLElement>(`[data-ls-anchor="${CSS.escape(leaderView.panelTop.anchor)}"]`);
      if (item) applyScrollPoint(panelScroller, item, leaderView.panelTop.fraction);
    }
  }, [following, leaderView, snapshot, changes, info, file, panelOpen, panelTab, resolve, loadTabs]);

  // Paint other people's selections.
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  const painter = useMemo(() => createHighlightPainter("ls-guest"), []);
  useEffect(() => () => painter.dispose(), [painter]);
  useEffect(() => {
    painter.paint(participants, session.participantId, resolve);
  }, [painter, participants, snapshot, changes, info, panelOpen, panelTab, session.participantId, resolve]);

  // Repaint cursors every frame while someone else's cursor is showing.
  const cursorsActive = participants.some((participant) => participant.id !== session.participantId && participant.cursor);
  useEffect(() => {
    if (!cursorsActive) return;
    let frame = 0;
    const loop = () => {
      setFrame((value) => (value + 1) % 1_000_000);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [cursorsActive]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && stick.current) scroller.scrollTop = scroller.scrollHeight;
  }, [snapshot]);

  const running = snapshot?.status === "active";
  const title = snapshot?.title ?? session.title;
  useEffect(() => {
    document.title = `${title} · BB Live Share`;
  }, [title]);

  const others = participants.filter((participant) => participant.id !== session.participantId);
  const iconButton =
    "inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground aria-pressed:bg-state-active aria-pressed:text-foreground";
  const tabPill = (tab: TabRegion, label: string, icon: ReactNode) => {
    const here = others.filter((participant) => participant.region === tab);
    return (
      <button
        type="button"
        aria-pressed={panelTab === tab}
        aria-label={`Show ${label.toLowerCase()} panel`}
        title={here.length > 0 ? `${label} · ${here.map((participant) => participant.name).join(", ")}` : label}
        onClick={() => setPanelTab(tab)}
        className="relative inline-flex h-7 min-w-0 max-w-40 shrink-0 cursor-pointer items-center rounded-md px-1.5 text-xs text-muted-foreground hover:bg-state-hover aria-pressed:bg-state-active aria-pressed:text-foreground"
      >
        {icon ?? <span className="truncate">{label}</span>}
        {here.length > 0 ? (
          <span className="absolute flex" style={{ right: 1, top: 1 }}>
            {here.map((participant) => (
              <span key={participant.id} className="size-1.5 rounded-full" style={{ backgroundColor: participant.color }} />
            ))}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 bg-background">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-4">
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</div>
          <span
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
            title={accessDescriptions[access]}
          >
            <span className="size-1.5 rounded-full" style={{ backgroundColor: live ? "#3fb950" : "#d29922" }} />
            {guestAccessLabels[access]}
          </span>
          {leader ? (
            <button
              type="button"
              onClick={() => setFollowing(null)}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
              style={{ backgroundColor: leader.color, color: "white" }}
              title="Scroll or click anywhere to stop following"
            >
              Following {leader.name} · Stop
            </button>
          ) : null}
          <Avatars participants={participants} selfId={session.participantId} following={following} onFollow={setFollowing} />
          {!panelOpen ? (
            <button type="button" className={iconButton} aria-label="Show right panel" onClick={() => setPanelOpen(true)}>
              <PanelIcon className="size-4" />
            </button>
          ) : null}
        </header>
        <div
          ref={scrollRef}
          className="thread-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          onScroll={(event) => {
            const element = event.currentTarget;
            stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          <div ref={contentRef} className="relative mx-auto flex w-full min-w-0 max-w-[760px] flex-col gap-2 px-4 pb-4 pt-4">
            {!snapshot ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{error ?? "Loading the thread…"}</p>
            ) : (
              <>
                {snapshot.hasOlderRows ? <p className="px-2 text-xs text-subtle-foreground">Earlier activity is not shown.</p> : null}
                {snapshot.rows.map((row) => (
                  <TimelineRow key={row.id} row={row} />
                ))}
                {running ? (
                  <div className="px-2 text-sm text-subtle-foreground">
                    <span className="animate-pulse">Working…</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
        <Composer
          access={access}
          running={running}
          live={live}
          hostName={session.hostName}
          onSend={async (text) => {
            await api("send", { text }, session.sessionToken);
            stick.current = true;
            refresh();
          }}
          onStop={async () => {
            await api("stop", {}, session.sessionToken);
          }}
        />
      </div>
      {panelOpen ? (
        <aside ref={asideRef} className="flex h-full min-h-0 w-1/2 max-w-[860px] shrink-0 flex-col overflow-hidden border-l border-border-seam bg-sidebar">
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
            <div role="toolbar" aria-label="Right panel views" className="flex min-w-0 flex-1 items-center gap-1">
              {tabPill("info", "Info", <InfoIcon className="size-3.5" />)}
              {tabPill("changes", "Diff", <DiffIcon className="size-3.5" />)}
              {tabs
                .filter((tab) => tab.kind !== "info" && tab.kind !== "diff")
                .map((tab) => (
                  <span key={tab.region}>{tabPill(tab.region, tab.title, null)}</span>
                ))}
            </div>
            <button type="button" className={iconButton} aria-label="Hide right panel" aria-pressed onClick={() => setPanelOpen(false)}>
              <PanelIcon className="size-4" />
            </button>
          </div>
          <div ref={panelScrollRef} className="thread-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {panelTab === "info" ? (
              <InfoView info={info} />
            ) : panelTab !== "changes" ? (
              (() => {
                const tab = tabs.find((candidate) => candidate.region === panelTab);
                if (tab?.kind === "file") return <FileTabView file={file} error={fileError} />;
                if (tab?.kind === "vscode") return <VSCodeMirror region={tab.region} token={session.sessionToken} hostName={session.hostName} />;
                return <HostOnlyTab title={tab?.title ?? panelTab.slice("tab:".length)} hostName={session.hostName} />;
              })()
            ) : (
              <div className="flex flex-col gap-2">
                {!changes ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">Loading changes…</p>
                ) : !changes.available ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">{changes.message ?? "No changes to show."}</p>
                ) : changes.files.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No uncommitted changes.</p>
                ) : (
                  <>
                    <div className="flex h-9 items-center text-xs text-muted-foreground">
                      <span className="rounded-md border border-border bg-background px-2 py-1 text-foreground">
                        {changes.scope === "all" ? "All changes" : "Uncommitted changes"}
                      </span>
                      <span className="ml-auto">
                        {changes.files.length} {changes.files.length === 1 ? "file" : "files"},{" "}
                        <span className="text-diff-added">+{changes.files.reduce((sum, file) => sum + file.additions, 0)}</span>{" "}
                        <span className="text-diff-removed">-{changes.files.reduce((sum, file) => sum + file.deletions, 0)}</span>
                        {changes.truncated ? " · truncated" : ""}
                      </span>
                    </div>
                    {changes.files.map((file) => (
                      <FileCard key={file.path} file={file} />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>
      ) : null}
      <CursorSprites participants={participants} selfId={session.participantId} resolve={resolve} />
      {leader ? (
        <div aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex: 40, boxShadow: `inset 0 0 0 3px ${leader.color}` }} />
      ) : null}
    </div>
  );
}

function App() {
  useColorScheme();
  useHostTheme();
  const [session, setSession] = useState<Session | null>(() => {
    try {
      const raw = sessionStorage.getItem(sessionKey);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  });
  const [notice, setNotice] = useState<string | null>(null);

  const onJoined = useCallback((next: Session) => {
    sessionStorage.setItem(sessionKey, JSON.stringify(next));
    setNotice(null);
    setSession(next);
  }, []);
  const onEnded = useCallback((reason: string) => {
    sessionStorage.removeItem(sessionKey);
    setSession(null);
    setNotice(reason);
  }, []);

  if (!shareId) {
    return (
      <main className="grid min-h-full place-items-center p-4 text-sm text-muted-foreground">
        This link is incomplete. Ask the host for the full share link.
      </main>
    );
  }
  return session ? <ThreadView session={session} onEnded={onEnded} /> : <JoinScreen notice={notice} onJoined={onJoined} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
