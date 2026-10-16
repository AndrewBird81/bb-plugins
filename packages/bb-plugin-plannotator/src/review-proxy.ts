// The loopback proxy `tailscale serve` publishes for a review on a non-server
// host. Plannotator itself listens on a random loopback port.
//
// The Host check closes DNS rebinding from a page on the Mac. Everything else
// is the request filter BB's relay applies too (src/request-filter.ts).
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";
import {
  MAX_DECISION_BODY_BYTES,
  createRequestFilter,
  rewriteDecisionBody,
} from "./request-filter";

export { stripDecisionBody } from "./request-filter";

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

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(message);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      // Discard the rest without buffering it, and let the caller answer 413.
      // Destroying the socket instead would reach the browser as a 502.
      chunks.length = 0;
      req.off("data", collect);
      req.resume();
      resolveBody(null);
    };
    req.on("data", collect);
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
  const filter = await createRequestFilter(options);
  const framePolicy = frameAncestorsPolicy(options.frameAncestor);
  let publicHost = "";
  let publicOrigin = "";

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.headers.host ?? "").toLowerCase() !== publicHost) {
      reply(res, 421, "Misdirected request.");
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    let requested: URL;
    try {
      // WHATWG parsing, as upstream does: dot segments are resolved before the
      // denylist runs, and the normalized path is what gets forwarded.
      requested = new URL(req.url ?? "/", `http://${publicHost}`);
    } catch {
      reply(res, 400, "Invalid request URL.");
      return;
    }
    const decision = await filter({
      method,
      url: requested,
      origin: req.headers.origin,
      secFetchSite: typeof req.headers["sec-fetch-site"] === "string" ? req.headers["sec-fetch-site"] : undefined,
      upgrade: req.headers.upgrade !== undefined,
      allowedOrigins: [publicOrigin],
    });
    if (!decision.allowed) {
      reply(res, decision.status, decision.message);
      return;
    }
    const { url } = decision;

    const headers = forwardedRequestHeaders(req);
    if (decision.loopbackHost) headers.host = `127.0.0.1:${options.upstreamPort}`;
    let body: Uint8Array | null = null;
    if (decision.decisionBody) {
      const raw = await readBody(req, MAX_DECISION_BODY_BYTES);
      if (raw === null) {
        res.setHeader("connection", "close");
        reply(res, 413, "Request body too large.");
        return;
      }
      body = rewriteDecisionBody(raw);
      if (!body) {
        reply(res, 400, "Decision body must be a JSON object.");
        return;
      }
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
