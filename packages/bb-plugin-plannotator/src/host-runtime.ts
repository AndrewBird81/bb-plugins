// Runs Plannotator on a bb host that is not the server machine. Plannotator
// binds loopback in the thread's worktree; `tailscale serve` publishes it over
// HTTPS so every tailnet device can load the 20+ MB UI directly from the host.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk";
import type { BridgeOptions, RunningUpstreamReview } from "./bridge";
import {
  HOST_PORT_RANGE,
  hostContract,
  hostSignals,
  type HostReviewState,
} from "./host-contract";
import {
  TAILSCALE_FALLBACK_PATH,
  ownedServePorts,
  parseServeStatus,
  parseStatusDnsName,
  serveArgs,
  serveOffArgs,
  servePortInUse,
} from "./tailscale";

export type CommandResult = {
  /** Null when the command was killed, for example by its timeout. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type HostRuntimeDeps = {
  /** Run argv without a shell. Rejects only when the command cannot start. */
  runCommand(file: string, args: readonly string[], timeoutMs: number): Promise<CommandResult>;
  startPlanReview(options: BridgeOptions): Promise<RunningUpstreamReview>;
  /** Resolve a command name on PATH only. */
  findExecutable(name: string): string | null;
  isExecutable(path: string): boolean;
  killProcess(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  wait(ms: number): Promise<void>;
};

const TAILSCALE_TIMEOUT_MS = 10_000;
const PS_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;
/** The server polls every few seconds; a review nobody polls is orphaned. */
export const UNPOLLED_REVIEW_TIMEOUT_MS = 5 * 60_000;
const WATCHDOG_INTERVAL_MS = 60_000;
const OWNED_PROCESSES_FILE = "owned-processes.json";

/** A Plannotator process this plugin started, identified by pid and start time. */
type OwnedProcess = { pid: number; port: number; started: string };

type HostReview = {
  sessionId: string;
  review: RunningUpstreamReview;
  port: number;
  tailscalePath: string;
  state: HostReviewState;
  lease: ExperimentalHostWorkerLease;
  lastPolledAt: number;
  unpublished?: Promise<void>;
  stopped?: Promise<void>;
};

type ReconcileResult = { removedPorts: number[]; killedPids: number[] };
type HostContext = ExperimentalHostRpcContext<typeof hostSignals>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandDetail(result: CommandResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/u).slice(-3).join(" ");
  if (result.exitCode === null) return "timed out";
  return detail || `exit code ${result.exitCode}`;
}

