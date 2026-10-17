// The request filter in front of every Plannotator session a browser reaches:
// the review proxy on a Mac and BB's relay on the server machine apply the
// same rules.
//
// The Origin check closes cross-site requests from other web pages. The path
// denylist is defence in depth against tailnet peers, who are inside BB's
// trust boundary. It is a denylist rather than an allowlist so new upstream
// endpoints keep working instead of breaking the UI silently.
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Endpoints a browser never needs during a review or annotation. */
const DENIED_PATHS: ReadonlyArray<{ path: string; prefix: boolean }> = [
  { path: "/api/host/", prefix: true },
  // The session bridge is BB's own channel to Plannotator, never the browser's.
  { path: "/api/ai/bridge/", prefix: true },
  { path: "/api/plan/vscode-diff", prefix: false },
  { path: "/api/save-notes", prefix: false },
  { path: "/api/obsidian/", prefix: true },
  { path: "/api/reference/obsidian/", prefix: true },
  { path: "/api/hooks/status", prefix: false },
  { path: "/api/open-in", prefix: true },
  { path: "/api/agent-terminal", prefix: true },
  // PR mode only; BB never opens a PR review.
  { path: "/api/pr-action", prefix: false },
  // Downloads and builds a native runtime on the host.
  { path: "/api/call-flow/install", prefix: false },
  // The VS Code extension's injection API; the browser UI uses it only inside VS Code.
  { path: "/api/editor-annotation", prefix: true },
  // Runs the install script; bb manages the binary. Upstream allows it for a
  // loopback Host, which the relay always sends.
  { path: "/api/update", prefix: false },
];

/**
 * Upstream answers these with the session bridge (Ask AI by the thread's
 * agent) only when the Host header names its own loopback address. The
 * filter's Origin check runs before the rewrite.
 */
const LOOPBACK_HOST_PATHS = new Set(["/api/ai/session", "/api/ai/query"]);

/**
 * Upstream's own answer for a remote session, where opening files in a
 * desktop app is unavailable. The open-in UI then hides itself, where a
 * refusal would leave a failed request on every load.
 */
const OPEN_IN_APPS_UNAVAILABLE = JSON.stringify({ available: false, apps: [] });

/** Decision-body fields that write files or open apps on the host. */
const STRIPPED_DECISION_FIELDS = ["obsidian", "bear", "octarine"] as const;
const DECISION_PATHS = new Set(["/api/approve", "/api/deny"]);
/**
 * Plannotator's plan server answers ok to every decision after the first and
 * drops it, so a second device would be told its decision was sent.
 */
const ALREADY_DECIDED = JSON.stringify({ error: "This review already has a decision." });
export const MAX_DECISION_BODY_BYTES = 1024 * 1024;

/**
 * Where the UI reads the "Ask this session" provider's label. Upstream names
 * only its own bridge hosts (Pi, OpenCode, Claude Code, T3 Code), so a codex
 * thread's bridge would otherwise say OpenCode.
 */
const CAPABILITIES_PATH = "/api/ai/capabilities";
const SESSION_BRIDGE_PROVIDER_NAME = "session-bridge";
export const MAX_CAPABILITIES_BODY_BYTES = 1024 * 1024;

/**
 * Upstream serves worktree images, SVG included, with no CSP. An SVG (or any
 * XML document) opened in its own tab would run its script on the review's
 * origin, where it could approve the review or prompt the thread's agent. An
 * empty sandbox stops that; `<img>` rendering ignores the policy.
 */
const SCRIPTABLE_IMAGE_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
/**
 * Annotated HTML may embed an SVG as a document that runs script. Upstream
 * gives its HTML assets an opaque origin with script, and so does this.
 */
const HTML_ASSET_DOCUMENT_POLICY = "sandbox allow-scripts";

/** The CSP for a scriptable image at `pathname` (see isScriptableImage). */
export function scriptableImagePolicy(pathname: string): string {
  return pathname.startsWith("/api/html-assets/") ? HTML_ASSET_DOCUMENT_POLICY : SCRIPTABLE_IMAGE_POLICY;
}

/** Whether a non-HTML response can run script when opened as a document. */
export function isScriptableImage(contentType: string | undefined): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type === "text/xml" || type === "application/xml" || type.endsWith("+xml");
}

