import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  createRequestFilter,
  isRelabelableCapabilities,
  relabelCapabilitiesBody,
  sessionBridgeLabel,
} from "./request-filter";
import { PLANNOTATOR_RELAY_ROUTE, registerPlannotatorRelayRoutes } from "./relay";
import { startReviewProxy } from "./review-proxy";

const DNS_NAME = "mac.tail1b968e.ts.net";
const BB_ORIGIN = "https://bb-server.tail1b968e.ts.net";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

const cleanups: Array<() => Promise<unknown>> = [];
const hosts: FakePluginHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function upstream() {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { seen, port: (server.address() as { port: number }).port };
}

describe("request filter", () => {
  it("asks for a loopback Host only on the two Ask AI endpoints, and buffers only decisions", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bb-plannotator-filter-"));
    cleanups.push(() => rm(worktree, { recursive: true, force: true }));
    const filter = await createRequestFilter({ cwd: worktree, allowedRoots: [worktree] });
    const decide = (method: string, path: string, extra: { upgrade?: boolean } = {}) =>
      filter({
        method,
        url: new URL(path, "http://x"),
        origin: "https://review.example",
        secFetchSite: undefined,
        upgrade: extra.upgrade ?? false,
        allowedOrigins: ["https://review.example"],
      });

    const loopback = async (method: string, path: string) => {
      const decision = await decide(method, path);
      return decision.allowed && decision.loopbackHost;
    };
    expect(await loopback("POST", "/api/ai/session")).toBe(true);
    expect(await loopback("POST", "/api/ai/query")).toBe(true);
    for (const [method, path] of [
      ["GET", "/api/ai/query"],
      ["POST", "/api/ai/abort"],
      ["GET", "/api/ai/capabilities"],
      ["POST", "/api/ai/permission"],
      ["POST", "/api/feedback"],
      ["GET", "/api/plan"],
    ] as const) {
      expect(await loopback(method, path), `${method} ${path}`).toBe(false);
    }
    expect(await decide("POST", "/api/ai/bridge/poll")).toMatchObject({ allowed: false, status: 403 });
    expect(await decide("GET", "/api/x", { upgrade: true })).toMatchObject({ allowed: false });
    expect(await decide("POST", "/api/approve")).toMatchObject({ allowed: true, decisionBody: true });
    expect(await decide("POST", "/api/feedback")).toMatchObject({ allowed: true, decisionBody: false });
  });

  it("gives the Mac proxy and the bb relay the same answers, and rewrites Host only for Ask AI", async () => {
    const { seen, port } = await upstream();
    const worktree = await mkdtemp(join(tmpdir(), "bb-plannotator-filter-"));
    cleanups.push(() => rm(worktree, { recursive: true, force: true }));
    const options = { cwd: worktree, allowedRoots: [worktree] };

    const proxy = await startReviewProxy(0, { ...options, publicHostname: DNS_NAME, upstreamPort: port });
    cleanups.push(() => proxy.close());
    const proxyHost = `${DNS_NAME}:${proxy.port}`;
    const viaProxy = (method: string, path: string, headers: Record<string, string>, body?: string) =>
      new Promise<{ status: number; headers: IncomingMessage["headers"] }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: proxy.port, method, path, headers: { host: proxyHost, ...headers } },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers }));
          },
        );
        req.on("error", reject);
        req.end(body);
      });

    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(
      host.bb,
      new Map([["s-1", { url: `http://127.0.0.1:${port}`, filter: await createRequestFilter(options) }]]),
      () => BB_ORIGIN,
    );
    const viaRelay = async (method: string, path: string, headers: Record<string, string>, body?: string) => {
      const response = await host.harness.behavior.fetchHttp(
        method,
        `${PLANNOTATOR_RELAY_ROUTE}?sessionId=s-1&path=${encodeURIComponent(path)}`,
        { headers, ...(body !== undefined ? { body } : {}) },
      );
      return { status: response.status, headers: Object.fromEntries(response.headers as unknown as Iterable<[string, string]>) };
    };

    // [method, path, origin: "own" | "evil" | "none", extra headers]
    const table: Array<[string, string, "own" | "evil" | "none", Record<string, string>?]> = [
      ["GET", "/api/plan", "none"],
      ["POST", "/api/ai/session", "own"],
      ["POST", "/api/ai/query", "own"],
      ["POST", "/api/ai/abort", "own"],
      ["GET", "/api/ai/capabilities", "none"],
      ["POST", "/api/ai/query", "evil"],
      ["POST", "/api/approve", "none"],
      ["POST", "/api/approve", "none", { "sec-fetch-site": "same-origin" }],
      ["POST", "/api/ai/bridge/poll", "own"],
      ["GET", "/api/host/status", "none"],
      ["GET", "/api/open-in/apps", "none"],
      ["GET", "/api/reference/files?dirPath=%7E%5C", "none"],
      ["GET", "/api/image?path=%2Fetc%2Fhosts.png", "none"],
      ["GET", "/api/archive/plans?customPath=%2Fetc", "none"],
      ["GET", "/api/x", "none", { upgrade: "websocket" }],
    ];
    for (const [method, path, origin, extra = {}] of table) {
      const body = method === "POST" ? JSON.stringify({ planSave: { customPath: "/etc" }, obsidian: {} }) : undefined;
      const json: Record<string, string> = body ? { "content-type": "application/json" } : {};
      const originHeader = (own: string): Record<string, string> =>
        origin === "own" ? { origin: own } : origin === "evil" ? { origin: "https://evil.example" } : {};
      const proxyOrigin = originHeader(`https://${proxyHost}`);
      const relayOrigin = originHeader(BB_ORIGIN);
      const proxied = await viaProxy(method, path, { ...json, ...proxyOrigin, ...extra }, body);
      const relayed = await viaRelay(method, path, { ...json, ...relayOrigin, ...extra }, body);
      expect(relayed.status, `relay ${method} ${path} ${origin}`).toBe(proxied.status);
      expect(relayed.headers["access-control-allow-origin"], path).toBeUndefined();
    }

    const proxiedRequests = seen.filter(({ headers }) => headers.host?.startsWith(DNS_NAME) || headers.host === `127.0.0.1:${port}`);
    const hostFor = (path: string) =>
      proxiedRequests
        .filter(({ url }) => url === path)
        .map(({ headers }) => headers.host);
    // Through the proxy the browser's Host passes, except on the two Ask AI calls.
    expect(hostFor("/api/plan")).toEqual([proxyHost, `127.0.0.1:${port}`]);
    expect(hostFor("/api/ai/session")).toEqual([`127.0.0.1:${port}`, `127.0.0.1:${port}`]);
    expect(hostFor("/api/ai/abort")[0]).toBe(proxyHost);
    // Both strip custom save paths and note-app fields from decisions.
    const approvals = seen.filter(({ url }) => url === "/api/approve");
    expect(approvals.map(({ body }) => JSON.parse(body))).toEqual([{ planSave: {} }, { planSave: {} }]);
  });

  it("answers the open-in app list as upstream does for a remote session, and still refuses opening files", async () => {
    const { seen, port } = await upstream();
    const worktree = await mkdtemp(join(tmpdir(), "bb-plannotator-filter-"));
    cleanups.push(() => rm(worktree, { recursive: true, force: true }));
    const options = { cwd: worktree, allowedRoots: [worktree] };
    const proxy = await startReviewProxy(0, { ...options, publicHostname: DNS_NAME, upstreamPort: port });
    cleanups.push(() => proxy.close());
    const proxyHost = `${DNS_NAME}:${proxy.port}`;
    const viaProxy = (method: string, path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; type: string | undefined; body: string }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: proxy.port, method, path, headers: { host: proxyHost, ...headers } },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(
      host.bb,
      new Map([["s-1", { url: `http://127.0.0.1:${port}`, filter: await createRequestFilter(options) }]]),
      () => BB_ORIGIN,
    );
    const viaRelay = async (method: string, path: string, headers: Record<string, string> = {}) => {
      const response = await host.harness.behavior.fetchHttp(
        method,
        `${PLANNOTATOR_RELAY_ROUTE}?sessionId=s-1&path=${encodeURIComponent(path)}`,
        { headers },
      );
      return { status: response.status, type: response.headers.get("content-type") ?? undefined, body: await response.text() };
    };

    for (const answer of [await viaProxy("GET", "/api/open-in/apps"), await viaRelay("GET", "/api/open-in/apps")]) {
      expect(answer.status).toBe(200);
      expect(answer.type).toBe("application/json");
      expect(JSON.parse(answer.body)).toEqual({ available: false, apps: [] });
    }
    expect((await viaProxy("POST", "/api/open-in", { origin: `https://${proxyHost}` })).status).toBe(403);
    expect((await viaRelay("POST", "/api/open-in", { origin: BB_ORIGIN })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("never forwards a browser's Authorization or cookies through the relay", async () => {
    const { seen, port } = await upstream();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(
      host.bb,
      new Map([
        ["s-1", { url: `http://127.0.0.1:${port}`, filter: await createRequestFilter({ cwd: tmpdir(), allowedRoots: [tmpdir()] }) }],
      ]),
      () => BB_ORIGIN,
    );

    await host.harness.behavior.fetchHttp("GET", `${PLANNOTATOR_RELAY_ROUTE}?sessionId=s-1&path=%2Fapi%2Fplan`, {
      headers: { authorization: "Bearer stolen", cookie: "bb=1" },
    });

    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers.origin).toBeUndefined();
  });
});

