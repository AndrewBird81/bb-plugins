// How each Plannotator session mode is launched and how its result is read.
// Plan review keeps the hook protocol on stdin and stdout. Code review and
// annotation write one JSON record to `PLANNOTATOR_HOST_RESULT_FILE` instead.
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  sessionResultSchema,
  type SessionMode,
  type SessionRequest,
  type SessionResult,
} from "./host-contract";

/** How BB names each mode to agents, in messages and KV records. */
export type SessionKind = "plan" | "code-review" | "annotate" | "annotate-reply";

export const SESSION_KINDS: Record<SessionMode, SessionKind> = {
  plan: "plan",
  review: "code-review",
  annotate: "annotate",
  "annotate-last": "annotate-reply",
};

export const ANNOTATE_EXTENSIONS = new Set([".md", ".markdown", ".html", ".htm"]);

export type SessionLaunch = {
  args: string[];
  /** Written to the child's stdin; null leaves stdin closed. */
  stdin: string | null;
  env: Record<string, string>;
  /** Removed from the inherited environment. */
  deleteEnv: string[];
  /** Where the session writes its result; null for plan review (stdout). */
  resultFile: string | null;
};

export function buildUpstreamInput(planMarkdown: string): string {
  // Feed the official generic plan-review hook. Unlike the OpenCode-specific
  // bridge, this path uses PLANNOTATOR_ORIGIN when constructing /api/plan.
  return JSON.stringify({
    hook_event_name: "PermissionRequest",
    permission_mode: "default",
    tool_input: { plan: planMarkdown },
  });
}

/**
 * The argv, stdin and environment for one session. Arguments are argv
 * entries, never shell text. Upstream accepts a result file only as a
 * `result.json` under `<data dir>/claude-code-mod/`.
 */
export function buildSessionLaunch(
  request: SessionRequest,
  options: { dataDir?: string; sessionId: string; remote: boolean },
): SessionLaunch {
  const env: Record<string, string> = {};
  // The agent terminal is a shell in the browser. Never inherit a setting that
  // exposes it beyond loopback.
  const deleteEnv = ["PLANNOTATOR_AGENT_TERMINAL_REMOTE"];
  // A remote (pod) session must not upload documents to the paste service.
  if (options.remote) env.PLANNOTATOR_SHARE = "disabled";
  if (request.mode === "plan") {
    return { args: [], stdin: buildUpstreamInput(request.planMarkdown), env, deleteEnv, resultFile: null };
  }

  if (!options.dataDir) {
    throw new Error("Plannotator needs a data directory for code review and annotation.");
  }
  const resultFile = join(options.dataDir, "claude-code-mod", options.sessionId, "result.json");
  env.PLANNOTATOR_HOST_RESULT_FILE = resultFile;
  env.PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL = "1";
  // Upstream resolves paths and the reviewed repo against PLANNOTATOR_CWD
  // before the process cwd, which is the thread's worktree.
  deleteEnv.push("PLANNOTATOR_CWD", "PLANNOTATOR_HOST_MESSAGES_FILE");

  switch (request.mode) {
    case "review":
      return {
        args: [
          "review",
          "--no-git-remote-check",
          ...(request.diffType ? ["--diff-type", request.diffType] : []),
          ...(request.base ? ["--base", request.base] : []),
        ],
        stdin: null,
        env,
        deleteEnv,
        resultFile,
      };
    case "annotate":
      if (!isAbsolute(request.path)) throw new Error("The file to annotate must be an absolute path.");
      // No --json: with --gate it turns on a client lease that dismisses the
      // session 30 s after the last tab disconnects.
      return { args: ["annotate", "--gate", request.path], stdin: null, env, deleteEnv, resultFile };
    case "annotate-last":
      return {
        args: ["annotate-last", "--stdin", "--gate"],
        stdin: request.markdown,
        env,
        deleteEnv,
        resultFile,
      };
  }
}

/** Read the result record of a session that exited with code 0. */
export async function readSessionResult(path: string): Promise<SessionResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      "Plannotator exited without a result. The plannotator on this machine is too old or ignored the result file; code review and annotation need 0.28.6 or later.",
    );
  }
  let record: unknown;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error("Plannotator wrote an unreadable result file.");
  }
  if (typeof record !== "object" || record === null) {
    throw new Error("Plannotator wrote an unreadable result file.");
  }
  const { surface, decision, message, noop, annotationCount, target } = record as Record<string, unknown>;
  const parsed = sessionResultSchema.safeParse({
    surface,
    decision,
    message,
    noop,
    ...(annotationCount !== undefined ? { annotationCount } : {}),
    ...(target !== undefined ? { target } : {}),
  });
  if (!parsed.success) {
    throw new Error(`Plannotator wrote a result BB does not understand (decision ${String(decision)}).`);
  }
  return parsed.data;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The real path of a Markdown or HTML file inside the worktree. Symlinks are
 * resolved, so a link that leaves the worktree is refused.
 */
export async function resolveAnnotateTarget(cwd: string, path: string): Promise<string> {
  const requested = resolve(cwd, path);
  if (!ANNOTATE_EXTENSIONS.has(extname(requested).toLowerCase())) {
    throw new Error("Only Markdown (.md, .markdown) and HTML (.html, .htm) files can be annotated.");
  }
  let real: string;
  let realCwd: string;
  try {
    [real, realCwd] = await Promise.all([realpath(requested), realpath(cwd)]);
  } catch {
    throw new Error(`${path} does not exist in the thread's worktree.`);
  }
  if (!isWithin(real, realCwd)) {
    throw new Error(`${path} is outside the thread's worktree.`);
  }
  if (!(await stat(real)).isFile()) throw new Error(`${path} is not a file.`);
  if (!ANNOTATE_EXTENSIONS.has(extname(real).toLowerCase())) {
    throw new Error("Only Markdown (.md, .markdown) and HTML (.html, .htm) files can be annotated.");
  }
  return real;
}

type FetchLike = typeof fetch;

/**
 * Refuse to publish an annotation session whose agent terminal is on: it is a
 * shell in the browser. Annotate must report the field; a missing field means
 * BB cannot tell, which counts as on.
 */
export async function assertAgentTerminalOff(
  port: number,
  mode: SessionMode,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  if (mode !== "annotate" && mode !== "annotate-last") return;
  let body: unknown;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/plan`, {
      signal: AbortSignal.timeout(10_000),
    });
    body = await response.json();
  } catch (error) {
    throw new Error(
      `Could not confirm that Plannotator's agent terminal is off: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const terminal = (body as { agentTerminal?: unknown } | null)?.agentTerminal;
  const enabled =
    typeof terminal === "object" && terminal !== null
      ? (terminal as { enabled?: unknown }).enabled
      : undefined;
  if (enabled === true) {
    throw new Error("Plannotator enabled its agent terminal, so BB did not publish the session.");
  }
  if (mode === "annotate" && enabled !== false) {
    throw new Error("Could not confirm that Plannotator's agent terminal is off, so BB did not publish the session.");
  }
}