/** The "Ask this session" label for a thread's bb provider. */
export function sessionBridgeLabel(providerName: string | undefined): string {
  const name = providerName?.trim();
  return name ? `Ask this session · ${name}` : "Ask this session";
}

export type RequestFilterOptions = {
  /** Plannotator's working directory, which relative paths resolve against. */
  cwd: string;
  /** Directories `/api/image` and the file browser may read. */
  allowedRoots: readonly string[];
  /** Replaces upstream's label for the session-bridge Ask AI provider. */
  sessionBridgeLabel?: string;
};

export type FilterRequest = {
  method: string;
  url: URL;
  origin: string | undefined;
  secFetchSite: string | undefined;
  /** The request asks for a protocol upgrade, such as a WebSocket. */
  upgrade: boolean;
  /** Origins whose pages may write: the review's own, or the bb page's. */
  allowedOrigins: readonly string[];
};

export type FilterDecision =
  | { allowed: false; status: 403; message: string }
  /** Answered here with this JSON body; nothing reaches upstream. */
  | { allowed: false; status: 200 | 409; json: string }
  | {
      allowed: true;
      /** The URL to forward, with `/api/image` resolved to one absolute path. */
      url: URL;
      /** Send `Host: 127.0.0.1:<upstream port>`. */
      loopbackHost: boolean;
      /** An approve/deny body: buffer it and pass it through `stripDecisionBody`. */
      decisionBody: boolean;
      /**
       * The session's one decision is claimed for this request. Call this
       * when the request did not succeed, so another decision may be sent.
       */
      releaseDecision?: () => void;
      /** Relabel the response's session-bridge provider with `relabelCapabilitiesBody`. */
      sessionBridgeLabel?: string;
    };

export type RequestFilter = (request: FilterRequest) => Promise<FilterDecision>;

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Upstream's `resolveUserPath`: trim, unquote, expand `~`, resolve against cwd. */
function resolveUserPath(input: string, cwd: string): string {
  let value = input.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    value = value.slice(1, -1);
  }
  // Upstream expands `~\` on every platform, not only on Windows.
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(2));
  return resolve(cwd, value);
}