// Upstream 0.28.20's `/api/ai/capabilities` with the session bridge on (host opencode).
const CAPABILITIES = JSON.stringify({
  available: true,
  providers: [
    {
      id: "session-bridge",
      name: "session-bridge",
      capabilities: { fork: false, resume: false, streaming: true, tools: true },
      models: [],
      label: "Ask this session · OpenCode",
      sessionBridge: { host: "opencode", status: "idle", interruptible: true },
    },
  ],
  defaultProvider: "session-bridge",
});
const CODEX_LABEL = "Ask this session · Codex";

describe("session-bridge label", () => {
  const relabel = (body: string) => {
    const result = relabelCapabilitiesBody(Buffer.from(body), CODEX_LABEL);
    return result && Buffer.from(result).toString("utf8");
  };

  it("names the thread's bb provider, or none", () => {
    expect(sessionBridgeLabel("Codex")).toBe(CODEX_LABEL);
    expect(sessionBridgeLabel(" ")).toBe("Ask this session");
    expect(sessionBridgeLabel(undefined)).toBe("Ask this session");
  });

  it("changes only the session-bridge provider's label", () => {
    const expected = JSON.parse(CAPABILITIES) as { providers: Array<Record<string, unknown>> };
    expected.providers[0]!.label = CODEX_LABEL;
    expect(relabel(CAPABILITIES)).toBe(JSON.stringify(expected));
  });

  it("passes through bodies that are not JSON, not compact, or not the expected shape", () => {
    const bridge = (extra: Record<string, unknown>) => ({ name: "session-bridge", label: "Ask this session · OpenCode", ...extra });
    for (const body of [
      "not json",
      JSON.stringify(JSON.parse(CAPABILITIES), null, 2),
      JSON.stringify([bridge({})]),
      JSON.stringify({ providers: "session-bridge" }),
      JSON.stringify({ providers: [{ name: "claude-agent-sdk", label: "Claude" }] }),
      JSON.stringify({ providers: [bridge({ id: "a" }), bridge({ id: "b" })] }),
      JSON.stringify({ providers: [bridge({ label: 7 })] }),
      JSON.stringify({ providers: [bridge({ label: CODEX_LABEL })] }),
    ]) {
      expect(relabel(body), body).toBeNull();
    }
  });

  it("buffers only uncompressed 200 JSON", () => {
    expect(isRelabelableCapabilities(200, "application/json;charset=utf-8", undefined)).toBe(true);
    expect(isRelabelableCapabilities(200, "application/json", "identity")).toBe(true);
    expect(isRelabelableCapabilities(200, "application/json", "gzip")).toBe(false);
    expect(isRelabelableCapabilities(200, "text/plain", undefined)).toBe(false);
    expect(isRelabelableCapabilities(200, undefined, undefined)).toBe(false);
    expect(isRelabelableCapabilities(503, "application/json", undefined)).toBe(false);
  });

  it("is asked for only on GET /api/ai/capabilities of a session with a label", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "bb-plannotator-filter-"));
    cleanups.push(() => rm(worktree, { recursive: true, force: true }));
    const labelled = await createRequestFilter({ cwd: worktree, allowedRoots: [worktree], sessionBridgeLabel: CODEX_LABEL });
    const plain = await createRequestFilter({ cwd: worktree, allowedRoots: [worktree] });
    const decide = (filter: typeof plain, method: string, path: string) =>
      filter({
        method,
        url: new URL(path, "http://x"),
        origin: undefined,
        secFetchSite: "same-origin",
        upgrade: false,
        allowedOrigins: [],
      });

    expect(await decide(labelled, "GET", "/api/ai/capabilities?activate=x")).toMatchObject({
      allowed: true,
      sessionBridgeLabel: CODEX_LABEL,
    });
    expect(await decide(labelled, "HEAD", "/api/ai/capabilities")).not.toHaveProperty("sessionBridgeLabel");
    expect(await decide(labelled, "GET", "/api/ai/sessions")).not.toHaveProperty("sessionBridgeLabel");
    expect(await decide(plain, "GET", "/api/ai/capabilities")).not.toHaveProperty("sessionBridgeLabel");
  });

  it("is relabelled by the Mac proxy and the bb relay, and anything else passes through byte for byte", async () => {
    // [content-type, content-encoding, body] upstream answers with.
    let reply: [string, string | undefined, Buffer] = ["application/json", undefined, Buffer.from(CAPABILITIES)];
    const server: Server = createServer((_req, res) => {
      const [type, encoding, body] = reply;
      res.writeHead(200, { "content-type": type, ...(encoding ? { "content-encoding": encoding } : {}) });
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const port = (server.address() as { port: number }).port;
    const worktree = await mkdtemp(join(tmpdir(), "bb-plannotator-filter-"));
    cleanups.push(() => rm(worktree, { recursive: true, force: true }));
    const options = { cwd: worktree, allowedRoots: [worktree], sessionBridgeLabel: CODEX_LABEL };

    const proxy = await startReviewProxy(0, { ...options, publicHostname: DNS_NAME, upstreamPort: port });
    cleanups.push(() => proxy.close());
    const viaProxy = (path: string) =>
      new Promise<{ headers: IncomingMessage["headers"]; body: Buffer }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: proxy.port, method: "GET", path, headers: { host: `${DNS_NAME}:${proxy.port}` } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
          },
        );
        req.on("error", reject);
        req.end();
      });

    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(
      host.bb,
      new Map([["s-1", { url: `http://127.0.0.1:${port}`, filter: await createRequestFilter(options) }]]),
      () => BB_ORIGIN,
    );
    const viaRelay = async (path: string) => {
      const response = await host.harness.behavior.fetchHttp(
        "GET",
        `${PLANNOTATOR_RELAY_ROUTE}?sessionId=s-1&path=${encodeURIComponent(path)}`,
      );
      return Buffer.from(await response.arrayBuffer());
    };

    const proxied = await viaProxy("/api/ai/capabilities");
    const relabelled = relabel(CAPABILITIES)!;
    expect(proxied.body.toString("utf8")).toBe(relabelled);
    expect(proxied.headers["content-length"]).toBe(String(Buffer.byteLength(relabelled)));
    expect((await viaRelay("/api/ai/capabilities")).toString("utf8")).toBe(relabelled);
    // Only the capabilities endpoint.
    expect((await viaProxy("/api/ai/sessions")).body.toString("utf8")).toBe(CAPABILITIES);
    expect((await viaRelay("/api/ai/sessions")).toString("utf8")).toBe(CAPABILITIES);

    const untouched: Array<[string, string | undefined, Buffer]> = [
      // Compressed: the proxy forwards the encoded bytes as they came.
      ["application/json", "gzip", Buffer.from(CAPABILITIES)],
      ["text/plain", undefined, Buffer.from(CAPABILITIES)],
      ["application/json", undefined, Buffer.from("not json")],
      ["application/json", undefined, Buffer.from(JSON.stringify({ providers: [] }))],
    ];
    for (const [type, encoding, body] of untouched) {
      reply = [type, encoding, body];
      expect((await viaProxy("/api/ai/capabilities")).body.equals(body), `${type} ${encoding}`).toBe(true);
      if (!encoding) expect((await viaRelay("/api/ai/capabilities")).equals(body), type).toBe(true);
    }
  });

  it("streams a capabilities body past the limit through unchanged", async () => {
    const big = Buffer.from(
      JSON.stringify({ providers: [{ name: "session-bridge", label: "Ask this session · OpenCode", pad: "x".repeat(1024 * 1024) }] }),
    );
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(big);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const port = (server.address() as { port: number }).port;
    const worktree = await mkdtemp(join(tmpdir(), "bb-plannotator-filter-"));
    cleanups.push(() => rm(worktree, { recursive: true, force: true }));
    const proxy = await startReviewProxy(0, {
      cwd: worktree,
      allowedRoots: [worktree],
      sessionBridgeLabel: CODEX_LABEL,
      publicHostname: DNS_NAME,
      upstreamPort: port,
    });
    cleanups.push(() => proxy.close());
    const body = await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          method: "GET",
          path: "/api/ai/capabilities",
          headers: { host: `${DNS_NAME}:${proxy.port}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body.equals(big)).toBe(true);
  });
});
