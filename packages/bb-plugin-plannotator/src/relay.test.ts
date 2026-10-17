import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRequestFilter } from "./request-filter";
import {
  PLANNOTATOR_RELAY_ROUTE,
  createPlannotatorRelayHandler,
  injectRelayBootstrap,
  isSafeUpstreamPath,
  registerPlannotatorRelayRoutes,
} from "./relay";

const hosts: FakePluginHost[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function relaySessions(url: string) {
  const filter = await createRequestFilter({ cwd: process.cwd(), allowedRoots: [process.cwd()] });
  return new Map([["session-1", { url, filter }]]);
}

async function startUpstreamServer(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<html><head></head><body><img src=\"/favicon.png\"></body></html>",
      );
      return;
    }
    if (request.url === "/api/plan") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ body: Buffer.concat(chunks).toString("utf8") }),
        );
      });
      return;
    }
    if (request.url?.startsWith("/api/html-assets/")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox allow-scripts" });
      response.end("<html><head></head><body>author html</body></html>");
      return;
    }
    if (request.url === "/csp") {
      response.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self'" });
      response.end("<html><head></head><body>app</body></html>");
      return;
    }
    if (request.url?.startsWith("/api/image")) {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end("<svg><script>alert(1)</script></svg>");
      return;
    }
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: ready\n\n");
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No upstream port");
  return `http://127.0.0.1:${address.port}`;
}

