import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import {
  PLANNOTATOR_REALTIME_CHANNEL,
  PLANNOTATOR_RELAY_PATH,
} from "./constants";
import type { HostReviewState } from "./host-contract";
import plugin, {
  reviewTargetFor,
  shouldUseRemotePlannotatorMode,
  upstreamOriginForProvider,
} from "../server";

const hosts: FakePluginHost[] = [];
const temporaryDirectories: string[] = [];

beforeEach(() => {
  // The upstream release lookup that pre-dismisses the update toast.
  vi.stubGlobal("fetch", async () => Response.json({ tag_name: "v0.29.0" }));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(hosts.splice(0).map((host) => host.harness.lifecycle.dispose()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function fakePlannotatorBinary(
  options: { approveAfterMs?: number | null } = {},
): Promise<string> {
  const approveAfterMs = options.approveAfterMs === undefined ? 150 : options.approveAfterMs;
  const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-fake-"));
  temporaryDirectories.push(directory);
  const binary = join(directory, "plannotator");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const ready = process.env.PLANNOTATOR_READY_FILE;
fs.mkdirSync(path.dirname(ready), { recursive: true });
fs.appendFileSync(ready, JSON.stringify({ url: "http://127.0.0.1:43210", isRemote: false, port: 43210 }) + "\\n");
if (process.env.FAKE_PLANNOTATOR_CWD_FILE) fs.writeFileSync(process.env.FAKE_PLANNOTATOR_CWD_FILE, process.cwd());
${approveAfterMs === null
  ? "setInterval(() => undefined, 1000);"
  : `setTimeout(() => process.stdout.write(JSON.stringify({ approved: true }) + "\\n"), ${approveAfterMs});`}
process.stdin.resume();
`,
    "utf8",
  );
  await chmod(binary, 0o755);
  return binary;
}

async function reviewPanelTab(host: FakePluginHost) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const update = [...host.harness.sdk.calls]
      .reverse()
      .find((call) => call.path === "threads.tabs.update") as
      | { args: [input: { tabs: Array<Record<string, unknown>> }] }
      | undefined;
    const panel = update?.args[0].tabs.find(
      (tab) => tab.kind === "plugin-panel" && tab.actionId === "plannotator-review",
    );
    if (panel) return panel;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected a persisted Plannotator review tab");
}

function wireInteractionSdk(
  host: FakePluginHost,
  options: { conflictOnce?: boolean } = {},
): void {
  let revision = 1;
  let tabs: Array<Record<string, unknown>> = [];
  let conflictPending = options.conflictOnce === true;

  host.harness.sdk.stub("threads.tabs.get", () => {
    return { revision, tabs };
  });
  host.harness.sdk.stub("threads.tabs.update", (args) => {
    const input = args as unknown as {
      expectedRevision: number;
      tabs: Array<Record<string, unknown>>;
    };
    if (input.expectedRevision !== revision) {
      throw new Error("tabs revision conflict");
    }
    if (conflictPending) {
      conflictPending = false;
      revision += 1;
      throw new Error("tabs revision conflict");
    }
    tabs = input.tabs;
    revision += 1;
    return { revision, tabs };
  });
  host.harness.sdk.stub("threads.send", () => ({ ok: true, delivery: "queued" }));
}

async function sentReview(host: FakePluginHost) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const sent = host.harness.sdk.callsTo("threads.send")[0];
    if (sent) return sent;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected a Plannotator decision message");
}

function wireThreadOnHost(
  host: FakePluginHost,
  environment: { hostId: string; path: string },
): void {
  wireInteractionSdk(host);
  host.harness.sdk.stub("threads.get", () =>
    makeThreadResponse({ id: "thread-1", providerId: "claude-code", environmentId: "env-1" }),
  );
  host.harness.sdk.stub("environments.get", () => ({ id: "env-1", ...environment }) as never);
  host.harness.sdk.stub("system.config", () =>
    ({ primaryHostId: "host_server", dataDir: "/tmp/bb-plannotator-test-data", serverUrl: "http://127.0.0.1:38886" }) as never,
  );
}

/** A host entry stand-in whose review state the test controls. */
function fakeRemoteHost(options: { startError?: string } = {}) {
  const remote = {
    state: { status: "pending" } as HostReviewState,
    async call({ method }: { method: string }) {
      if (method === "startReview") {
        if (options.startError) throw new Error(options.startError);
        return { url: "https://mac.tail1b968e.ts.net:19500", port: 19500 };
      }
      if (method === "getReview") return remote.state;
      if (method === "stopReview") return { stopped: true };
      if (method === "reconcile") return { removedPorts: [], killedPids: [] };
      throw new Error(`unexpected host method ${method}`);
    },
  };
  return remote;
}

describe("BB upstream Plannotator bridge", () => {
  it("enables remote Plannotator mode only for remotely reachable BB configurations", () => {
    expect(shouldUseRemotePlannotatorMode("http://127.0.0.1:38886")).toBe(false);
    expect(shouldUseRemotePlannotatorMode("https://machine.example.ts.net")).toBe(true);
    expect(
      shouldUseRemotePlannotatorMode(undefined, { BB_SERVER_BIND_HOST: "0.0.0.0" }),
    ).toBe(true);
    expect(
      shouldUseRemotePlannotatorMode("http://127.0.0.1:38886", {
        BB_APP_URL: "https://machine.example.ts.net",
        BB_SERVER_BIND_HOST: "127.0.0.1",
      }),
    ).toBe(true);
  });

  it("maps BB provider ids to upstream display identities", () => {
    expect(upstreamOriginForProvider("codex")).toBe("codex");
    expect(upstreamOriginForProvider("opencode")).toBe("opencode");
    expect(upstreamOriginForProvider("acp-claude-code")).toBe("claude-code");
    expect(upstreamOriginForProvider("omp")).toBe("pi");
    expect(upstreamOriginForProvider("unknown-provider")).toBe("codex");
  });

  it("registers the optional control plane without selecting a skill", async () => {
    const binary = await fakePlannotatorBinary();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
      agentSkillIds: ["plan-review"],
    });
    hosts.push(host);
    await plugin(host.bb);

    expect(host.harness.inspection.registrations.rpcMethods).toEqual([
      "status",
      "getActiveReview",
      "cancelReview",
    ]);
    expect(
      host.harness.inspection.registrations.httpRoutes.map((route) => route.method),
    ).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
    expect(host.harness.inspection.registrations.agentTools.map((tool) => tool.name)).toEqual([
      "plannotator_review_plan",
      "plannotator_review_status",
    ]);
    expect(host.harness.inspection.registrations.agentTools[0]?.instructions).toContain(
      "Native Plan mode remains separate",
    );
    expect(host.harness.inspection.registrations.agentTools[0]?.instructions).toContain(
      "The tool returns a pending review ID promptly",
    );
    expect(host.harness.inspection.registrations.cli).toBeNull();

    const resolved = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext(),
    );
    expect(resolved.skills).toEqual([]);
  });

  it("returns a review ID promptly and sends approval in a new thread message", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: 500 });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host, { conflictOnce: true });

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { title: "Upstream UI", planMarkdown: "# Plan\n\n- Use the real app" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const panel = await reviewPanelTab(host);
    expect(panel).toMatchObject({
      kind: "plugin-panel",
      actionId: "plannotator-review",
    });
    expect(JSON.parse(String(panel.paramsJson))).toMatchObject({
      sessionUrl: "http://127.0.0.1:43210",
      threadId: "thread-1",
      relayPath: PLANNOTATOR_RELAY_PATH,
    });
    expect(host.harness.inspection.pendingInteractions).toHaveLength(0);
    expect(
      await host.harness.callRpc("getActiveReview", { threadId: "thread-1" }),
    ).toMatchObject({
      threadId: "thread-1",
      title: "Upstream UI",
      relayPath: PLANNOTATOR_RELAY_PATH,
    });
    expect(host.harness.realtimeSignals).toContainEqual({
      channel: PLANNOTATOR_REALTIME_CHANNEL,
      payload: {
        kind: "review-opened",
        payload: expect.objectContaining({
          sessionId: expect.any(String),
          threadId: "thread-1",
          relayPath: PLANNOTATOR_RELAY_PATH,
        }),
      },
    });

    const result = JSON.parse(String(await toolCall)) as { status: string; reviewId: string };
    expect(result).toMatchObject({ status: "pending", reviewId: expect.any(String) });
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(await host.harness.behavior.callAgentTool(
      "plannotator_review_status",
      { reviewId: result.reviewId },
      { threadId: "thread-1", projectId: "project-1" },
    )).toContain('"status":"pending"');
    const sent = await sentReview(host);
    expect(sent[0]).toMatchObject({
      threadId: "thread-1",
      mode: "queue-if-active",
      input: [{ type: "text", text: expect.stringContaining('"decision":"approved"') }],
    });
    expect(String((sent[0] as { input: Array<{ text: string }> }).input[0]!.text)).toContain(result.reviewId);
    expect(await host.harness.behavior.callAgentTool(
      "plannotator_review_status",
      { reviewId: result.reviewId },
      { threadId: "thread-1", projectId: "project-1" },
    )).toContain('"decision":"approved"');
    expect(host.harness.inspection.pendingInteractions).toHaveLength(0);
    expect(host.harness.sdk.callsTo("threads.interactions.respond")).toHaveLength(0);
    const finalTabUpdateCall = [...host.harness.sdk.calls]
      .reverse()
      .find((call) => call.path === "threads.tabs.update");
    expect(finalTabUpdateCall?.args[0]).toMatchObject({
      threadId: "thread-1",
      tabs: [],
    });
  });

  it("cancels the upstream process through the thread-owned panel RPC", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: null });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- Cancel me" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const panel = await reviewPanelTab(host);
    const payload = JSON.parse(String(panel.paramsJson)) as { sessionId: string };
    await expect(
      host.harness.callRpc("cancelReview", {
        threadId: "thread-1",
        sessionId: payload.sessionId,
      }),
    ).resolves.toEqual({ cancelled: true });

    const result = JSON.parse(String(await toolCall)) as { status: string };
    expect(result.status).toBe("pending");
    expect((await sentReview(host))[0]).toMatchObject({
      input: [{ text: expect.stringContaining('"decision":"cancelled"') }],
    });
    expect(host.harness.inspection.pendingInteractions).toHaveLength(0);
    const finalTabUpdateCall = [...host.harness.sdk.calls]
      .reverse()
      .find((call) => call.path === "threads.tabs.update");
    expect(finalTabUpdateCall?.args?.[0]).toMatchObject({
      tabs: [],
    });
  });

  it("refuses a second review with a distinct status instead of cancelled", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: null });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);

    const first = JSON.parse(String(await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- First" },
      { threadId: "thread-1", projectId: "project-1" },
    ))) as { status: string; reviewId: string };
    expect(first.status).toBe("pending");

    const refusal = (await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- Second" },
      { threadId: "thread-1", projectId: "project-1" },
    )) as { isError: boolean; content: Array<{ text: string }> };
    expect(refusal.isError).toBe(true);
    const second = JSON.parse(refusal.content[0]!.text) as Record<string, unknown>;
    expect(second).toMatchObject({
      status: "already_active",
      source: "plannotator",
      reviewId: first.reviewId,
    });
    expect(second).not.toHaveProperty("decision");

    // The pending review is still recoverable and cancellable from the panel.
    const active = (await host.harness.callRpc("getActiveReview", {
      threadId: "thread-1",
    })) as { sessionId: string };
    expect(active.sessionId).toBe(first.reviewId);
    await expect(
      host.harness.callRpc("cancelReview", {
        threadId: "thread-1",
        sessionId: active.sessionId,
      }),
    ).resolves.toEqual({ cancelled: true });
    await sentReview(host);
    await expect.poll(() => host.harness.realtimeSignals).toContainEqual({
      channel: PLANNOTATOR_REALTIME_CHANNEL,
      payload: {
        kind: "review-closed",
        threadId: "thread-1",
        sessionId: first.reviewId,
      },
    });
  });

  it("frees the thread for a new review while a decision is still being delivered", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: null });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);
    let releaseSend!: () => void;
    const sendBlocked = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    host.harness.sdk.stub("threads.send", async () => {
      await sendBlocked;
      return { ok: true, delivery: "queued" };
    });

    const first = JSON.parse(String(await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- First" },
      { threadId: "thread-1", projectId: "project-1" },
    ))) as { reviewId: string };
    await host.harness.callRpc("cancelReview", {
      threadId: "thread-1",
      sessionId: first.reviewId,
    });
    // The decision send is now in flight and has not returned.
    await sentReview(host);

    const second = JSON.parse(String(await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- Second" },
      { threadId: "thread-1", projectId: "project-1" },
    ))) as { status: string; reviewId: string };
    expect(second.status).toBe("pending");
    expect(second.reviewId).not.toBe(first.reviewId);

    releaseSend();
    const active = (await host.harness.callRpc("getActiveReview", {
      threadId: "thread-1",
    })) as { sessionId: string };
    expect(active.sessionId).toBe(second.reviewId);
    await host.harness.callRpc("cancelReview", {
      threadId: "thread-1",
      sessionId: second.reviewId,
    });
  });

  it("rejects cancellation from another thread or session", async () => {
    const binary = await fakePlannotatorBinary();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);

    await expect(
      host.harness.callRpc("cancelReview", {
        threadId: "thread-1",
        sessionId: "not-active",
      }),
    ).resolves.toEqual({ cancelled: false });
  });

  it("removes deleted reviews before asynchronous cleanup", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: null });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);

    const toolCall = host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- Delete me" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    const panel = await reviewPanelTab(host);
    const payload = JSON.parse(String(panel.paramsJson)) as {
      sessionId: string;
    };
    await expect(
      host.harness.callRpc("getActiveReview", { threadId: "thread-1" }),
    ).resolves.toMatchObject({ sessionId: payload.sessionId });

    await host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thread-1" }),
    });
    await expect(
      host.harness.callRpc("getActiveReview", { threadId: "thread-1" }),
    ).resolves.toBeNull();

    await toolCall;
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("recovers an interrupted review and retries a failed decision send", async () => {
    const host = createFakePluginHost({ pluginId: "plannotator" });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);
    const reviewId = "bb883ad4-4ff7-4183-96eb-6250ae380c3a";
    const key = `review:${reviewId}`;
    await host.bb.storage.kv.set(key, {
      id: reviewId,
      threadId: "thread-1",
      status: "pending",
      updatedAt: Date.now(),
    });
    let failSend = true;
    host.harness.sdk.stub("threads.send", () => {
      if (failSend) throw new Error("temporary send failure");
      return { ok: true, delivery: "queued" };
    });

    const first = host.harness.behavior.runService("review-delivery");
    await sentReview(host);
    first.controller.abort();
    await first.done;
    expect(await host.bb.storage.kv.get<{ status: string }>(key)).toMatchObject({
      status: "ready",
      result: { decision: "cancelled", error: expect.stringContaining("restarted") },
    });

    failSend = false;
    const second = host.harness.behavior.runService("review-delivery");
    for (let attempt = 0; attempt < 100 && host.harness.sdk.callsTo("threads.send").length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(host.harness.sdk.callsTo("threads.send")).toHaveLength(2);
    second.controller.abort();
    await second.done;
    expect(await host.bb.storage.kv.get<{ status: string }>(key)).toMatchObject({
      status: "delivered",
    });
  });

  it("returns an actionable error when the official binary is missing", async () => {
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: "/definitely/missing/plannotator" },
    });
    hosts.push(host);
    await plugin(host.bb);

    const result = await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan" },
      { threadId: "thread-1", projectId: "project-1" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("bundled");
  });
  it("routes a review to the server or to the thread's own host", () => {
    const exists = (path: string) => path === "/home/node/worktree";
    expect(reviewTargetFor({ hostId: "host_server", path: "/home/node/worktree" }, "host_server", exists))
      .toEqual({ kind: "server", cwd: "/home/node/worktree" });
    expect(reviewTargetFor({ hostId: "host_server", path: "/gone" }, "host_server", exists))
      .toEqual({ kind: "server" });
    expect(reviewTargetFor({ hostId: "host_mac", path: "/Users/me/repo" }, "host_server", exists))
      .toEqual({ kind: "host", hostId: "host_mac", cwd: "/Users/me/repo" });
    expect(() => reviewTargetFor({ hostId: "host_mac", path: null }, "host_server", exists))
      .toThrow("no workspace path");
  });

  it("starts an in-process review in the thread's worktree on the server machine", async () => {
    const binary = await fakePlannotatorBinary({ approveAfterMs: null });
    const worktree = await realpath(await mkdtemp(join(tmpdir(), "bb-plannotator-worktree-")));
    temporaryDirectories.push(worktree);
    const cwdFile = join(worktree, "cwd.txt");
    vi.stubEnv("FAKE_PLANNOTATOR_CWD_FILE", cwdFile);
    const host = createFakePluginHost({
      pluginId: "plannotator",
      settings: { binaryPath: binary },
    });
    hosts.push(host);
    await plugin(host.bb);
    wireThreadOnHost(host, { hostId: "host_server", path: worktree });

    const result = JSON.parse(String(await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan" },
      { threadId: "thread-1", projectId: "project-1" },
    ))) as { status: string };

    expect(result.status).toBe("pending");
    expect(await readFile(cwdFile, "utf8")).toBe(worktree);
    expect(host.harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("runs a review on the thread's own host and delivers its signalled decision", async () => {
    const remote = fakeRemoteHost();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      experimental_callHostRpc: remote.call,
    });
    hosts.push(host);
    await plugin(host.bb);
    wireThreadOnHost(host, { hostId: "host_mac", path: "/Users/me/repo" });

    const result = JSON.parse(String(await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan\n\n- On the Mac" },
      { threadId: "thread-1", projectId: "project-1" },
    ))) as { status: string; reviewId: string };
    expect(result.status).toBe("pending");
    expect(host.harness.inspection.experimental_hostRpcCalls[0]).toMatchObject({
      method: "startReview",
      hostId: "host_mac",
      input: {
        sessionId: result.reviewId,
        cwd: "/Users/me/repo",
        origin: "claude-code",
        planMarkdown: "# Plan\n\n- On the Mac",
      },
    });
    const panel = JSON.parse(String((await reviewPanelTab(host)).paramsJson)) as Record<string, unknown>;
    expect(panel).toMatchObject({
      sessionId: result.reviewId,
      sessionUrl: "https://mac.tail1b968e.ts.net:19500",
      dismissUpdateVersion: "0.29.0",
    });
    expect(await host.bb.storage.kv.get(`review:${result.reviewId}`)).toMatchObject({
      hostId: "host_mac",
      status: "pending",
    });
    // A host review is published by its own machine, never through BB's relay.
    const relay = await host.harness.behavior.fetchHttp(
      "GET",
      `/review?sessionId=${result.reviewId}&path=/`,
    );
    expect(relay.status).toBe(404);

    remote.state = { status: "decided", decision: { approved: false, feedback: "Split step 2" } };
    await host.harness.behavior.experimental_emitHostSignal("host_mac", "reviewChanged", {
      sessionId: result.reviewId,
    });
    const sent = await sentReview(host);
    expect(String((sent[0] as { input: Array<{ text: string }> }).input[0]!.text)).toContain(
      '"decision":"changes_requested"',
    );
    await vi.waitFor(() =>
      expect(host.harness.inspection.experimental_hostRpcCalls.map(({ method }) => method)).toContain(
        "stopReview",
      ),
    );
  });

  it("cancels a host review when the host worker exits", async () => {
    const remote = fakeRemoteHost();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      experimental_callHostRpc: remote.call,
    });
    hosts.push(host);
    await plugin(host.bb);
    wireThreadOnHost(host, { hostId: "host_mac", path: "/Users/me/repo" });
    await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan" },
      { threadId: "thread-1", projectId: "project-1" },
    );

    await host.harness.behavior.experimental_emitHostWorkerExit("host_mac");

    const sent = await sentReview(host);
    const text = String((sent[0] as { input: Array<{ text: string }> }).input[0]!.text);
    expect(text).toContain('"decision":"cancelled"');
    expect(text).toContain("worker on the thread's machine exited");
    expect(host.harness.inspection.experimental_hostRpcCalls.map(({ method }) => method)).toContain(
      "reconcile",
    );
  });

  it("returns the host's error when it cannot publish the review", async () => {
    const remote = fakeRemoteHost({
      startError: "The tailscale CLI is not on this machine's PATH or at /usr/local/bin/tailscale.",
    });
    const host = createFakePluginHost({
      pluginId: "plannotator",
      experimental_callHostRpc: remote.call,
    });
    hosts.push(host);
    await plugin(host.bb);
    wireThreadOnHost(host, { hostId: "host_mac", path: "/Users/me/repo" });

    const result = await host.harness.behavior.callAgentTool(
      "plannotator_review_plan",
      { planMarkdown: "# Plan" },
      { threadId: "thread-1", projectId: "project-1" },
    );

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("tailscale CLI is not on this machine");
    expect(await host.harness.callRpc("getActiveReview", { threadId: "thread-1" })).toBeNull();
  });

  it("stops a host review left pending by a plugin restart", async () => {
    const remote = fakeRemoteHost();
    const host = createFakePluginHost({
      pluginId: "plannotator",
      experimental_callHostRpc: remote.call,
    });
    hosts.push(host);
    await plugin(host.bb);
    wireInteractionSdk(host);
    const reviewId = "bb883ad4-4ff7-4183-96eb-6250ae380c3a";
    await host.bb.storage.kv.set(`review:${reviewId}`, {
      id: reviewId,
      threadId: "thread-1",
      hostId: "host_mac",
      status: "pending",
      updatedAt: Date.now(),
    });

    const service = host.harness.behavior.runService("review-delivery");
    await sentReview(host);
    service.controller.abort();
    await service.done;

    expect(host.harness.inspection.experimental_hostRpcCalls).toContainEqual(
      expect.objectContaining({ method: "stopReview", hostId: "host_mac", input: { sessionId: reviewId } }),
    );
  });
});
