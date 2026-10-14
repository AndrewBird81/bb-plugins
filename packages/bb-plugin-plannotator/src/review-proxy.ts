// The loopback proxy `tailscale serve` publishes for a review on a non-server
// host. Plannotator itself listens on a random loopback port.
//
// The Host and Origin checks close the two attacks from outside the tailnet:
// DNS rebinding from a page on the Mac, and cross-site requests from a page on
// any tailnet device. The path denylist is defence in depth against tailnet
// peers, who are inside BB's trust boundary. It is a denylist rather than an
// allowlist so new upstream endpoints keep working instead of breaking the UI
// silently.
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";

/** Endpoints a tailnet browser never needs during a review or annotation. */
const DENIED_PATHS: ReadonlyArray<{ path: string; prefix: boolean }> = [
  { path: "/api/host/", prefix: true },
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
];

/** Decision-body fields that write files or open apps on the host. */
const STRIPPED_DECISION_FIELDS = ["obsidian", "bear", "octarine"] as const;
const DECISION_PATHS = new Set(["/api/approve", "/api/deny"]);
const MAX_DECISION_BODY_BYTES = 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type ReviewProxyOptions = {
  /** The MagicDNS name the review is published on. */
  publicHostname: string;
  upstreamPort: number;
  /** Plannotator's working directory, which relative paths resolve against. */
  cwd: string;
  /** Directories `/api/image` and the file browser may read. */
  allowedRoots: readonly string[];
  /**
   * The bb page's origin. Only it and the review itself may frame the
   * review, which stops other sites from framing it to steal clicks.
   */
  frameAncestor?: string;
};

/** `frame-ancestors` for a review that bb iframes; null without a bb origin. */
export function frameAncestorsPolicy(frameAncestor: string | undefined): string | null {
  if (!frameAncestor) return null;
  try {
    const { origin, protocol } = new URL(frameAncestor);
    if (protocol !== "https:" && protocol !== "http:") return null;
    // 'self' keeps nested frames working, such as an annotated HTML document.
    return `frame-ancestors 'self' ${origin}`;
  } catch {
    return null;
  }
}

export type RunningReviewProxy = {
  port: number;
  close(): Promise<void>;
};

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

/**
 * Why a request is refused, or null when it may be forwarded. An `/api/image`
 * request is rewritten in place to the one absolute path upstream would serve.
 */
export async function refusalFor(
  url: URL,
  options: Pick<ReviewProxyOptions, "cwd">,
  isAllowedPath: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const path = url.pathname.toLowerCase();
  for (const denied of DENIED_PATHS) {
    if (denied.prefix ? path.startsWith(denied.path) || path === denied.path.replace(/\/$/u, "") : path === denied.path) {
      return "This Plannotator endpoint is not available through BB.";
    }
  }
  if (path.startsWith("/api/archive/") && url.searchParams.has("customPath")) {
    return "Custom archive paths are not available through BB.";
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
      if (!(await isAllowedPath(chosen))) return "Images outside the worktree are not available.";
      url.searchParams.set("path", chosen);
      url.searchParams.delete("base");
    }
  }
  if (path === "/api/reference/files" || path === "/api/reference/files/stream") {
    for (const raw of url.searchParams.getAll("dirPath")) {
      if (!(await isAllowedPath(resolveUserPath(raw, options.cwd)))) {
        return "Directories outside the worktree are not available.";
      }
    }
    // The stream also watches single files (and so their directory).
    for (const raw of url.searchParams.getAll("filePath")) {
      if (!(await isAllowedPath(resolveUserPath(raw, options.cwd)))) {
        return "Files outside the worktree are not available.";
      }
    }
  }
  return null;
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

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(message);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolveBody(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function forwardedRequestHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue;
    // Upstream's host-control and bridge endpoints take a bearer token. The
    // proxy never adds one and does not pass a browser's through either.
    if (name === "authorization") continue;
    headers[name] = value;
  }
  return headers;
}

function forwardedResponseHeaders(upstream: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue;
    if (name.startsWith("access-control-allow-")) continue;
    headers[name] = value;
  }
  return headers;
}

export async function startReviewProxy(
  port: number,
  options: ReviewProxyOptions,
): Promise<RunningReviewProxy> {
  const isAllowedPath = await createPathGuard(options.allowedRoots);
  const framePolicy = frameAncestorsPolicy(options.frameAncestor);
  let publicHost = "";
  let publicOrigin = "";

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.headers.host ?? "").toLowerCase() !== publicHost) {
      reply(res, 421, "Misdirected request.");
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      const sameOrigin =
        origin === undefined
          ? req.headers["sec-fetch-site"] === "same-origin"
          : origin.toLowerCase() === publicOrigin;
      if (!sameOrigin) {
        reply(res, 403, "Cross-origin requests are not allowed.");
        return;
      }
    }
    let url: URL;
    try {
      // WHATWG parsing, as upstream does: dot segments are resolved before the
      // denylist runs, and the normalized path is what gets forwarded.
      url = new URL(req.url ?? "/", `http://${publicHost}`);
    } catch {
      reply(res, 400, "Invalid request URL.");
      return;
    }
    const refusal = await refusalFor(url, options, isAllowedPath);
    if (refusal) {
      reply(res, 403, refusal);
      return;
    }

    const headers = forwardedRequestHeaders(req);
    let body: Buffer | null = null;
    if (DECISION_PATHS.has(url.pathname) && method !== "GET" && method !== "HEAD") {
      const raw = await readBody(req, MAX_DECISION_BODY_BYTES);
      if (raw === null) {
        reply(res, 413, "Request body too large.");
        return;
      }
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        parsed = null;
      }
      const stripped = stripDecisionBody(parsed);
      if (!stripped) {
        reply(res, 400, "Decision body must be a JSON object.");
        return;
      }
      body = Buffer.from(JSON.stringify(stripped));
      headers["content-type"] = "application/json";
      headers["content-length"] = String(body.length);
    }

    const upstream = httpRequest({
      host: "127.0.0.1",
      port: options.upstreamPort,
      method,
      path: `${url.pathname}${url.search}`,
      headers,
    });
    upstream.on("response", (upstreamRes) => {
      const headers = forwardedResponseHeaders(upstreamRes);
      if (framePolicy) {
        const existing = headers["content-security-policy"];
        headers["content-security-policy"] = [
          ...(existing === undefined ? [] : Array.isArray(existing) ? existing : [existing]),
          framePolicy,
        ];
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      // Event streams must reach the browser as they arrive.
      res.flushHeaders();
      pipeline(upstreamRes, res, () => undefined);
    });
    upstream.on("error", () => {
      if (!res.headersSent) reply(res, 502, "Plannotator is not reachable.");
      else res.destroy();
    });
    // A closed browser connection ends the upstream request, including streams.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    if (body) upstream.end(body);
    else pipeline(req, upstream, () => undefined);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) reply(res, 500, "Proxy error.");
      else res.destroy();
    });
  });
  // The plan review has no agent terminal or other WebSocket endpoint.
  server.on("upgrade", (_req: IncomingMessage, socket: Duplex) => {
    // Node drops its own socket error handler before `upgrade`; a reset peer
    // must not crash the worker.
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  publicHost = `${options.publicHostname.toLowerCase()}:${boundPort}`;
  publicOrigin = `https://${publicHost}`;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}
