import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { connect } from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  frameAncestorsPolicy,
  startReviewProxy,
  stripDecisionBody,
  type RunningReviewProxy,
} from "./review-proxy";

const DNS_NAME = "mac.tail1b968e.ts.net";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(extra: { frameAncestor?: string; upstreamCsp?: string } = {}) {
  const worktree = await mkdtemp(join(tmpdir(), "bb-plannotator-proxy-worktree-"));
  const uploads = await mkdtemp(join(tmpdir(), "bb-plannotator-proxy-uploads-"));
  cleanups.push(() => rm(worktree, { recursive: true, force: true }));
  cleanups.push(() => rm(uploads, { recursive: true, force: true }));
  const seen: Seen[] = [];
  let releaseStream!: () => void;
  const streamReleased = new Promise<void>((resolve) => {
    releaseStream = resolve;
  });
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === "/api/reference/files/stream?dirPath=x") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
        void streamReleased.then(() => res.end("data: second\n\n"));
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        ...(extra.upstreamCsp ? { "content-security-policy": extra.upstreamCsp } : {}),
      });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => upstream.close(resolve)));
  upstream.unref();
  const upstreamPort = (upstream.address() as { port: number }).port;
  const proxy: RunningReviewProxy = await startReviewProxy(0, {
    publicHostname: DNS_NAME,
    upstreamPort,
    cwd: worktree,
    allowedRoots: [worktree, uploads],
    ...(extra.frameAncestor ? { frameAncestor: extra.frameAncestor } : {}),
  });
  cleanups.push(() => proxy.close());
  const host = `${DNS_NAME}:${proxy.port}`;
  const origin = `https://${host}`;

  function send(
    method: string,
    path: string,
    options: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: proxy.port, method, path, headers: { host, ...options.headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  }

  return { worktree, uploads, seen, proxy, host, origin, send, releaseStream };
}

