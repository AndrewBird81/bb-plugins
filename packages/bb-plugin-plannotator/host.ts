// The `bb.host` entry: runs on a thread's own machine when that machine is not
// the bb server. See src/host-runtime.ts.
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startUpstreamPlanReview } from "./src/bridge";
import { createPlannotatorHostEntry, type CommandResult } from "./src/host-runtime";
import { startReviewProxy } from "./src/review-proxy";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export default createPlannotatorHostEntry({
  runCommand(file, args, timeoutMs) {
    return new Promise<CommandResult>((resolve, reject) => {
      execFile(
        file,
        [...args],
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "string") {
            reject(error);
            return;
          }
          const exitCode = error ? (typeof error.code === "number" ? error.code : null) : 0;
          resolve({ exitCode, stdout, stderr });
        },
      );
    });
  },
  startPlanReview: startUpstreamPlanReview,
  startProxy: startReviewProxy,
  // Upstream's upload directory: the child inherits this process's TMPDIR.
  uploadDir: join(tmpdir(), "plannotator"),
  // PATH only: unlike the server's resolver, no ~/.local/bin fallback, so a
  // stale standalone install never shadows the packaged binary.
  findExecutable(name) {
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
    return null;
  },
  isExecutable,
  killProcess(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  },
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
