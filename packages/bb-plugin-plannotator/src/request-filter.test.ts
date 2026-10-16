import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRequestFilter } from "./request-filter";
import { PLANNOTATOR_RELAY_ROUTE, registerPlannotatorRelayRoutes } from "./relay";
import { startReviewProxy } from "./review-proxy";

const DNS_NAME = "mac.tailnet-example.ts.net";
const BB_ORIGIN = "https://bb-server.tailnet-example.ts.net";

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
