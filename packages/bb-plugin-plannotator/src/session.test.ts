import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAgentTerminalOff,
  buildSessionLaunch,
  readSessionResult,
  resolveAnnotateTarget,
} from "./session";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

const SESSION_ID = "6f9619ff-8b86-4d01-b42d-00cf4fc964ff";
const base = { dataDir: "/data", sessionId: SESSION_ID, remote: false };
const resultFile = `/data/claude-code-mod/${SESSION_ID}/result.json`;

describe("session launch", () => {
  it("keeps plan review on the stdin hook protocol", () => {
    const launch = buildSessionLaunch({ mode: "plan", planMarkdown: "# Plan" }, base);
    expect(launch.args).toEqual([]);
    expect(JSON.parse(launch.stdin!)).toMatchObject({ tool_input: { plan: "# Plan" } });
    expect(launch.resultFile).toBeNull();
    expect(launch.env).toEqual({});
    expect(launch.deleteEnv).toEqual(["PLANNOTATOR_AGENT_TERMINAL_REMOTE"]);
  });

  it("starts review with no remote check, and diff options only when given", () => {
    expect(buildSessionLaunch({ mode: "review" }, base)).toEqual({
      args: ["review", "--no-git-remote-check"],
      stdin: null,
      env: { PLANNOTATOR_HOST_RESULT_FILE: resultFile, PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL: "1" },
      deleteEnv: [
        "PLANNOTATOR_AGENT_TERMINAL_REMOTE",
        "PLANNOTATOR_CWD",
        "PLANNOTATOR_HOST_MESSAGES_FILE",
      ],
      resultFile,
    });
    expect(
      buildSessionLaunch({ mode: "review", diffType: "uncommitted", base: "origin/main" }, base).args,
    ).toEqual(["review", "--no-git-remote-check", "--diff-type", "uncommitted", "--base", "origin/main"]);
  });

  it("annotates an absolute path last, without --json", () => {
    expect(buildSessionLaunch({ mode: "annotate", path: "/repo/docs/a.md" }, base).args).toEqual([
      "annotate",
      "--gate",
      "/repo/docs/a.md",
    ]);
    expect(() => buildSessionLaunch({ mode: "annotate", path: "docs/a.md" }, base)).toThrow("absolute");
  });

  it("annotates a reply from stdin", () => {
    const launch = buildSessionLaunch({ mode: "annotate-last", markdown: "Reply text" }, base);
    expect(launch.args).toEqual(["annotate-last", "--stdin", "--gate"]);
    expect(launch.stdin).toBe("Reply text");
  });

  it("disables sharing only for remote sessions and needs a data dir for results", () => {
    expect(buildSessionLaunch({ mode: "plan", planMarkdown: "x" }, { ...base, remote: true }).env).toEqual({
      PLANNOTATOR_SHARE: "disabled",
    });
    expect(
      buildSessionLaunch({ mode: "annotate", path: "/a.html" }, { ...base, remote: true }).env.PLANNOTATOR_SHARE,
    ).toBe("disabled");
    expect(buildSessionLaunch({ mode: "review" }, base).env.PLANNOTATOR_SHARE).toBeUndefined();
    expect(() => buildSessionLaunch({ mode: "review" }, { ...base, dataDir: undefined })).toThrow(
      "needs a data directory",
    );
  });
});