describe("review proxy", () => {
  it("forwards a same-host GET with Host and Origin unchanged and strips CORS grants", async () => {
    const { send, seen, host } = await setup();

    const response = await send("GET", "/api/plan", {
      headers: { authorization: "Bearer stolen", origin: "https://other.example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(seen[0]).toMatchObject({ method: "GET", url: "/api/plan" });
    expect(seen[0]!.headers.host).toBe(host);
    expect(seen[0]!.headers.origin).toBe("https://other.example");
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });

  it("answers 421 to any other Host, which blocks DNS rebinding", async () => {
    const { send, seen, proxy } = await setup();

    for (const host of [`127.0.0.1:${proxy.port}`, `localhost:${proxy.port}`, `evil.example:${proxy.port}`, DNS_NAME]) {
      expect((await send("GET", "/api/plan", { headers: { host } })).status).toBe(421);
    }
    expect(seen).toHaveLength(0);
  });

  it("requires the review's own Origin or Sec-Fetch-Site for writes", async () => {
    const { send, seen, origin } = await setup();
    const body = JSON.stringify({ feedback: "x" });

    expect((await send("POST", "/api/deny", { body, headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await send("POST", "/api/deny", { body, headers: { origin: "null" } })).status).toBe(403);
    expect((await send("POST", "/api/deny", { body })).status).toBe(403);
    expect((await send("POST", "/api/deny", { body, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect(seen).toHaveLength(0);

    expect((await send("POST", "/api/deny", { body, headers: { origin } })).status).toBe(200);
    expect((await send("POST", "/api/draft", { body, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect(seen.map(({ url }) => url)).toEqual(["/api/deny", "/api/draft"]);
  });

  it("denies host-only endpoints regardless of method or path tricks", async () => {
    const { send, seen, origin } = await setup();

    for (const path of [
      "/api/host/status",
      "/api/ai/bridge/poll",
      "/api/plan/vscode-diff",
      "/api/save-notes",
      "/api/obsidian/vaults",
      "/api/reference/obsidian/doc?vaultPath=/",
      "/api/hooks/status",
      "/api/open-in",
      "/api/agent-terminal/ws",
      "/api/pr-action",
      "/api/call-flow/install",
      "/api/editor-annotations",
      "/api/editor-annotation?id=1",
      "/api/archive/plans?customPath=/etc",
      "/api/x/../host/close",
      "/api/%2e%2e/api/host/status",
      "/API/HOST/status",
    ]) {
      expect((await send("GET", path)).status, path).toBe(403);
      expect((await send("POST", path, { headers: { origin } })).status, path).toBe(403);
    }
    expect(seen).toHaveLength(0);
    expect((await send("GET", "/api/archive/plans")).status).toBe(200);
    // Review and annotate endpoints the browser UI needs still pass.
    for (const path of [
      "/api/diff",
      "/api/file-content?path=a.ts",
      "/api/agents/jobs",
      "/api/call-flow/install-status",
      "/api/external-annotations",
      "/api/html-assets/abc/x.png",
    ]) {
      expect((await send("GET", path)).status, path).toBe(200);
    }
    for (const path of ["/api/feedback", "/api/exit", "/api/git-add", "/api/agents/jobs", "/api/source/save"]) {
      expect((await send("POST", path, { headers: { origin }, body: "{}" })).status, path).toBe(200);
    }
  });

  it("allows images and file-browser directories only under the worktree or upload dir", async () => {
    const { send, seen, worktree, uploads } = await setup();
    await mkdir(join(worktree, "docs"));
    await writeFile(join(worktree, "docs", "a.png"), "");
    await symlink("/etc", join(worktree, "etc-link"));
    const ok = async (path: string) => (await send("GET", path)).status;
    const q = encodeURIComponent;

    expect(await ok(`/api/image?path=${q("docs/a.png")}`)).toBe(200);
    expect(await ok(`/api/image?path=${q(join(uploads, "u.png"))}`)).toBe(200);
    expect(await ok(`/api/image?path=${q("/etc/hosts.png")}`)).toBe(403);
    expect(await ok(`/api/image?path=${q("../../x.png")}`)).toBe(403);
    expect(await ok(`/api/image?path=${q("etc-link/hosts")}`)).toBe(403);
    const outside = await mkdtemp(join(tmpdir(), "bb-plannotator-proxy-outside-"));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "x.png"), "");
    expect(await ok(`/api/image?path=x.png&base=${q(outside)}`)).toBe(403);
    expect(await ok(`/api/reference/files?dirPath=${q(worktree)}`)).toBe(200);
    expect(await ok(`/api/reference/files?dirPath=${q("docs")}`)).toBe(200);
    expect(await ok(`/api/reference/files?dirPath=${q("~")}`)).toBe(403);
    // Upstream expands `~\` on every platform.
    expect(await ok("/api/reference/files?dirPath=~%5C")).toBe(403);
    expect(await ok("/api/reference/files?dirPath=~%5CDocuments")).toBe(403);
    expect(await ok("/api/reference/files/stream?dirPath=~%5C")).toBe(403);
    expect(await ok("/api/reference/files/stream?dirPath=~%5CDocuments")).toBe(403);
    expect(await ok(`/api/reference/files/stream?filePath=${q(join(homedir(), ".ssh", "id_ed25519"))}`)).toBe(403);
    expect(await ok("/api/reference/files/stream?filePath=~%5C.ssh%2Fid_ed25519")).toBe(403);
    expect(await ok(`/api/reference/files/stream?filePath=${q("docs/a.png")}`)).toBe(200);
    expect(await ok(`/api/reference/files?dirPath=${q(`"/etc"`)}`)).toBe(403);
    expect(await ok(`/api/reference/files/stream?dirPath=${q(worktree)}&dirPath=${q("/")}`)).toBe(403);
    expect(seen).toHaveLength(5);
    // Relative image paths reach upstream as absolute worktree paths.
    expect(seen.find(({ url }) => url.startsWith("/api/image?") && url.includes("a.png"))?.url).toBe(
      `/api/image?path=${q(join(worktree, "docs", "a.png"))}`,
    );
  });

  it("forwards a document-relative image as the one file upstream would serve", async () => {
    const { send, seen, worktree } = await setup();
    await mkdir(join(worktree, "docs"));
    await mkdir(join(worktree, "img"));
    await writeFile(join(worktree, "img", "b.png"), "");
    const q = encodeURIComponent;

    const response = await send(
      "GET",
      `/api/image?path=${q("../img/b.png")}&base=${q(join(worktree, "docs"))}`,
    );

    expect(response.status).toBe(200);
    expect(new URL(seen[0]!.url, "http://x").searchParams.get("path")).toBe(join(worktree, "img", "b.png"));
    expect(new URL(seen[0]!.url, "http://x").searchParams.has("base")).toBe(false);
  });

  it("lets only the bb page and the review itself frame it", async () => {
    const { send } = await setup({
      frameAncestor: "https://bb-server.tail1b968e.ts.net/some/path",
      upstreamCsp: "default-src 'self'",
    });

    const response = await send("GET", "/api/plan");

    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'self', frame-ancestors 'self' https://bb-server.tail1b968e.ts.net",
    );
  });

  it("adds no frame policy without a bb origin", async () => {
    const { send } = await setup();
    expect((await send("GET", "/api/plan")).headers["content-security-policy"]).toBeUndefined();
    expect(frameAncestorsPolicy("javascript:alert(1)")).toBeNull();
    expect(frameAncestorsPolicy("https://a.example; script-src *")).toBeNull();
  });

  it("refuses decision bodies over 1 MiB", async () => {
    const { send, seen, origin } = await setup();
    const body = JSON.stringify({ feedback: "x".repeat(1024 * 1024) });

    const response = await send("POST", "/api/deny", { headers: { origin }, body }).catch(() => ({ status: 413 }));

    expect(response.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("strips file-writing and app-opening fields from decision bodies", async () => {
    const { send, seen, origin } = await setup();

    const response = await send("POST", "/api/approve", {
      headers: { origin, "content-type": "text/plain" },
      body: JSON.stringify({
        feedback: "ok",
        planSave: { enabled: true, customPath: "/etc" },
        obsidian: { vaultPath: "/" },
        bear: { plan: "x" },
        octarine: { plan: "x", workspace: "w" },
      }),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(seen[0]!.body)).toEqual({ feedback: "ok", planSave: { enabled: true } });
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect((await send("POST", "/api/deny", { headers: { origin }, body: "[1]" })).status).toBe(400);
    expect(stripDecisionBody({ planSave: "x" })).toEqual({ planSave: "x" });
  });

  it("streams server-sent events without buffering", async () => {
    const { proxy, host, releaseStream } = await setup();

    const firstChunk = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: proxy.port, path: "/api/reference/files/stream?dirPath=x", headers: { host } },
        (res) => {
          res.setEncoding("utf8");
          res.once("data", (chunk: string) => {
            resolve(chunk);
            res.destroy();
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    // The upstream has not finished the response yet.
    expect(firstChunk).toBe("data: first\n\n");
    releaseStream();
  });

  it("rejects WebSocket upgrades", async () => {
    const { proxy, host, seen } = await setup();

    const response = await new Promise<string>((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write(
          `GET /api/agent-terminal HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
        );
      });
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("close", () => resolve(text));
    });

    expect(response.startsWith("HTTP/1.1 403")).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("survives a client that resets during a refused upgrade", async () => {
    const { proxy, host, send } = await setup();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => {
        const socket = connect(proxy.port, "127.0.0.1", () => {
          socket.write(`GET /x HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
          socket.resetAndDestroy();
          resolve();
        });
        socket.on("error", () => resolve());
      });
    }

    expect((await send("GET", "/api/plan")).status).toBe(200);
  });
});