describe("Plannotator same-origin relay", () => {
  it("validates only root-relative upstream paths", () => {
    expect(isSafeUpstreamPath("/")).toBe(true);
    expect(isSafeUpstreamPath("/api/plan?x=1")).toBe(true);
    expect(isSafeUpstreamPath("//evil.example/steal")).toBe(false);
    expect(isSafeUpstreamPath("https://evil.example/steal")).toBe(false);
    expect(isSafeUpstreamPath("/api/\\evil")).toBe(false);
  });

  it("injects the transport without replacing the upstream document", () => {
    const html = injectRelayBootstrap(
      "<html><head></head><body>upstream</body></html>",
      "/api/v1/plugins/plannotator/http/review",
      "session-1",
    );
    expect(html).toContain("<body>upstream</body>");
    expect(html).toContain("data-bb-plannotator-relay");
    expect(html).toContain("session-1");
    expect(html.indexOf("data-bb-plannotator-relay")).toBeLessThan(
      html.indexOf("</head>"),
    );
  });

  it("inserts before the module even when its bundle contains </head>", () => {
    const html = injectRelayBootstrap(
      '<html><head><script type="module">const template = "</head>";</script></head><body></body></html>',
      "/api/v1/plugins/plannotator/http/review",
      "session-1",
    );
    const relayIndex = html.indexOf("<script data-bb-plannotator-relay");
    const moduleIndex = html.indexOf('<script type="module">');
    expect(relayIndex).toBeGreaterThan(html.indexOf("<head>"));
    expect(relayIndex).toBeLessThan(moduleIndex);
    expect(html.indexOf('const template = "</head>";')).toBeGreaterThan(moduleIndex);
    expect(html.lastIndexOf("</head>")).toBeGreaterThan(relayIndex);
  });

  it("relays HTML, JSON mutations, and SSE on one exact BB route", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    const sessions = await relaySessions(upstreamBaseUrl);
    registerPlannotatorRelayRoutes(host.bb, sessions);

    const html = await host.harness.fetchHttp(
      "GET",
      `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2F`,
    );
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("data-bb-plannotator-relay");

    const mutation = await host.harness.fetchHttp(
      "POST",
      `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2Fapi%2Fplan`,
      {
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", authorization: "Bearer x", cookie: "a=1" },
        body: JSON.stringify({ approved: true }),
      },
    );
    expect(await mutation.json()).toEqual({
      body: JSON.stringify({ approved: true }),
    });

    const stream = await host.harness.fetchHttp(
      "GET",
      `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2Fstream`,
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(await stream.text()).toBe("data: ready\n\n");
  });

  it("sandboxes an SVG so its script cannot run on BB's origin", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(host.bb, await relaySessions(upstreamBaseUrl));

    const image = await host.harness.fetchHttp(
      "GET",
      `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=${encodeURIComponent("/api/image?path=package.json.svg")}`,
    );

    expect(image.status).toBe(200);
    expect(image.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps upstream's sandbox on author HTML, and drops other policies from the documents it injects into", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(host.bb, await relaySessions(upstreamBaseUrl));
    const get = (path: string) =>
      host.harness.fetchHttp("GET", `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=${encodeURIComponent(path)}`);

    const asset = await get("/api/html-assets/token/page.html");
    expect(asset.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await asset.text()).toContain("author html");
    expect((await get("/csp")).headers.get("content-security-policy")).toBeNull();
  });

  it("refuses an oversized decision body without buffering it, and streams other bodies", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const handler = createPlannotatorRelayHandler(await relaySessions(upstreamBaseUrl));
    const call = (path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => {
      const url = new URL(`https://bb.example${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=${encodeURIComponent(path)}`);
      const raw = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
        body,
        duplex: "half",
      } as RequestInit);
      const context = { req: { raw, query: (name: string) => url.searchParams.get(name) ?? undefined } };
      return Promise.race([
        handler(context as never) as Promise<Response>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the relay waited for the whole body")), 2_000)),
      ]);
    };
    /** A body that sends `size` bytes and never ends, like a slow or hostile client. */
    const endless = (size: number) =>
      new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new Uint8Array(size).fill(32)) });

    expect((await call("/api/approve", endless(16), { "content-length": String(2 * 1024 * 1024) })).status).toBe(413);
    expect((await call("/api/deny", endless(1024 * 1024 + 1))).status).toBe(413);

    const parts = ['{"plan":"', "x".repeat(2 * 1024 * 1024), '"}'];
    const streamed = await call(
      "/api/plan",
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
          controller.close();
        },
      }),
    );
    expect(((await streamed.json()) as { body: string }).body).toBe(parts.join(""));
  });

  it("rejects unknown sessions and unsafe paths before contacting upstream", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    const sessions = await relaySessions(upstreamBaseUrl);
    registerPlannotatorRelayRoutes(host.bb, sessions);

    const unknown = await host.harness.fetchHttp(
      "GET",
      `${PLANNOTATOR_RELAY_ROUTE}?sessionId=missing&path=%2F`,
    );
    expect(unknown.status).toBe(404);

    const unsafe = await host.harness.fetchHttp(
      "GET",
      `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2F%2Fevil.example`,
    );
    expect(unsafe.status).toBe(400);

    const handler = createPlannotatorRelayHandler(new Map());
    expect(handler).toBeTypeOf("function");
  });

  it("accepts writes only from the bb page, never from a sandboxed document or another site", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(host.bb, await relaySessions(upstreamBaseUrl), () => "https://bb.example.ts.net");
    const post = async (headers: Record<string, string>) =>
      (
        await host.harness.fetchHttp("POST", `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2Fapi%2Fplan`, {
          headers: { "content-type": "text/plain", ...headers },
          body: '{"approved":true}',
        })
      ).status;

    // An annotated HTML file runs in a sandboxed srcdoc frame: Origin null.
    expect(await post({ origin: "null" })).toBe(403);
    expect(await post({ origin: "https://evil.example" })).toBe(403);
    expect(await post({})).toBe(403);
    expect(await post({ "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await post({ origin: "https://bb.example.ts.net" })).toBe(200);
    expect(await post({ "sec-fetch-site": "same-origin" })).toBe(200);
    // A name rebound to BB claims its own Host; only the bb page's origin counts.
    expect(await post({ host: "rebound.example", origin: "https://rebound.example" })).toBe(403);
    const read = await host.harness.fetchHttp("GET", `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2F`, {
      headers: { origin: "null" },
    });
    expect(read.status).toBe(200);
  });

  it("falls back to the Host's origin for writes only when the bb origin is unknown", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    registerPlannotatorRelayRoutes(host.bb, await relaySessions(upstreamBaseUrl), () => undefined);
    const post = async (headers: Record<string, string>) =>
      (
        await host.harness.fetchHttp("POST", `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2Fapi%2Fplan`, {
          headers: { "content-type": "text/plain", ...headers },
          body: '{"approved":true}',
        })
      ).status;

    expect(await post({ host: "bb.local:8080", origin: "http://bb.local:8080" })).toBe(200);
    expect(await post({ host: "bb.local:8080", origin: "https://evil.example" })).toBe(403);
  });
});