describe("session result", () => {
  // Records written by plannotator 0.28.6 (design §1).
  const fixtures = {
    reviewApproved: { v: 1, surface: "review", decision: "approved", message: "", noop: true, annotationCount: 0, target: "/repo" },
    annotateAnnotated: {
      v: 1,
      surface: "annotate",
      decision: "annotated",
      message: "# Markdown Annotations\n\nFile: /repo/a.md\n\nFix this.\n\nPlease address the annotation feedback above.",
      noop: false,
      annotationCount: 1,
      target: "/repo/a.md",
    },
    lastDismissed: { v: 1, surface: "annotate-last", decision: "dismissed", message: "", noop: true },
  };

  it("reads approved, annotated and dismissed records and drops unknown fields", async () => {
    const directory = await tempDir("bb-plannotator-result-");
    for (const [name, record] of Object.entries(fixtures)) {
      await writeFile(join(directory, `${name}.json`), `${JSON.stringify({ ...record, extra: true })}\n`);
    }
    await expect(readSessionResult(join(directory, "reviewApproved.json"))).resolves.toEqual({
      surface: "review",
      decision: "approved",
      message: "",
      noop: true,
      annotationCount: 0,
      target: "/repo",
    });
    await expect(readSessionResult(join(directory, "annotateAnnotated.json"))).resolves.toMatchObject({
      decision: "annotated",
      noop: false,
    });
    await expect(readSessionResult(join(directory, "lastDismissed.json"))).resolves.toEqual({
      surface: "annotate-last",
      decision: "dismissed",
      message: "",
      noop: true,
    });
  });

  it("explains a missing result as an old plannotator, and rejects plan decisions", async () => {
    const directory = await tempDir("bb-plannotator-result-");
    await expect(readSessionResult(join(directory, "missing.json"))).rejects.toThrow("too old");
    // What an older plannotator printed travels with the error: it may be the user's feedback.
    await expect(readSessionResult(join(directory, "missing.json"), "  # Message Annotations\n\nShorter.  ")).rejects.toMatchObject({
      name: "SessionOutputError",
      output: "# Message Annotations\n\nShorter.",
    });
    await writeFile(join(directory, "plan.json"), JSON.stringify({ surface: "plan", decision: "denied", message: "", noop: false }));
    await expect(readSessionResult(join(directory, "plan.json"))).rejects.toThrow("does not understand");
  });
});

describe("annotate target", () => {
  it("accepts Markdown and HTML files inside the worktree by real path", async () => {
    const worktree = await tempDir("bb-plannotator-worktree-");
    await mkdir(join(worktree, "docs"));
    await writeFile(join(worktree, "docs", "a.md"), "# A");
    await writeFile(join(worktree, "page.HTML"), "<p>");
    await expect(resolveAnnotateTarget(worktree, "docs/a.md")).resolves.toBe(join(worktree, "docs", "a.md"));
    await expect(resolveAnnotateTarget(worktree, join(worktree, "page.HTML"))).resolves.toBe(
      join(worktree, "page.HTML"),
    );
  });

  it("refuses paths outside the worktree, symlink escapes, directories and other types", async () => {
    const worktree = await tempDir("bb-plannotator-worktree-");
    const outside = await tempDir("bb-plannotator-outside-");
    await writeFile(join(outside, "secret.md"), "x");
    await symlink(join(outside, "secret.md"), join(worktree, "link.md"));
    await mkdir(join(worktree, "dir.md"));
    await writeFile(join(worktree, "code.ts"), "x");

    await expect(resolveAnnotateTarget(worktree, join(outside, "secret.md"))).rejects.toThrow("outside");
    await expect(resolveAnnotateTarget(worktree, "../x.md")).rejects.toThrow();
    await expect(resolveAnnotateTarget(worktree, "link.md")).rejects.toThrow("outside");
    await expect(resolveAnnotateTarget(worktree, "dir.md")).rejects.toThrow("not a file");
    await expect(resolveAnnotateTarget(worktree, "code.ts")).rejects.toThrow("Only Markdown");
    await expect(resolveAnnotateTarget(worktree, "missing.md")).rejects.toThrow("does not exist");
  });
});

describe("agent terminal guard", () => {
  const planWith = (body: unknown) => async () => Response.json(body);

  it("refuses an enabled terminal and an annotate session that does not report it", async () => {
    await expect(
      assertAgentTerminalOff(1, "annotate", planWith({ agentTerminal: { enabled: true } })),
    ).rejects.toThrow("enabled its agent terminal");
    await expect(assertAgentTerminalOff(1, "annotate", planWith({ plan: "x" }))).rejects.toThrow(
      "Could not confirm",
    );
    await expect(
      assertAgentTerminalOff(1, "annotate-last", planWith({ agentTerminal: { enabled: true } })),
    ).rejects.toThrow("enabled its agent terminal");
    await expect(
      assertAgentTerminalOff(1, "annotate", async () => {
        throw new Error("connection refused");
      }),
    ).rejects.toThrow("connection refused");
  });

  it("accepts a disabled terminal, and skips modes without one", async () => {
    await assertAgentTerminalOff(1, "annotate", planWith({ agentTerminal: { enabled: false, reason: "runtime-unavailable" } }));
    await assertAgentTerminalOff(1, "annotate-last", planWith({ plan: "x" }));
    let fetched = false;
    const spy = async () => {
      fetched = true;
      return Response.json({});
    };
    await assertAgentTerminalOff(1, "review", spy);
    await assertAgentTerminalOff(1, "plan", spy);
    expect(fetched).toBe(false);
  });
});
