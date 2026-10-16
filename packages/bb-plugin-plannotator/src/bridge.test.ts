import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUpstreamInput,
  BUNDLED_BINARY,
  bundledAssetFor,
  bundledTargetFor,
  ensureBundledPlannotatorBinary,
  fetchLatestUpstreamVersion,
  missingBinaryMessage,
  parseReadyMetadata,
  parseUpstreamDecision,
  rehostUpstreamUrl,
  REMOTE_PORT_RANGE,
  resolvePlannotatorBinary,
  startUpstreamPlanReview,
  startUpstreamSession,
} from "./bridge";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("upstream Plannotator bridge", () => {
  it("parses the ready-file record while ignoring diagnostics", () => {
    expect(
      parseReadyMetadata(
        `diagnostic\n${JSON.stringify({ url: "http://127.0.0.1:43123", isRemote: false, port: 43123 })}\n`,
      ),
    ).toEqual({
      url: "http://127.0.0.1:43123",
      isRemote: false,
      port: 43123,
    });
  });

  it("rejects malformed ready metadata", () => {
    expect(parseReadyMetadata(JSON.stringify({ url: "file:///tmp/nope", port: 12 }))).toBeNull();
    expect(parseReadyMetadata(JSON.stringify({ url: "http://127.0.0.1:12", port: 0 }))).toBeNull();
  });

  it("parses the upstream decision record and preserves feedback", () => {
    expect(
      parseUpstreamDecision(
        `informational line\n${JSON.stringify({ approved: false, feedback: "Split the risky migration step." })}\n`,
      ),
    ).toEqual({ approved: false, feedback: "Split the risky migration step." });
  });

  it("reports a useful error when upstream never returns a decision", () => {
    expect(() => parseUpstreamDecision("", "server failed to bind")).toThrow(
      /server failed to bind/u,
    );
  });

  it("builds the official generic plan-review hook input", () => {
    expect(JSON.parse(buildUpstreamInput("# Plan\n\n- Verify"))).toEqual({
      hook_event_name: "PermissionRequest",
      permission_mode: "default",
      tool_input: { plan: "# Plan\n\n- Verify" },
    });
  });

  it("parses the official hook decision envelope", () => {
    expect(
      parseUpstreamDecision(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        }),
      ),
    ).toEqual({ approved: true });
    expect(
      parseUpstreamDecision(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: "Please split this step." },
          },
        }),
      ),
    ).toEqual({ approved: false, feedback: "Please split this step." });
  });

  it("ignores upstream's permission-mode and agent-switch hints on approval", () => {
    expect(
      parseUpstreamDecision(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {
              behavior: "allow",
              updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
            },
          },
        }),
      ),
    ).toEqual({ approved: true });
  });

  it("normalizes the embedded URL host without changing the upstream port", () => {
    expect(rehostUpstreamUrl("http://localhost:43210", "127.0.0.1")).toBe(
      "http://127.0.0.1:43210",
    );
    expect(rehostUpstreamUrl("http://localhost:43210", undefined)).toBe(
      "http://localhost:43210",
    );
  });

  it("passes remote transport settings, origin, and persistent state without a deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-env-test-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "plannotator");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const ready = process.env.PLANNOTATOR_READY_FILE;
const fs = require("node:fs");
fs.appendFileSync(ready, JSON.stringify({ url: "http://127.0.0.1:43210", isRemote: false, port: 43210 }) + "\\n");
setTimeout(() => process.stdout.write(JSON.stringify({
  approved: true,
  feedback: JSON.stringify({ origin: process.env.PLANNOTATOR_ORIGIN, dataDir: process.env.PLANNOTATOR_DATA_DIR, remote: process.env.PLANNOTATOR_REMOTE, port: process.env.PLANNOTATOR_PORT }),
}) + "\\n"), 20);
process.stdin.resume();
`,
      "utf8",
    );
    await chmod(binary, 0o755);

    const controller = new AbortController();
    const running = await startUpstreamPlanReview({
      binaryPath: binary,
      planMarkdown: "# Plan",
      timeoutSeconds: null,
      signal: controller.signal,
      origin: "codex",
      dataDir: join(directory, "state"),
      remote: true,
    });
    const decision = await running.result;
    expect(decision).toEqual({
      approved: true,
      feedback: JSON.stringify({
        origin: "codex",
        dataDir: join(directory, "state"),
        remote: "1",
        port: REMOTE_PORT_RANGE,
      }),
    });
    await running.stop();
  });

  it("binds loopback on a caller's port range and never inherits the remote agent terminal", async () => {
    vi.stubEnv("PLANNOTATOR_AGENT_TERMINAL_REMOTE", "1");
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-env-test-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "plannotator");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PLANNOTATOR_READY_FILE, JSON.stringify({ url: "http://localhost:19503", isRemote: false, port: 19503 }) + "\\n");
setTimeout(() => process.stdout.write(JSON.stringify({
  approved: true,
  feedback: JSON.stringify({ cwd: process.cwd(), remote: process.env.PLANNOTATOR_REMOTE, port: process.env.PLANNOTATOR_PORT, terminal: process.env.PLANNOTATOR_AGENT_TERMINAL_REMOTE ?? null }),
}) + "\\n"), 20);
process.stdin.resume();
`,
      "utf8",
    );
    await chmod(binary, 0o755);

    const running = await startUpstreamPlanReview({
      binaryPath: binary,
      planMarkdown: "# Plan",
      timeoutSeconds: null,
      signal: new AbortController().signal,
      remote: false,
      portRange: "19500-19509",
      cwd: directory,
    });
    expect(running.port).toBe(19503);
    expect(running.pid).toEqual(expect.any(Number));
    const decision = await running.result;
    expect(JSON.parse(decision.feedback!)).toEqual({
      cwd: await realpath(directory),
      remote: "0",
      port: "19500-19509",
      terminal: null,
    });
    await running.stop();
  });

  /**
   * A stand-in for review/annotate: serves /api/plan with the given agent
   * terminal state, records its argv, cwd and stdin, and writes a result
   * record (or exits as told) after `PLANNOTATOR_FAKE_DELAY_MS`.
   */
  async function fakeSessionBinary(directory: string): Promise<string> {
    const binary = join(directory, "plannotator");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const terminal = process.env.FAKE_TERMINAL === "missing" ? undefined : { enabled: process.env.FAKE_TERMINAL === "on" };
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ plan: "", ...(terminal ? { agentTerminal: terminal } : {}) }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.appendFileSync(process.env.PLANNOTATOR_READY_FILE, JSON.stringify({ url: "http://localhost:" + port, isRemote: false, port }) + "\\n");
  setTimeout(() => {
    if (process.env.FAKE_EXIT) {
      process.stderr.write("line 1\\nBase ref not found: nosuch\\n");
      process.exit(Number(process.env.FAKE_EXIT));
    }
    const file = process.env.PLANNOTATOR_HOST_RESULT_FILE;
    if (file && process.env.FAKE_WRITE_RESULT !== "0") {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        v: 1, surface: "review", decision: "annotated", noop: false, annotationCount: 1, target: process.cwd(),
        message: JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd(), share: process.env.PLANNOTATOR_SHARE ?? null, pcwd: process.env.PLANNOTATOR_CWD ?? null }),
      }));
    }
    process.exit(0);
  }, Number(process.env.PLANNOTATOR_FAKE_DELAY_MS || "30"));
});
`,
      "utf8",
    );
    await chmod(binary, 0o755);
    return binary;
  }

  it("runs a review session and reads its result file, then removes it", async () => {
    vi.stubEnv("PLANNOTATOR_CWD", "/elsewhere");
    const directory = await realpath(await mkdtemp(join(tmpdir(), "bb-plannotator-session-test-")));
    temporaryDirectories.push(directory);
    const binary = await fakeSessionBinary(directory);
    const sessionId = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";

    const running = await startUpstreamSession({
      binaryPath: binary,
      session: { mode: "review", diffType: "uncommitted" },
      sessionId,
      timeoutSeconds: null,
      signal: new AbortController().signal,
      dataDir: join(directory, "data"),
      remote: true,
      cwd: directory,
    });
    const result = await running.result;
    expect(result).toMatchObject({ surface: "review", decision: "annotated", noop: false, target: directory });
    expect(JSON.parse((result as { message: string }).message)).toEqual({
      argv: ["review", "--no-git-remote-check", "--diff-type", "uncommitted"],
      stdin: "",
      cwd: directory,
      share: "disabled",
      pcwd: null,
    });
    await expect(stat(join(directory, "data", "claude-code-mod", sessionId))).rejects.toThrow();
    await running.stop();
  });

  it("passes annotate-last text on stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-session-test-"));
    temporaryDirectories.push(directory);
    vi.stubEnv("FAKE_TERMINAL", "off");
    // Long enough for the agent-terminal check to read /api/plan before the fake exits.
    vi.stubEnv("PLANNOTATOR_FAKE_DELAY_MS", "500");
    const running = await startUpstreamSession({
      binaryPath: await fakeSessionBinary(directory),
      session: { mode: "annotate-last", markdown: "The reply" },
      timeoutSeconds: null,
      signal: new AbortController().signal,
      dataDir: join(directory, "data"),
      cwd: directory,
    });
    const message = JSON.parse(((await running.result) as { message: string }).message) as { stdin: string; argv: string[] };
    expect(message).toMatchObject({ stdin: "The reply", argv: ["annotate-last", "--stdin", "--gate"] });
    await running.stop();
  });

  it("refuses to publish an annotate session whose agent terminal is on or unreported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-session-test-"));
    temporaryDirectories.push(directory);
    const binary = await fakeSessionBinary(directory);
    vi.stubEnv("PLANNOTATOR_FAKE_DELAY_MS", "60000");
    for (const [terminal, error] of [["on", "enabled its agent terminal"], ["missing", "Could not confirm"]] as const) {
      vi.stubEnv("FAKE_TERMINAL", terminal);
      await expect(
        startUpstreamSession({
          binaryPath: binary,
          session: { mode: "annotate", path: join(directory, "a.md") },
          timeoutSeconds: null,
          signal: new AbortController().signal,
          dataDir: join(directory, "data"),
          cwd: directory,
        }),
      ).rejects.toThrow(error);
    }
  });

  it("reports a missing result as too old, a startup failure with its stderr, and a stop as an error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-session-test-"));
    temporaryDirectories.push(directory);
    const binary = await fakeSessionBinary(directory);
    const start = () =>
      startUpstreamSession({
        binaryPath: binary,
        session: { mode: "review" },
        timeoutSeconds: null,
        signal: new AbortController().signal,
        dataDir: join(directory, "data"),
        cwd: directory,
      });

    vi.stubEnv("FAKE_WRITE_RESULT", "0");
    await expect((await start()).result).rejects.toThrow("too old");
    vi.stubEnv("FAKE_WRITE_RESULT", "1");

    vi.stubEnv("FAKE_EXIT", "1");
    await expect((await start()).result).rejects.toThrow("Plannotator exited with code 1: line 1 Base ref not found: nosuch");
    vi.stubEnv("FAKE_EXIT", "");

    vi.stubEnv("PLANNOTATOR_FAKE_DELAY_MS", "60000");
    const running = await start();
    const outcome = running.result.catch((error: Error) => error.message);
    await running.stop();
    expect(await outcome).toMatch(/Plannotator exited with code/u);
  });

  it("reads the latest upstream release for the update-toast dismissal", async () => {
    const release = (body: unknown, status = 200) => async () => Response.json(body, { status });
    expect(await fetchLatestUpstreamVersion(release({ tag_name: "v0.29.0" }))).toBe("0.29.0");
    expect(await fetchLatestUpstreamVersion(release({}, 403))).toBeNull();
    expect(await fetchLatestUpstreamVersion(release({ tag_name: "v1; domain=evil" }))).toBeNull();
    expect(
      await fetchLatestUpstreamVersion(async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });

  it("returns a terminal decision when the upstream review times out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-timeout-test-"));
    temporaryDirectories.push(directory);
    const binary = join(directory, "plannotator");
    await writeFile(
      binary,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.PLANNOTATOR_READY_FILE, JSON.stringify({ url: "http://127.0.0.1:43211", isRemote: false, port: 43211 }) + "\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(binary, 0o755);

    const running = await startUpstreamPlanReview({
      binaryPath: binary,
      planMarkdown: "# Plan",
      timeoutSeconds: 0.01,
      signal: new AbortController().signal,
    });
    await expect(running.result).resolves.toEqual({
      approved: false,
      feedback: expect.stringContaining("No response within 0.01 seconds"),
    });
    await running.stop();
  });

  it("selects only the official supported platform targets", () => {
    expect(bundledTargetFor("darwin", "arm64")).toBe("darwin-arm64");
    expect(bundledTargetFor("win32", "x64")).toBe("win32-x64");
    expect(bundledAssetFor("linux", "arm64")?.name).toBe("plannotator-linux-arm64");
    expect(bundledTargetFor("freebsd", "x64")).toBeNull();
  });

  it("downloads, verifies, caches, and reuses the bundled runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bundle-test-"));
    temporaryDirectories.push(directory);
    const body = Buffer.from("official test runtime");
    const asset = {
      target: "darwin-arm64" as const,
      name: "plannotator-test-runtime",
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    };
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(body);
    };

    const first = await ensureBundledPlannotatorBinary({
      runtimeDir: directory,
      asset,
      fetchImpl,
    });
    expect(await readFile(first)).toEqual(body);

    const second = await ensureBundledPlannotatorBinary({
      runtimeDir: directory,
      asset,
      fetchImpl: async () => {
        throw new Error("cache should avoid another download");
      },
    });
    expect(second).toBe(first);
    expect(fetchCount).toBe(1);
  });

  it("redownloads a same-size cache whose contents no longer match the pin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bundle-integrity-"));
    temporaryDirectories.push(directory);
    const body = Buffer.from("official test runtime");
    const asset = {
      target: "darwin-arm64" as const,
      name: "plannotator-integrity-runtime",
      sha256: createHash("sha256").update(body).digest("hex"),
      sizeBytes: body.byteLength,
    };
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response(body);
    };

    const binary = await ensureBundledPlannotatorBinary({
      runtimeDir: directory,
      asset,
      fetchImpl,
    });
    await writeFile(binary, Buffer.alloc(body.byteLength, 0));

    await ensureBundledPlannotatorBinary({ runtimeDir: directory, asset, fetchImpl });
    expect(fetchCount).toBe(2);
    await expect(readFile(binary)).resolves.toEqual(body);
  });

  it("does not cache a downloaded runtime with the wrong digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bundle-checksum-"));
    temporaryDirectories.push(directory);
    const body = Buffer.from("unexpected runtime");
    const asset = {
      target: "darwin-arm64" as const,
      name: "plannotator-bad-runtime",
      sha256: createHash("sha256").update("different runtime").digest("hex"),
      sizeBytes: body.byteLength,
    };

    await expect(
      ensureBundledPlannotatorBinary({
        runtimeDir: directory,
        asset,
        fetchImpl: async () => new Response(body),
      }),
    ).rejects.toThrow(/checksum mismatch/u);
  });

  it("resolves an explicit executable before PATH lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-plannotator-bridge-test-"));
    temporaryDirectories.push(directory);
    const executable = join(directory, "plannotator");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    expect(resolvePlannotatorBinary(executable, { PATH: "" })).toBe(executable);
  });

  it("explains the bundled runtime and external override", () => {
    expect(missingBinaryMessage(BUNDLED_BINARY)).toContain("SHA-256");
    expect(missingBinaryMessage("plannotator")).toContain("bundled");
  });
});
