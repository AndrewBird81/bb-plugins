// Live Share host worker: the public gateway and its OpenTunnel connection.
//
// The gateway is the only thing the tunnel can reach. It serves:
//   /s/<share>    the guest page (a browser app; no BB needed)
//   /guest.js     that page's script, bundled from guest/
//   /assets/<f>   BB's own stylesheet and fonts, read-only, so the page
//                 looks like BB
//   /api/<name>   -> /api/v1/plugins/<id>/http/guest/<name>
//   /api/socket   -> /api/v1/plugins/<id>/http/guest/socket (WebSocket)
// It never forwards anything else, so the rest of the BB API stays private.
import * as http from "node:http";
import * as net from "node:net";
import { experimental_defineHostEntry, type ExperimentalHostRpcContext } from "@get-bb/plugin-sdk/host";
import { create as createTunnelClient, OpenTunnelStorage } from "@opentunnel/client";
import {
  hostContract,
  hostSignals,
  type Exposure,
  type GatewayStatus,
} from "./src/contract.js";
import { GUEST_JS } from "./src/guest-bundle.generated.js";

const TUNNEL_PROFILE = "live-share";
const TUNNEL_ROUTE = "bb";
const MAX_BODY_BYTES = 256 * 1024;
const TUNNEL_RETRY_MS = 30_000;
const API_NAME = /^[a-z][a-z0-9-]{0,40}$/u;
const SHARE_PATH = /^\/s\/[a-z0-9]{8,40}\/?$/u;
const ASSET_PATH = /^\/assets\/[A-Za-z0-9._-]{1,120}\.(css|woff2)$/u;
const ASSET_TYPES: Record<string, string> = { css: "text/css; charset=utf-8", woff2: "font/woff2" };
const STYLESHEET_TTL_MS = 60_000;

type Upstream = { baseUrl: URL; pluginId: string; token: string };

type Gateway = {
  key: string;
  server: http.Server;
  port: number;
  exposure: Exposure;
  upstream: Upstream;
  lease: { dispose(): Promise<void> | void };
  abort: AbortController;
  tunnelClient: ReturnType<typeof createTunnelClient> | null;
  tunnelClose: (() => Promise<void>) | null;
};

let gateway: Gateway | null = null;
let status: GatewayStatus = {
  running: false,
  exposure: null,
  localUrl: null,
  publicUrl: null,
  tunnel: "off",
  error: null,
};
let emit: ((next: GatewayStatus) => void) | null = null;

function setStatus(patch: Partial<GatewayStatus>): void {
  status = { ...status, ...patch };
  emit?.(status);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function pageHtml(stylesheets: string[]): string {
  const links = stylesheets
    .map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}">`)
    .join("");
  return `<!doctype html>
<html lang="en" class="bb-app-shell-root dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>BB Live Share</title>${links}
<style>html,body,#root{height:100%;margin:0}body{background:var(--background);color:var(--foreground)}</style>
</head><body><div id="root"></div><script type="module" src="/guest.js"></script></body></html>`;
}

let stylesheetCache: { at: number; hrefs: string[] } | null = null;

/** BB's own stylesheet links, read from its index page. */
async function bbStylesheets(upstream: Upstream): Promise<string[]> {
  if (stylesheetCache && Date.now() - stylesheetCache.at < STYLESHEET_TTL_MS) return stylesheetCache.hrefs;
  try {
    const html = await (await fetch(upstream.baseUrl, { signal: AbortSignal.timeout(5_000) })).text();
    const hrefs = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="(\/assets\/[A-Za-z0-9._-]+\.css)"/gu)].map(
      (match) => match[1]!,
    );
    stylesheetCache = { at: Date.now(), hrefs };
    return hrefs;
  } catch {
    return stylesheetCache?.hrefs ?? [];
  }
}

