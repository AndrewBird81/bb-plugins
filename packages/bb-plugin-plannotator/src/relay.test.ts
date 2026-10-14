import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
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
    const sessions = new Map([["session-1", upstreamBaseUrl]]);
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

  it("rejects unknown sessions and unsafe paths before contacting upstream", async () => {
    const upstreamBaseUrl = await startUpstreamServer();
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    const sessions = new Map([["session-1", upstreamBaseUrl]]);
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
    registerPlannotatorRelayRoutes(host.bb, new Map([["session-1", upstreamBaseUrl]]), () => "https://bb.example.ts.net");
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
    const read = await host.harness.fetchHttp("GET", `${PLANNOTATOR_RELAY_ROUTE}?sessionId=session-1&path=%2F`, {
      headers: { origin: "null" },
    });
    expect(read.status).toBe(200);
  });
});