function isOwnedProcess(value: unknown): value is OwnedProcess {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.pid) &&
    Number.isInteger(record.port) &&
    typeof record.started === "string"
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function createPlannotatorHostEntry(deps: HostRuntimeDeps) {
  const reviews = new Map<string, HostReview>();
  let dataDir: string | null = null;
  let startup: Promise<ReconcileResult> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let ownedWrites: Promise<unknown> = Promise.resolve();

  function resolveTailscale(): string | null {
    return (
      deps.findExecutable("tailscale") ??
      (deps.isExecutable(TAILSCALE_FALLBACK_PATH) ? TAILSCALE_FALLBACK_PATH : null)
    );
  }

  async function readServeStatus(tailscalePath: string) {
    const result = await deps.runCommand(
      tailscalePath,
      ["serve", "status", "--json"],
      TAILSCALE_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      throw new Error(`tailscale serve status failed: ${commandDetail(result)}`);
    }
    const status = parseServeStatus(result.stdout);
    if (!status) throw new Error("tailscale serve status returned unrecognized output.");
    return status;
  }

  async function readDnsName(tailscalePath: string): Promise<string> {
    let result: CommandResult;
    try {
      result = await deps.runCommand(tailscalePath, ["status", "--json"], TAILSCALE_TIMEOUT_MS);
    } catch (error) {
      throw new Error(`Could not run ${tailscalePath}: ${errorMessage(error)}`);
    }
    const name = result.exitCode === 0 ? parseStatusDnsName(result.stdout) : null;
    if (!name) {
      throw new Error(
        `Tailscale is not running or has no MagicDNS name on this machine (${commandDetail(result)}). Plannotator reviews here are published with tailscale serve.`,
      );
    }
    return name;
  }

  async function removeMapping(tailscalePath: string, port: number): Promise<boolean> {
    try {
      const result = await deps.runCommand(tailscalePath, serveOffArgs(port), TAILSCALE_TIMEOUT_MS);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function processStart(pid: number): Promise<string | null> {
    try {
      const result = await deps.runCommand("ps", ["-o", "lstart=", "-p", String(pid)], PS_TIMEOUT_MS);
      const started = result.stdout.trim();
      return result.exitCode === 0 && started ? started : null;
    } catch {
      return null;
    }
  }

  async function terminate(owned: OwnedProcess): Promise<void> {
    deps.killProcess(owned.pid, "SIGTERM");
    await deps.wait(KILL_GRACE_MS);
    if ((await processStart(owned.pid)) === owned.started) {
      deps.killProcess(owned.pid, "SIGKILL");
    }
  }

  async function readOwned(directory: string): Promise<OwnedProcess[]> {
    try {
      const parsed = JSON.parse(
        await readFile(join(directory, OWNED_PROCESSES_FILE), "utf8"),
      ) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isOwnedProcess) : [];
    } catch {
      return [];
    }
  }

  function updateOwned(
    directory: string,
    update: (current: OwnedProcess[]) => OwnedProcess[],
  ): Promise<void> {
    const next = ownedWrites.then(async () => {
      await mkdir(directory, { recursive: true });
      const updated = update(await readOwned(directory));
      await writeFile(join(directory, OWNED_PROCESSES_FILE), JSON.stringify(updated), {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    ownedWrites = next.catch(() => undefined);
    return next;
  }

  /**
   * Remove what a dead worker left behind: Plannotator processes recorded in
   * the data dir whose pid still has the recorded start time, and serve
   * mappings in this plugin's port range that match the exact shape it creates.
   */
  async function reconcile(directory: string): Promise<ReconcileResult> {
    const livePids = new Set([...reviews.values()].map(({ review }) => review.pid));
    const livePorts = new Set([...reviews.values()].map(({ port }) => port));
    const killedPids: number[] = [];
    for (const owned of await readOwned(directory)) {
      if (livePids.has(owned.pid)) continue;
      if ((await processStart(owned.pid)) !== owned.started) continue;
      await terminate(owned);
      killedPids.push(owned.pid);
    }
    await updateOwned(directory, (current) =>
      current.filter((owned) => livePids.has(owned.pid)),
    );

    const removedPorts: number[] = [];
    const tailscalePath = resolveTailscale();
    if (tailscalePath) {
      const status = await readServeStatus(tailscalePath);
      for (const port of ownedServePorts(status, HOST_PORT_RANGE)) {
        if (livePorts.has(port)) continue;
        if (await removeMapping(tailscalePath, port)) removedPorts.push(port);
      }
    }
    return { removedPorts, killedPids };
  }

  function ensureStartup(directory: string): Promise<ReconcileResult> {
    dataDir = directory;
    startup ??= reconcile(directory).catch((error: unknown) => {
      startup = null;
      throw error;
    });
    return startup;
  }

  function unpublish(entry: HostReview): Promise<void> {
    entry.unpublished ??= removeMapping(entry.tailscalePath, entry.port).then(() => undefined);
    return entry.unpublished;
  }

  function stopEntry(entry: HostReview): Promise<void> {
    entry.stopped ??= (async () => {
      reviews.delete(entry.sessionId);
      if (reviews.size === 0 && watchdog) {
        clearInterval(watchdog);
        watchdog = null;
      }
      await entry.review.stop().catch(() => undefined);
      await unpublish(entry);
      if (dataDir) {
        await updateOwned(dataDir, (current) =>
          current.filter((owned) => owned.pid !== entry.review.pid),
        ).catch(() => undefined);
      }
      await entry.lease.dispose();
    })();
    return entry.stopped;
  }

  function startWatchdog(): void {
    if (watchdog) return;
    watchdog = setInterval(() => {
      const now = deps.now();
      for (const entry of reviews.values()) {
        if (now - entry.lastPolledAt > UNPOLLED_REVIEW_TIMEOUT_MS) void stopEntry(entry);
      }
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref?.();
  }

  function settle(entry: HostReview, state: HostReviewState, context: HostContext): void {
    if (entry.state.status !== "pending") return;
    entry.state = state;
    // The process has exited. Unpublish now; keep the state and the lease
    // until the server collects the decision with stopReview.
    void entry.review.stop().catch(() => undefined);
    void unpublish(entry);
    void context
      .experimental_emitSignal("reviewChanged", { sessionId: entry.sessionId })
      .catch(() => undefined);
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      async startReview(input, context) {
        const directory = context.experimental_paths.dataDir;
        await ensureStartup(directory);
        if (reviews.has(input.sessionId)) {
          throw new Error("This Plannotator review is already running.");
        }
        const tailscalePath = resolveTailscale();
        if (!tailscalePath) {
          throw new Error(
            `The tailscale CLI is not on this machine's PATH or at ${TAILSCALE_FALLBACK_PATH}. Plannotator reviews here are published with tailscale serve.`,
          );
        }
        const dnsName = await readDnsName(tailscalePath);
        if (!isAbsolute(input.cwd) || !(await isDirectory(input.cwd))) {
          throw new Error(`The thread's worktree ${input.cwd} does not exist on this machine.`);
        }
        const binaryPath = deps.findExecutable("plannotator");
        if (!binaryPath) {
          throw new Error("plannotator is not on this machine's PATH for the bb host daemon.");
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        context.lifecycle.signal.addEventListener("abort", abort, { once: true });
        context.signal.addEventListener("abort", abort, { once: true });
        let review: RunningUpstreamReview;
        try {
          review = await deps.startPlanReview({
            binaryPath,
            planMarkdown: input.planMarkdown,
            timeoutSeconds: null,
            signal: controller.signal,
            origin: input.origin,
            dataDir: join(directory, "plannotator"),
            remote: false,
            portRange: `${HOST_PORT_RANGE.first}-${HOST_PORT_RANGE.last}`,
            cwd: input.cwd,
          });
        } catch (error) {
          context.lifecycle.signal.removeEventListener("abort", abort);
          throw error;
        } finally {
          context.signal.removeEventListener("abort", abort);
        }
        void review.result.catch(() => undefined);

        const { pid, port } = review;
        try {
          if (pid !== undefined) {
            const started = await processStart(pid);
            if (started) {
              await updateOwned(directory, (current) => [...current, { pid, port, started }]);
            }
          }
          if (port < HOST_PORT_RANGE.first || port > HOST_PORT_RANGE.last) {
            throw new Error(`Plannotator bound port ${port}, outside ${HOST_PORT_RANGE.first}-${HOST_PORT_RANGE.last}.`);
          }
          if (servePortInUse(await readServeStatus(tailscalePath), port)) {
            throw new Error(
              `tailscale serve already has a mapping on port ${port}. The plugin does not replace mappings it did not create.`,
            );
          }
          const served = await deps.runCommand(tailscalePath, serveArgs(port), TAILSCALE_TIMEOUT_MS);
          if (served.exitCode !== 0) {
            throw new Error(`tailscale serve failed for port ${port}: ${commandDetail(served)}`);
          }
        } catch (error) {
          context.lifecycle.signal.removeEventListener("abort", abort);
          await review.stop().catch(() => undefined);
          await updateOwned(directory, (current) =>
            current.filter((owned) => owned.pid !== pid),
          ).catch(() => undefined);
          throw error;
        }

        const entry: HostReview = {
          sessionId: input.sessionId,
          review,
          port,
          tailscalePath,
          state: { status: "pending" },
          lease: context.experimental_retainWorker(),
          lastPolledAt: deps.now(),
        };
        reviews.set(entry.sessionId, entry);
        startWatchdog();
        void review.result.then(
          (decision) => settle(entry, { status: "decided", decision }, context),
          (error: unknown) => settle(entry, { status: "failed", error: errorMessage(error) }, context),
        );
        return { url: `https://${dnsName}:${port}`, port };
      },

      async getReview({ sessionId }) {
        const entry = reviews.get(sessionId);
        if (!entry) return { status: "unknown" as const };
        entry.lastPolledAt = deps.now();
        return entry.state;
      },

      async stopReview({ sessionId }) {
        const entry = reviews.get(sessionId);
        if (!entry) return { stopped: false };
        await stopEntry(entry);
        return { stopped: true };
      },

      async reconcile(_input, context) {
        return ensureStartup(context.experimental_paths.dataDir);
      },
    },
    dispose: async () => {
      await Promise.allSettled([...reviews.values()].map(stopEntry));
    },
  });
}