async function proxyAsset(upstream: Upstream, path: string, extension: string, res: http.ServerResponse): Promise<void> {
  try {
    const response = await fetch(new URL(path, upstream.baseUrl), { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return sendText(res, 404, "not found");
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(200, {
      "content-type": ASSET_TYPES[extension] ?? "application/octet-stream",
      "cache-control": "public, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch (error) {
    sendText(res, 502, `upstream unavailable: ${errorText(error)}`);
  }
}

function sendText(
  res: http.ServerResponse,
  code: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    ...(type.startsWith("text/html") ? { "content-security-policy": PAGE_CSP } : {}),
  });
  res.end(body);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function upstreamPath(upstream: Upstream, name: string): string {
  return `/api/v1/plugins/${encodeURIComponent(upstream.pluginId)}/http/guest/${name}`;
}

async function proxyApi(
  upstream: Upstream,
  name: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== "POST") return sendText(res, 405, "method not allowed");
  const body = await readBody(req);
  if (body === null) return sendText(res, 413, "request too large");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-bb-plugin-token": upstream.token,
  };
  const session = req.headers["x-live-share-session"];
  if (typeof session === "string") headers["x-live-share-session"] = session;
  try {
    const response = await fetch(new URL(upstreamPath(upstream, name), upstream.baseUrl), {
      method: "POST",
      headers,
      body: body.length > 0 ? new Uint8Array(body) : "{}",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    res.writeHead(response.status, {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(text);
  } catch (error) {
    sendText(res, 502, `upstream unavailable: ${errorText(error)}`);
  }
}

function handleRequest(upstream: Upstream) {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const read = req.method === "GET" || req.method === "HEAD";
    if (url.pathname === "/" || SHARE_PATH.test(url.pathname)) {
      if (!read) return sendText(res, 405, "method not allowed");
      void bbStylesheets(upstream).then((hrefs) => sendText(res, 200, pageHtml(hrefs), "text/html; charset=utf-8"));
      return;
    }
    if (url.pathname === "/guest.js") {
      if (!read) return sendText(res, 405, "method not allowed");
      return sendText(res, 200, GUEST_JS, "text/javascript; charset=utf-8");
    }
    const asset = ASSET_PATH.exec(url.pathname);
    if (asset) {
      if (!read) return sendText(res, 405, "method not allowed");
      void proxyAsset(upstream, url.pathname, asset[1]!, res);
      return;
    }
    const match = /^\/api\/([^/]+)$/u.exec(url.pathname);
    if (match && API_NAME.test(match[1]!) && match[1] !== "socket") {
      void proxyApi(upstream, match[1]!, req, res);
      return;
    }
    sendText(res, 404, "not found");
  };
}

/**
 * Bridges a guest WebSocket upgrade to the plugin's token-protected socket
 * route by replaying the handshake on a fresh loopback connection.
 */
function handleUpgrade(upstream: Upstream) {
  return (req: http.IncomingMessage, socket: net.Socket, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    if (url.pathname !== "/api/socket" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const session = url.searchParams.get("session") ?? "";
    const query = new URLSearchParams({ session, token: upstream.token });
    const target = `${upstreamPath(upstream, "socket")}?${query.toString()}`;
    const lines = [
      `GET ${target} HTTP/1.1`,
      `Host: ${upstream.baseUrl.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `x-bb-plugin-token: ${upstream.token}`,
    ];
    for (const name of [
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-extensions",
      "sec-websocket-protocol",
    ]) {
      const value = req.headers[name];
      if (typeof value === "string" && !/[\r\n]/u.test(value)) lines.push(`${name}: ${value}`);
    }
    const port = Number(upstream.baseUrl.port || (upstream.baseUrl.protocol === "https:" ? 443 : 80));
    const remote = net.connect(port, upstream.baseUrl.hostname, () => {
      remote.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) remote.write(head);
      remote.pipe(socket);
      socket.pipe(remote);
    });
    const close = () => {
      remote.destroy();
      socket.destroy();
    };
    remote.on("error", close);
    socket.on("error", close);
    remote.on("close", close);
    socket.on("close", close);
  };
}

async function connectTunnel(current: Gateway, dataDir: string): Promise<void> {
  const client = createTunnelClient({
    store: OpenTunnelStorage.xdg({ env: { XDG_DATA_HOME: dataDir } }),
  });
  current.tunnelClient = client;
  while (!current.abort.signal.aborted) {
    setStatus({ tunnel: "connecting", error: null });
    try {
      const connection = await client.tunnel.connect({
        profile: TUNNEL_PROFILE,
        routes: { [TUNNEL_ROUTE]: `127.0.0.1:${current.port}` },
        signal: current.abort.signal,
      });
      current.tunnelClose = () => connection.close();
      if (current.abort.signal.aborted) {
        await connection.close();
        return;
      }
      setStatus({
        tunnel: "connected",
        publicUrl: `https://${TUNNEL_ROUTE}.${connection.tunnel.hostname}`,
        error: null,
      });
      for await (const event of connection.events) {
        const type = (event as { type?: string }).type;
        if (type === "connected") setStatus({ tunnel: "connected", error: null });
        else if (type === "reconnecting" || type === "disconnected") setStatus({ tunnel: "reconnecting" });
        else if (type === "stopped") break;
      }
      return;
    } catch (error) {
      if (current.abort.signal.aborted) return;
      setStatus({ tunnel: "error", error: errorText(error) });
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, TUNNEL_RETRY_MS);
        current.abort.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(undefined);
        }, { once: true });
      });
    }
  }
}

