// The Plannotator panel when no session is open: start a code review or an
// annotation. Commands and the message action hand the panel a request.
import { useEffect, useRef, useState } from "react";
import { useRpc, useSdk } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";

export type LaunchRequest =
  | { mode: "review"; diffType?: DiffType }
  | { mode: "annotate"; path: string }
  | { mode: "annotate-last"; markdown?: string };

type DiffType =
  | "since-base"
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "branch"
  | "merge-base"
  | "all";

export const DIFF_TYPE_OPTIONS: ReadonlyArray<{ value: DiffType; label: string }> = [
  { value: "since-base", label: "All changes since base" },
  { value: "uncommitted", label: "Uncommitted changes" },
  { value: "staged", label: "Staged changes" },
  { value: "unstaged", label: "Unstaged changes" },
  { value: "last-commit", label: "Last commit" },
  { value: "branch", label: "Branch commits" },
  { value: "merge-base", label: "Since merge-base" },
  { value: "all", label: "All files" },
];

const ANNOTATABLE = /\.(md|markdown|html?)$/iu;
/** A request older than this was for a panel that never opened. */
const PANEL_REQUEST_TTL_MS = 30_000;

/**
 * What a command or message action asks the thread's Plannotator panel to
 * do. They hand it over in memory, not as panel params: bb gives each
 * distinct params value its own tab, and a thread has one Plannotator tab.
 */
export type PanelRequest =
  | { kind: "launch"; request: LaunchRequest }
  | { kind: "view"; view: "annotate-file" };

const pendingPanelRequests = new Map<string, { request: PanelRequest; at: number }>();
const panelRequestListeners = new Set<() => void>();

export function requestPanel(threadId: string, request: PanelRequest): void {
  pendingPanelRequests.set(threadId, { request, at: Date.now() });
  for (const listener of panelRequestListeners) listener();
}

/** Drop a request whose panel did not open, so a later panel cannot start it. */
export function cancelPanelRequest(threadId: string, request: PanelRequest): void {
  if (pendingPanelRequests.get(threadId)?.request === request) pendingPanelRequests.delete(threadId);
}

function takePanelRequest(threadId: string): PanelRequest | null {
  const pending = pendingPanelRequests.get(threadId);
  pendingPanelRequests.delete(threadId);
  return pending && Date.now() - pending.at <= PANEL_REQUEST_TTL_MS ? pending.request : null;
}

/** Run `handle` for each request addressed to this thread's panel. */
export function usePanelRequests(threadId: string, handle: (request: PanelRequest) => void): void {
  const handler = useRef(handle);
  handler.current = handle;
  useEffect(() => {
    const drain = () => {
      const request = takePanelRequest(threadId);
      if (request) handler.current(request);
    };
    panelRequestListeners.add(drain);
    drain();
    return () => {
      panelRequestListeners.delete(drain);
    };
  }, [threadId]);
}

const buttonClass =
  "rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-state-hover disabled:opacity-60";

function AnnotateFilePicker({
  threadId,
  disabled,
  onPick,
  autoFocus,
}: {
  threadId: string;
  disabled: boolean;
  onPick: (path: string) => void;
  autoFocus: boolean;
}) {
  const sdk = useSdk();
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void sdk.threads
      .get({ threadId })
      .then((thread) => {
        if (!cancelled) setEnvironmentId(thread.environmentId);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the thread's workspace.");
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId]);

  useEffect(() => {
    if (!environmentId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void sdk.environments
        .paths({
          environmentId,
          includeFiles: "true",
          includeDirectories: "false",
          query: query.trim() || "md",
          limit: "50",
        })
        .then((result) => {
          if (cancelled) return;
          setError(null);
          setPaths(result.paths.map(({ path }) => path).filter((path) => ANNOTATABLE.test(path)));
        })
        .catch(() => {
          if (!cancelled) setError("Could not search the workspace.");
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sdk, environmentId, query]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <input
        type="search"
        aria-label="Search Markdown and HTML files"
        placeholder="Search .md and .html files"
        className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
        value={query}
        autoFocus={autoFocus}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
      <ul className="max-h-64 overflow-auto text-xs">
        {paths.map((path) => (
          <li key={path}>
            <button
              type="button"
              disabled={disabled}
              className="w-full truncate rounded px-2 py-1 text-left text-foreground hover:bg-state-hover disabled:opacity-60"
              title={path}
              onClick={() => onPick(path)}
            >
              {path}
            </button>
          </li>
        ))}
        {environmentId && paths.length === 0 && !error ? (
          <li className="px-2 py-1 text-muted-foreground">No Markdown or HTML files match.</li>
        ) : null}
      </ul>
    </div>
  );
}

export type SessionStarter = {
  start(request: LaunchRequest): void;
  busy: boolean;
  /** Why the last start did nothing, or what happened to a session. */
  message: string | null;
  notify(message: string | null): void;
};

/** Start sessions through the server; shared by the launcher and panel requests. */
export function useSessionStarter(threadId: string): SessionStarter {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const start = (request: LaunchRequest) => {
    setBusy(true);
    setMessage(null);
    void rpc
      .call("startSession", { threadId, request })
      .then((result) => {
        if (result.status === "already_active") {
          setMessage("A Plannotator session is already open in this thread.");
        } else if (result.status === "error") {
          setMessage(result.error ?? "Plannotator could not start.");
        }
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };
  return { start, busy, message, notify: setMessage };
}

export function SessionLauncher({
  threadId,
  starter,
  focusFilePicker,
}: {
  threadId: string;
  starter: SessionStarter;
  focusFilePicker: boolean;
}) {
  const { start, busy, message } = starter;
  const [diffType, setDiffType] = useState<DiffType>("since-base");

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto bg-background p-4 text-sm">
      <div className="text-muted-foreground">
        Agents open plan reviews here. You can also start one of these yourself; feedback
        you send arrives in this thread as a new message.
      </div>
      {busy ? <div className="text-xs text-muted-foreground">Starting Plannotator…</div> : null}
      {message ? <div className="text-xs text-destructive">{message}</div> : null}
      <section className="flex flex-col gap-2">
        <div className="font-medium text-foreground">Review changes</div>
        <div className="flex items-center gap-2">
          <select
            aria-label="Diff type"
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
            value={diffType}
            onChange={(event) => setDiffType(event.target.value as DiffType)}
          >
            {DIFF_TYPE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => start({ mode: "review", ...(diffType !== "since-base" ? { diffType } : {}) })}
          >
            Review changes
          </button>
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <div className="font-medium text-foreground">Annotate last finished reply</div>
        <div className="text-xs text-muted-foreground">
          The agent's last finished reply; a turn still running is never used.
        </div>
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => start({ mode: "annotate-last" })}
          >
            Annotate last finished reply
          </button>
        </div>
      </section>
      <section className="flex min-h-0 flex-col gap-2">
        <div className="font-medium text-foreground">Annotate file…</div>
        <AnnotateFilePicker
          threadId={threadId}
          disabled={busy}
          autoFocus={focusFilePicker}
          onPick={(path) => start({ mode: "annotate", path })}
        />
      </section>
    </div>
  );
}
