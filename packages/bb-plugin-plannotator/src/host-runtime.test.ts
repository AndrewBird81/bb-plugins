import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { BridgeOptions, RunningUpstreamReview, UpstreamDecision } from "./bridge";
import {
  UNPOLLED_REVIEW_TIMEOUT_MS,
  createPlannotatorHostEntry,
  type CommandResult,
} from "./host-runtime";

const TAILSCALE = "/fake/bin/tailscale";
const DNS_NAME = "mac.tail1b968e.ts.net";
const SESSION_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

type ServeMapping = { proxy: string };

/** Fakes for the process and `tailscale` seams. */
function fakeHost(options: {
  serve?: Record<number, ServeMapping>;
  tailscale?: string | null;
  plannotator?: string | null;
  serveFails?: boolean;
  processes?: Record<number, string>;
} = {}) {
  const serve = new Map<number, ServeMapping>(
    Object.entries(options.serve ?? {}).map(([port, mapping]) => [Number(port), mapping]),
  );
  const processes = new Map<number, string>(
    Object.entries(options.processes ?? {}).map(([pid, started]) => [Number(pid), started]),
  );
  const commands: Array<{ file: string; args: string[] }> = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const started: BridgeOptions[] = [];
  const reviews: Array<{
    stopped: boolean;
    decide(decision: UpstreamDecision): void;
  }> = [];
  let now = 1_000;

  const serveStatus = () =>
    JSON.stringify({
      TCP: Object.fromEntries([...serve.keys()].map((port) => [port, { HTTPS: true }])),
      Web: Object.fromEntries(
        [...serve.entries()].map(([port, { proxy }]) => [
          `${DNS_NAME}:${port}`,
          { Handlers: { "/": { Proxy: proxy } } },
        ]),
      ),
    });

  const entry = createPlannotatorHostEntry({
    async runCommand(file, args): Promise<CommandResult> {
      commands.push({ file, args: [...args] });
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (file === "ps") {
        const pid = Number(args.at(-1));
        return processes.has(pid) ? ok(`${processes.get(pid)}\n`) : { exitCode: 1, stdout: "", stderr: "" };
      }
      const command = args.join(" ");
      if (command === "status --json") {
        return ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS_NAME}.` } }));
      }
      if (command === "serve status --json") return ok(serveStatus());
      const on = /^serve --bg --https=(\d+) (\S+)$/u.exec(command);
      if (on) {
        if (options.serveFails) return { exitCode: 1, stdout: "", stderr: "serve config denied" };
        serve.set(Number(on[1]), { proxy: on[2]! });
        return ok();
      }
      const off = /^serve --https=(\d+) off$/u.exec(command);
      if (off) {
        serve.delete(Number(off[1]));
        return ok();
      }
      throw new Error(`unexpected command ${file} ${command}`);
    },
    async startPlanReview(bridgeOptions) {
      started.push(bridgeOptions);
      let resolve!: (decision: UpstreamDecision) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<UpstreamDecision>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const pid = 4242;
      processes.set(pid, "Tue Oct 14 13:00:00 2026");
      const record = {
        stopped: false,
        decide: (decision: UpstreamDecision) => {
          processes.delete(pid);
          resolve(decision);
        },
      };
      reviews.push(record);
      const review: RunningUpstreamReview = {
        url: "http://localhost:19500",
        port: 19500,
        pid,
        result,
        async stop() {
          record.stopped = true;
          processes.delete(pid);
          reject(new Error("Plannotator exited with code null"));
        },
      };
      return review;
    },
    findExecutable(name) {
      if (name === "tailscale") return options.tailscale === undefined ? TAILSCALE : options.tailscale;
      if (name === "plannotator") {
        return options.plannotator === undefined ? "/fake/bin/plannotator" : options.plannotator;
      }
      return null;
    },
    isExecutable: () => false,
    killProcess(pid, signal) {
      kills.push({ pid, signal });
      processes.delete(pid);
    },
    now: () => now,
    wait: async () => undefined,
  });

  return {
    entry,
    serve,
    commands,
    kills,
    started,
    reviews,
    advance(ms: number) {
      now += ms;
    },
  };
}

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function harnessFor(fake: ReturnType<typeof fakeHost>, worktree?: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-plannotator-host-data-"));
  const tempDir = await mkdtemp(join(tmpdir(), "bb-plannotator-host-temp-"));
  directories.push(dataDir, tempDir);
  const cwd = worktree ?? (await mkdtemp(join(tmpdir(), "bb-plannotator-worktree-")));
  if (!worktree) directories.push(cwd);
  const harness = experimental_createHostEntryHarness(fake.entry, {
    experimental_paths: { dataDir, tempDir },
  });
  const start = () =>
    harness.experimental_call("startReview", {
      sessionId: SESSION_ID,
      planMarkdown: "# Plan",
      cwd,
      origin: "claude-code",
    });
  return { harness, dataDir, cwd, start };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("Plannotator host entry", () => {
  it("starts Plannotator on loopback in the worktree and publishes it with tailscale serve", async () => {
    const fake = fakeHost({ serve: { 33757: { proxy: "http://127.0.0.1:33757" } } });
    const { harness, dataDir, cwd, start } = await harnessFor(fake);

    await expect(start()).resolves.toEqual({ url: `https://${DNS_NAME}:19500`, port: 19500 });

    expect(fake.started[0]).toMatchObject({
      binaryPath: "/fake/bin/plannotator",
      cwd,
      remote: false,
      portRange: "19500-19509",
      origin: "claude-code",
      dataDir: join(dataDir, "plannotator"),
      timeoutSeconds: null,
    });
    expect(fake.commands).toContainEqual({
      file: TAILSCALE,
      args: ["serve", "--bg", "--https=19500", "http://127.0.0.1:19500"],
    });
    expect(fake.serve.get(19500)).toEqual({ proxy: "http://127.0.0.1:19500" });
    expect(fake.serve.has(33757)).toBe(true);
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    expect(JSON.parse(await readFile(join(dataDir, "owned-processes.json"), "utf8"))).toEqual([
      { pid: 4242, port: 19500, started: "Tue Oct 14 13:00:00 2026" },
    ]);
    await harness.experimental_dispose();
  });

  it("reports a decision by signal and status, then releases everything on stop", async () => {
    const fake = fakeHost();
    const { harness, start } = await harnessFor(fake);
    await start();

    await expect(harness.experimental_call("getReview", { sessionId: SESSION_ID })).resolves.toEqual({
      status: "pending",
    });
    fake.reviews[0]!.decide({ approved: false, feedback: "Split step 2" });
    await flush();

    expect(harness.experimental_getSignals()).toEqual([
      { signal: "reviewChanged", payload: { sessionId: SESSION_ID } },
    ]);
    await expect(harness.experimental_call("getReview", { sessionId: SESSION_ID })).resolves.toEqual({
      status: "decided",
      decision: { approved: false, feedback: "Split step 2" },
    });
    expect(fake.serve.has(19500)).toBe(false);
    // The decision stays collectable until the server stops the review.
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(1);

    await expect(harness.experimental_call("stopReview", { sessionId: SESSION_ID })).resolves.toEqual({
      stopped: true,
    });
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await expect(harness.experimental_call("getReview", { sessionId: SESSION_ID })).resolves.toEqual({
      status: "unknown",
    });
    await harness.experimental_dispose();
  });

  it("kills the process and removes its mapping when a pending review is stopped", async () => {
    const fake = fakeHost();
    const { harness, dataDir, start } = await harnessFor(fake);
    await start();

    await harness.experimental_call("stopReview", { sessionId: SESSION_ID });

    expect(fake.reviews[0]!.stopped).toBe(true);
    expect(fake.serve.size).toBe(0);
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    expect(JSON.parse(await readFile(join(dataDir, "owned-processes.json"), "utf8"))).toEqual([]);
    await harness.experimental_dispose();
  });

  it("removes only its own stale mappings and verified orphan processes on worker start", async () => {
    const fake = fakeHost({
      serve: {
        33757: { proxy: "http://127.0.0.1:33757" },
        8447: { proxy: "http://127.0.0.1:8000" },
        19504: { proxy: "http://127.0.0.1:19504" },
        19505: { proxy: "http://127.0.0.1:3000" },
      },
      processes: { 777: "Mon Oct 13 09:00:00 2026", 778: "Tue Oct 14 08:00:00 2026" },
    });
    const { harness, dataDir } = await harnessFor(fake);
    await writeFile(
      join(dataDir, "owned-processes.json"),
      JSON.stringify([
        { pid: 777, port: 19504, started: "Mon Oct 13 09:00:00 2026" },
        // The pid was reused by an unrelated process: different start time.
        { pid: 778, port: 19506, started: "Sun Oct 12 10:00:00 2026" },
      ]),
    );

    await expect(harness.experimental_call("reconcile", {})).resolves.toEqual({
      removedPorts: [19504],
      killedPids: [777],
    });

    expect(fake.kills).toEqual([{ pid: 777, signal: "SIGTERM" }]);
    expect([...fake.serve.keys()].sort()).toEqual([19505, 33757, 8447].sort());
    expect(fake.commands.filter(({ args }) => args.includes("off"))).toEqual([
      { file: TAILSCALE, args: ["serve", "--https=19504", "off"] },
    ]);
    await harness.experimental_dispose();
  });

  it("fails clearly without tailscale and does not start Plannotator", async () => {
    const fake = fakeHost({ tailscale: null });
    const { harness, start } = await harnessFor(fake);

    await expect(start()).rejects.toThrow(/tailscale CLI is not on this machine's PATH or at \/usr\/local\/bin\/tailscale/u);
    expect(fake.started).toHaveLength(0);
    await harness.experimental_dispose();
  });

  it("stops Plannotator and reports the error when tailscale serve fails", async () => {
    const fake = fakeHost({ serveFails: true });
    const { harness, start } = await harnessFor(fake);

    await expect(start()).rejects.toThrow("tailscale serve failed for port 19500: serve config denied");
    expect(fake.reviews[0]!.stopped).toBe(true);
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
    await harness.experimental_dispose();
  });

  it("never replaces a mapping it did not create on its port", async () => {
    const fake = fakeHost({ serve: { 19500: { proxy: "http://127.0.0.1:3000" } } });
    const { harness, start } = await harnessFor(fake);

    await expect(start()).rejects.toThrow("tailscale serve already has a mapping on port 19500");
    expect(fake.serve.get(19500)).toEqual({ proxy: "http://127.0.0.1:3000" });
    expect(fake.reviews[0]!.stopped).toBe(true);
    await harness.experimental_dispose();
  });

  it("rejects a worktree that does not exist on the host", async () => {
    const fake = fakeHost();
    const { harness, start } = await harnessFor(fake, "/does/not/exist");

    await expect(start()).rejects.toThrow("The thread's worktree /does/not/exist does not exist on this machine.");
    expect(fake.started).toHaveLength(0);
    await harness.experimental_dispose();
  });

  it("stops every review and mapping when the worker is disposed", async () => {
    const fake = fakeHost();
    const { harness, start } = await harnessFor(fake);
    await start();

    await harness.experimental_dispose();

    expect(fake.reviews[0]!.stopped).toBe(true);
    expect(fake.serve.size).toBe(0);
    expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });

  it("stops a review nobody polls", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = fakeHost();
    const { harness, start } = await harnessFor(fake);
    await start();

    fake.advance(UNPOLLED_REVIEW_TIMEOUT_MS + 1);
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(harness.experimental_getRetainedWorkerLeaseCount()).toBe(0));

    expect(fake.reviews[0]!.stopped).toBe(true);
    expect(fake.serve.size).toBe(0);
    await harness.experimental_dispose();
  });
});