async function stopGateway(): Promise<void> {
  const current = gateway;
  gateway = null;
  if (!current) return;
  current.abort.abort();
  await current.tunnelClose?.().catch(() => undefined);
  await current.tunnelClient?.dispose().catch(() => undefined);
  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
    current.server.closeAllConnections();
  });
  await current.lease.dispose();
  setStatus({ running: false, exposure: null, localUrl: null, publicUrl: null, tunnel: "off", error: null });
}

type Context = ExperimentalHostRpcContext<typeof hostSignals>;

function bindEmitter(context: Context): void {
  emit = (next) => {
    void context.experimental_emitSignal("status", next).catch(() => undefined);
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async start(input, context) {
      bindEmitter(context);
      const key = JSON.stringify([input.upstreamBaseUrl, input.pluginId, input.pluginToken, input.exposure, input.port]);
      if (gateway?.key === key) return status;
      await stopGateway();

      const upstream: Upstream = {
        baseUrl: new URL(input.upstreamBaseUrl),
        pluginId: input.pluginId,
        token: input.pluginToken,
      };
      const server = http.createServer(handleRequest(upstream));
      server.on("upgrade", handleUpgrade(upstream));
      server.headersTimeout = 15_000;
      server.requestTimeout = 60_000;
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.port, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : input.port);
        });
      });
      const current: Gateway = {
        key,
        server,
        port,
        exposure: input.exposure,
        upstream,
        lease: context.experimental_retainWorker(),
        abort: new AbortController(),
        tunnelClient: null,
        tunnelClose: null,
      };
      gateway = current;
      context.lifecycle.signal.addEventListener("abort", () => void stopGateway(), { once: true });
      setStatus({
        running: true,
        exposure: input.exposure,
        localUrl: `http://127.0.0.1:${port}`,
        publicUrl: null,
        tunnel: input.exposure === "opentunnel" ? "connecting" : "off",
        error: null,
      });
      if (input.exposure === "opentunnel") {
        // The first connect issues a certificate and can take ~40s, longer than
        // one host call, so it runs in the background and reports by signal.
        void connectTunnel(current, context.experimental_paths.dataDir);
      }
      return status;
    },
    async stop(_input, context) {
      bindEmitter(context);
      await stopGateway();
      return status;
    },
    status() {
      return status;
    },
  },
  dispose: () => stopGateway(),
});