async function createPathGuard(roots: readonly string[]) {
  const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
  const allRoots = [...roots, ...realRoots];
  // A lexical check, then the symlink-resolved target when it exists.
  return async (path: string): Promise<boolean> => {
    if (!roots.some((root) => isWithin(path, root)) && !realRoots.some((root) => isWithin(path, root))) {
      return false;
    }
    const real = await realpath(path).catch(() => null);
    return real === null || allRoots.some((root) => isWithin(real, root));
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function refuse(message: string): FilterDecision {
  return { allowed: false, status: 403, message };
}

function isSameOrigin(request: FilterRequest): boolean {
  if (request.origin === undefined) return request.secFetchSite === "same-origin";
  const origin = request.origin.toLowerCase();
  return request.allowedOrigins.some((allowed) => allowed.toLowerCase() === origin);
}

/** Build the filter for one session. */
export async function createRequestFilter(options: RequestFilterOptions): Promise<RequestFilter> {
  const isAllowedPath = await createPathGuard(options.allowedRoots);
  let decisionClaimed = false;

  return async (request) => {
    if (request.upgrade) return refuse("Plannotator sessions in BB have no WebSocket endpoints.");
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && !isSameOrigin(request)) {
      return refuse("Cross-origin requests are not allowed.");
    }
    const url = new URL(request.url.href);
    const path = url.pathname.toLowerCase();
    if (path === "/api/open-in/apps" && (method === "GET" || method === "HEAD")) {
      return { allowed: false, status: 200, json: OPEN_IN_APPS_UNAVAILABLE };
    }
    for (const denied of DENIED_PATHS) {
      if (denied.prefix ? path.startsWith(denied.path) || path === denied.path.replace(/\/$/u, "") : path === denied.path) {
        return refuse("This Plannotator endpoint is not available through BB.");
      }
    }
    if (path.startsWith("/api/archive/") && url.searchParams.has("customPath")) {
      return refuse("Custom archive paths are not available through BB.");
    }
    if (path === "/api/image") {
      const raw = url.searchParams.get("path");
      if (raw !== null) {
        // Upstream serves `path` resolved against its cwd when that file
        // exists, and otherwise `path` under `base` (a document's directory).
        const direct = resolve(options.cwd, raw);
        const base = url.searchParams.get("base");
        const viaBase = base !== null && !raw.startsWith("/") ? resolve(options.cwd, base, raw) : null;
        const chosen = viaBase && !(await isFile(direct)) && (await isFile(viaBase)) ? viaBase : direct;
        if (!(await isAllowedPath(chosen))) return refuse("Images outside the worktree are not available.");
        url.searchParams.set("path", chosen);
        url.searchParams.delete("base");
      }
    }
    if (path === "/api/reference/files" || path === "/api/reference/files/stream") {
      for (const raw of url.searchParams.getAll("dirPath")) {
        if (!(await isAllowedPath(resolveUserPath(raw, options.cwd)))) {
          return refuse("Directories outside the worktree are not available.");
        }
      }
      // The stream also watches single files (and so their directory).
      for (const raw of url.searchParams.getAll("filePath")) {
        if (!(await isAllowedPath(resolveUserPath(raw, options.cwd)))) {
          return refuse("Files outside the worktree are not available.");
        }
      }
    }
    const writes = method !== "GET" && method !== "HEAD";
    const claimsDecision = method === "POST" && DECISION_PATHS.has(url.pathname);
    if (claimsDecision) {
      if (decisionClaimed) return { allowed: false, status: 409, json: ALREADY_DECIDED };
      decisionClaimed = true;
    }
    return {
      allowed: true,
      url,
      loopbackHost: method === "POST" && LOOPBACK_HOST_PATHS.has(url.pathname),
      decisionBody: writes && DECISION_PATHS.has(url.pathname),
      ...(claimsDecision ? { releaseDecision: () => (decisionClaimed = false) } : {}),
      ...(method === "GET" && url.pathname === CAPABILITIES_PATH && options.sessionBridgeLabel
        ? { sessionBridgeLabel: options.sessionBridgeLabel }
        : {}),
    };
  };
}

/**
 * Whether a capabilities response may be buffered and relabelled: a 200,
 * uncompressed JSON body. Anything else passes through untouched.
 */
export function isRelabelableCapabilities(
  status: number,
  contentType: string | undefined,
  contentEncoding: string | undefined,
): boolean {
  const encoding = contentEncoding?.trim().toLowerCase() ?? "";
  return (
    status === 200 &&
    (encoding === "" || encoding === "identity") &&
    (contentType ?? "").toLowerCase().startsWith("application/json")
  );
}

/**
 * Set the label of the one session-bridge provider in a capabilities body.
 * Null, so the original bytes pass through, when the body is not the compact
 * JSON upstream sends or does not have exactly one such provider.
 */
export function relabelCapabilitiesBody(raw: Uint8Array, label: string): Uint8Array | null {
  const text = Buffer.from(raw).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Re-serializing must reproduce the body, so only the label changes.
  if (JSON.stringify(parsed) !== text) return null;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const providers = (parsed as Record<string, unknown>).providers;
  if (!Array.isArray(providers)) return null;
  const bridges = providers.filter(
    (provider): provider is Record<string, unknown> =>
      typeof provider === "object" &&
      provider !== null &&
      !Array.isArray(provider) &&
      (provider as Record<string, unknown>).name === SESSION_BRIDGE_PROVIDER_NAME,
  );
  if (bridges.length !== 1 || typeof bridges[0]!.label !== "string" || bridges[0]!.label === label) return null;
  bridges[0]!.label = label;
  return Buffer.from(JSON.stringify(parsed));
}

/** Remove fields that would write files or open apps from an approve/deny body. */
export function stripDecisionBody(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const stripped: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const field of STRIPPED_DECISION_FIELDS) delete stripped[field];
  const planSave = stripped.planSave;
  if (typeof planSave === "object" && planSave !== null && !Array.isArray(planSave)) {
    const { customPath: _customPath, ...rest } = planSave as Record<string, unknown>;
    stripped.planSave = rest;
  }
  return stripped;
}

/** Parse and strip a buffered approve/deny body; null when it is not a JSON object. */
export function rewriteDecisionBody(raw: Uint8Array): Uint8Array | null {
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(Buffer.from(raw).toString("utf8")) : {};
  } catch {
    return null;
  }
  const stripped = stripDecisionBody(parsed);
  return stripped ? Buffer.from(JSON.stringify(stripped)) : null;
}
