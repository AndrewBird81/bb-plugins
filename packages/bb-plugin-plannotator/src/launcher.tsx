// The Plannotator panel when no session is open: start a code review or an
// annotation. Commands and the message action open the panel with a `launch`
// request, which starts once.
import { useEffect, useRef, useState } from "react";
import { useRpc, useSdk, type JsonValue } from "@get-bb/plugin-sdk/app";
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
const LAUNCHED_KEY = "plannotator-launched";

/** Panel params that start a session when the panel opens. */
export function launchParams(request: LaunchRequest): JsonValue {
  // randomUUID needs a secure context; bb may be served over plain HTTP.
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { launch: { id, request } } as JsonValue;
}

export function parseLaunchParams(
  value: unknown,
): { launch?: { id: string; request: LaunchRequest }; view?: "annotate-file" } {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  if (record.view === "annotate-file") return { view: "annotate-file" };
  const launch = record.launch as Record<string, unknown> | undefined;
  if (!launch || typeof launch.id !== "string" || typeof launch.request !== "object" || launch.request === null) {
    return {};
  }
  const request = launch.request as Record<string, unknown>;
  if (request.mode === "review") {
    const diffType = DIFF_TYPE_OPTIONS.find(({ value }) => value === request.diffType)?.value;
    return { launch: { id: launch.id, request: { mode: "review", ...(diffType ? { diffType } : {}) } } };
  }
  if (request.mode === "annotate" && typeof request.path === "string") {
    return { launch: { id: launch.id, request: { mode: "annotate", path: request.path } } };
  }
  if (request.mode === "annotate-last") {
    return {
      launch: {
        id: launch.id,
        request: {
          mode: "annotate-last",
          ...(typeof request.markdown === "string" && request.markdown ? { markdown: request.markdown } : {}),
        },
      },
    };
  }
  return {};
}

/** A launch tab survives a reload; start each launch once per browser session. */
function claimLaunch(id: string): boolean {
  try {
    const launched = new Set<string>(JSON.parse(sessionStorage.getItem(LAUNCHED_KEY) ?? "[]") as string[]);
    if (launched.has(id)) return false;
    launched.add(id);
    sessionStorage.setItem(LAUNCHED_KEY, JSON.stringify([...launched].slice(-50)));
    return true;
  } catch {
    return true;
  }
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

export function SessionLauncher({ threadId, params }: { threadId: string; params: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const { launch, view } = parseLaunchParams(params);
  const [diffType, setDiffType] = useState<DiffType>("since-base");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const launched = useRef<string | null>(null);

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

  useEffect(() => {
    if (!launch || launched.current === launch.id || !claimLaunch(launch.id)) return;
    launched.current = launch.id;
    start(launch.request);
    // `start` is stable enough: it only reads the thread and the rpc client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch?.id]);

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
        <div className="font-medium text-foreground">Annotate last reply</div>
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => start({ mode: "annotate-last" })}
          >
            Annotate last reply
          </button>
        </div>
      </section>
      <section className="flex min-h-0 flex-col gap-2">
        <div className="font-medium text-foreground">Annotate file…</div>
        <AnnotateFilePicker
          threadId={threadId}
          disabled={busy}
          autoFocus={view === "annotate-file"}
          onPick={(path) => start({ mode: "annotate", path })}
        />
      </section>
    </div>
  );
}
