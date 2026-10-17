// Runs Plannotator on a bb host that is not the server machine. Plannotator
// binds a random loopback port in the thread's worktree. A checking proxy
// (src/review-proxy.ts) listens on a port in HOST_PORT_RANGE, and
// `tailscale serve` publishes that port over HTTPS so every tailnet device can
// load the 20+ MB UI directly from the host.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
  type ExperimentalHostWorkerLease,
} from "@get-bb/plugin-sdk";
import type { RunningUpstreamReview, SessionOptions } from "./bridge";
import { resolveAnnotateTarget, sessionErrorOutput } from "./session";
import type { ReviewProxyOptions, RunningReviewProxy } from "./review-proxy";
import {
  HOST_PORT_RANGE,
  UNPOLLED_REVIEW_TIMEOUT_MS,
  hostContract,
  hostSignals,
  type BridgeHost,
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
  startSession(options: SessionOptions): Promise<RunningUpstreamReview>;
  /** Listen on 127.0.0.1:port. Rejects with code EADDRINUSE when it is taken. */
  startProxy(port: number, options: ReviewProxyOptions): Promise<RunningReviewProxy>;
  /** Plannotator's image upload directory, which `/api/image` may read. */
  uploadDir: string;
  /** Loopback requests to Plannotator's session bridge. */
  fetch: typeof fetch;
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
const WATCHDOG_INTERVAL_MS = 60_000;
const OWNED_FILE = "owned-processes.json";

/** A Plannotator process this plugin started, identified by pid and start time. */
type OwnedProcess = { pid: number; started: string };
/**
 * What this plugin created on the host and has not cleaned up yet. Reconcile
 * only removes serve mappings recorded here, never one by its shape alone.
 */
type OwnedState = { processes: OwnedProcess[]; mappings: number[] };

type HostReview = {
  sessionId: string;
  review: RunningUpstreamReview;
  proxy: RunningReviewProxy;
  /** The published port, which the proxy listens on. */
  port: number;
  tailscalePath: string;
  /** The session bridge's bearer token; set when Ask AI uses the thread's agent. */
  bridgeToken?: string;
  state: HostReviewState;
  lease: ExperimentalHostWorkerLease;
  lastPolledAt: number;
  unpublished?: Promise<void>;
  stopped?: Promise<void>;
};

/** Resources of a review whose start has not finished, kept out of reconcile. */
type StartClaim = { pid?: number; port?: number };

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
  return Number.isInteger(record.pid) && typeof record.started === "string";
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

/** Read the owned state, including 0.4.0's array of `{ pid, port, started }`. */
export function parseOwnedState(text: string): OwnedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { processes: [], mappings: [] };
  }
  if (Array.isArray(parsed)) {
    // 0.4.0 published each process on its own port.
    const processes = parsed.filter(isOwnedProcess);
    return {
      processes: processes.map(({ pid, started }) => ({ pid, started })),
      mappings: processes.map((owned) => (owned as { port?: unknown }).port).filter(isPort),
    };
  }
  if (typeof parsed !== "object" || parsed === null) return { processes: [], mappings: [] };
  const record = parsed as Record<string, unknown>;
  return {
    processes: Array.isArray(record.processes) ? record.processes.filter(isOwnedProcess) : [],
    mappings: Array.isArray(record.mappings) ? record.mappings.filter(isPort) : [],
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function hostPorts(): number[] {
  const ports: number[] = [];
  for (let port = HOST_PORT_RANGE.first; port <= HOST_PORT_RANGE.last; port += 1) ports.push(port);
  return ports;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Plannotator review was cancelled while it was starting.");
}

export function createPlannotatorHostEntry(deps: HostRuntimeDeps) {
  const reviews = new Map<string, HostReview>();
  const claims = new Map<string, StartClaim>();
  let dataDir: string | null = null;
  let startup: Promise<ReconcileResult> | null = null;
  let reconciling: Promise<unknown> = Promise.resolve();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let ownedWrites: Promise<unknown> = Promise.resolve();

  function liveResources(): { pids: Set<number>; ports: Set<number> } {
    const pids = new Set<number>();
    const ports = new Set<number>();
    for (const { review, port } of reviews.values()) {
      if (review.pid !== undefined) pids.add(review.pid);
      ports.add(port);
    }
    for (const claim of claims.values()) {
      if (claim.pid !== undefined) pids.add(claim.pid);
      if (claim.port !== undefined) ports.add(claim.port);
    }
    return { pids, ports };
  }

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

  /** Whether `port` has a serve mapping of this plugin's shape; null if serve status failed. */
  async function hasOwnShape(tailscalePath: string, port: number): Promise<boolean | null> {
    try {
      return ownedServePorts(await readServeStatus(tailscalePath), HOST_PORT_RANGE).includes(port);
    } catch {
      return null;
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

  async function readOwned(directory: string): Promise<OwnedState> {
    try {
      return parseOwnedState(await readFile(join(directory, OWNED_FILE), "utf8"));
    } catch {
      return { processes: [], mappings: [] };
    }
  }

  function updateOwned(
    directory: string,
    update: (current: OwnedState) => OwnedState,
  ): Promise<void> {
    const next = ownedWrites.then(async () => {
      await mkdir(directory, { recursive: true });
      const updated = update(await readOwned(directory));
      await writeFile(join(directory, OWNED_FILE), JSON.stringify(updated), {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    ownedWrites = next.catch(() => undefined);
    return next;
  }

  /**
   * Remove what a dead worker or a failed cleanup left behind: recorded
   * Plannotator processes whose pid still has the recorded start time, and
   * recorded serve mappings that still have the exact shape this plugin
   * creates. Live and starting reviews are never touched.
   */
  async function reconcileOnce(directory: string): Promise<ReconcileResult> {
    const live = liveResources();
    const owned = await readOwned(directory);

    const handledPids = new Set<number>();
    const killedPids: number[] = [];
    for (const recorded of owned.processes) {
      if (live.pids.has(recorded.pid)) continue;
      handledPids.add(recorded.pid);
      if ((await processStart(recorded.pid)) !== recorded.started) continue;
      await terminate(recorded);
      killedPids.push(recorded.pid);
    }

    const handledPorts = new Set<number>();
    const removedPorts: number[] = [];
    const tailscalePath = resolveTailscale();
    if (tailscalePath) {
      const status = await readServeStatus(tailscalePath);
      const shaped = new Set(ownedServePorts(status, HOST_PORT_RANGE));
      for (const port of owned.mappings) {
        if (live.ports.has(port)) continue;
        // Gone, or now something else: either way it is no longer ours.
        if (!shaped.has(port)) {
          handledPorts.add(port);
          continue;
        }
        if (await removeMapping(tailscalePath, port)) {
          handledPorts.add(port);
          removedPorts.push(port);
        }
      }
    }

    await updateOwned(directory, (current) => ({
      processes: current.processes.filter((recorded) => !handledPids.has(recorded.pid)),
      mappings: current.mappings.filter((port) => !handledPorts.has(port)),
    }));
    return { removedPorts, killedPids };
  }

  function reconcile(directory: string): Promise<ReconcileResult> {
    const next = reconciling.then(() => reconcileOnce(directory));
    reconciling = next.catch(() => undefined);
    return next;
  }

  function ensureStartup(directory: string): Promise<ReconcileResult> {
    dataDir = directory;
    startup ??= reconcile(directory).catch((error: unknown) => {
      startup = null;
      throw error;
    });
    return startup;
  }

  function forgetMapping(port: number): Promise<void> {
    if (!dataDir) return Promise.resolve();
    return updateOwned(dataDir, (current) => ({
      ...current,
      mappings: current.mappings.filter((owned) => owned !== port),
    })).catch(() => undefined);
  }

  function unpublish(entry: HostReview): Promise<void> {
    entry.unpublished ??= (async () => {
      await entry.proxy.close().catch(() => undefined);
      // A mapping whose removal failed stays recorded for the next reconcile.
      if (await removeMapping(entry.tailscalePath, entry.port)) await forgetMapping(entry.port);
    })();
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
        await updateOwned(dataDir, (current) => ({
          ...current,
          processes: current.processes.filter((owned) => owned.pid !== entry.review.pid),
        })).catch(() => undefined);
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

  /** Listen on the first port in the range that is free locally and in serve. */
  async function listenProxy(
    tailscalePath: string,
    claim: StartClaim,
    options: ReviewProxyOptions,
  ): Promise<RunningReviewProxy> {
    const status = await readServeStatus(tailscalePath);
    for (const port of hostPorts()) {
      // A mapping this plugin did not create, or a stale one of its own, is
      // left alone; the review moves to the next port.
      if (servePortInUse(status, port) || liveResources().ports.has(port)) continue;
      claim.port = port;
      try {
        return await deps.startProxy(port, options);
      } catch (error) {
        claim.port = undefined;
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(
      `No free port in ${HOST_PORT_RANGE.first}-${HOST_PORT_RANGE.last} to publish the review with tailscale serve.`,
    );
  }

  async function startClaimed(
    input: {
      sessionId: string;
      cwd: string;
      origin: SessionOptions["origin"];
      session: SessionOptions["session"];
      frameAncestor?: string;
      bridgeHost?: BridgeHost;
      bridgeLabel?: string;
    },
    context: HostContext,
    claim: StartClaim,
  ): Promise<{ url: string; port: number }> {
    const directory = context.experimental_paths.dataDir;
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
    // Plannotator gets the file's real path, checked here on its own machine.
    const session =
      input.session.mode === "annotate"
        ? { ...input.session, path: await resolveAnnotateTarget(input.cwd, input.session.path) }
        : input.session;
    const binaryPath = deps.findExecutable("plannotator");
    if (!binaryPath) {
      throw new Error("plannotator is not on this machine's PATH for the bb host daemon.");
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    context.lifecycle.signal.addEventListener("abort", abort, { once: true });
    context.signal.addEventListener("abort", abort, { once: true });
    let review: RunningUpstreamReview | undefined;
    let proxy: RunningReviewProxy | undefined;
    /** serve ran: it may have published the mapping even when it failed or timed out. */
    let serveRan = false;
    // Generated here so it never leaves this machine; the server reaches the
    // bridge only through bridgeFetch.
    const bridgeToken = input.bridgeHost ? randomBytes(32).toString("base64url") : undefined;
    try {
      // A random loopback port: only the proxy below is published.
      review = await deps.startSession({
        binaryPath,
        session,
        sessionId: input.sessionId,
        ...(bridgeToken && input.bridgeHost ? { bridge: { token: bridgeToken, host: input.bridgeHost } } : {}),
        timeoutSeconds: null,
        signal: controller.signal,
        origin: input.origin,
        dataDir: join(directory, "plannotator"),
        remote: false,
        // The proxy forwards the browser's Host, this machine's MagicDNS name.
        allowedHost: dnsName,
        cwd: input.cwd,
      });
      void review.result.catch(() => undefined);
      const { pid } = review;
      claim.pid = pid;
      if (pid !== undefined) {
        const started = await processStart(pid);
        if (started) {
          await updateOwned(directory, (current) => ({
            ...current,
            processes: [...current.processes, { pid, started }],
          }));
        }
      }
      throwIfAborted(controller.signal);

      proxy = await listenProxy(tailscalePath, claim, {
        publicHostname: dnsName,
        upstreamPort: review.port,
        cwd: input.cwd,
        allowedRoots: [input.cwd, deps.uploadDir],
        ...(input.frameAncestor ? { frameAncestor: input.frameAncestor } : {}),
        ...(bridgeToken && input.bridgeLabel ? { sessionBridgeLabel: input.bridgeLabel } : {}),
      });
      const port = proxy.port;
      // Record before publishing, so a crash in between still gets cleaned up.
      await updateOwned(directory, (current) => ({
        ...current,
        mappings: [...current.mappings.filter((owned) => owned !== port), port],
      }));
      serveRan = true;
      const served = await deps.runCommand(tailscalePath, serveArgs(port), TAILSCALE_TIMEOUT_MS);
      if (served.exitCode !== 0) {
        throw new Error(`tailscale serve failed for port ${port}: ${commandDetail(served)}`);
      }
      // The server may have given up while serve ran.
      throwIfAborted(controller.signal);
    } catch (error) {
      context.lifecycle.signal.removeEventListener("abort", abort);
      context.signal.removeEventListener("abort", abort);
      await proxy?.close().catch(() => undefined);
      if (proxy) {
        const port = proxy.port;
        // Serve may have applied the mapping, or failed because another
        // program took the port: remove only a mapping of this plugin's shape.
        // One whose check or removal failed stays recorded for the next reconcile.
        const shaped = serveRan ? await hasOwnShape(tailscalePath, port) : false;
        if (shaped === false || (shaped && (await removeMapping(tailscalePath, port)))) await forgetMapping(port);
      }
      if (review) {
        const { pid } = review;
        await review.stop().catch(() => undefined);
        await updateOwned(directory, (current) => ({
          ...current,
          processes: current.processes.filter((owned) => owned.pid !== pid),
        })).catch(() => undefined);
      }
      throw error;
    }
    context.signal.removeEventListener("abort", abort);

    const entry: HostReview = {
      sessionId: input.sessionId,
      review,
      proxy,
      port: proxy.port,
      tailscalePath,
      ...(bridgeToken ? { bridgeToken } : {}),
      state: { status: "pending" },
      lease: context.experimental_retainWorker(),
      lastPolledAt: deps.now(),
    };
    reviews.set(entry.sessionId, entry);
    startWatchdog();
    void review.result.then(
      (decision) => settle(entry, { status: "decided", decision }, context),
      (error: unknown) => {
        const output = sessionErrorOutput(error);
        settle(entry, { status: "failed", error: errorMessage(error), ...(output ? { output } : {}) }, context);
      },
    );
    return { url: `https://${dnsName}:${entry.port}`, port: entry.port };
  }

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      async startReview(input, context) {
        await ensureStartup(context.experimental_paths.dataDir);
        if (reviews.has(input.sessionId) || claims.has(input.sessionId)) {
          throw new Error("This Plannotator review is already running.");
        }
        const claim: StartClaim = {};
        claims.set(input.sessionId, claim);
        try {
          return await startClaimed(input, context, claim);
        } finally {
          claims.delete(input.sessionId);
        }
      },

      // Every method reconciles a fresh worker first, so a worker that
      // replaced one killed with its daemon cleans up without a new review.
      async getReview({ sessionId }, context) {
        await ensureStartup(context.experimental_paths.dataDir).catch(() => undefined);
        const entry = reviews.get(sessionId);
        if (!entry) return { status: "unknown" as const };
        entry.lastPolledAt = deps.now();
        return entry.state;
      },

      async stopReview({ sessionId }, context) {
        await ensureStartup(context.experimental_paths.dataDir).catch(() => undefined);
        const entry = reviews.get(sessionId);
        if (!entry) return { stopped: false };
        await stopEntry(entry);
        return { stopped: true };
      },

      async probe() {
        const tailscalePath = resolveTailscale();
        if (!tailscalePath) {
          return { publishable: false, reason: `the tailscale CLI is not on PATH or at ${TAILSCALE_FALLBACK_PATH}` };
        }
        try {
          await readDnsName(tailscalePath);
        } catch (error) {
          return { publishable: false, reason: errorMessage(error).slice(0, 500) };
        }
        if (!deps.findExecutable("plannotator")) {
          return { publishable: false, reason: "plannotator is not on PATH for the bb host daemon" };
        }
        return { publishable: true };
      },

      async bridgeFetch({ sessionId, path, body, waitMs }, context) {
        await ensureStartup(context.experimental_paths.dataDir).catch(() => undefined);
        const entry = reviews.get(sessionId);
        if (!entry?.bridgeToken || entry.state.status !== "pending") {
          return { status: 404, body: JSON.stringify({ error: "No open session bridge." }) };
        }
        entry.lastPolledAt = deps.now();
        // No Origin header: upstream refuses bridge requests from a browser.
        const response = await deps.fetch(`http://127.0.0.1:${entry.review.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${entry.bridgeToken}` },
          body,
          signal: AbortSignal.any([context.signal, AbortSignal.timeout((waitMs ?? 0) + 10_000)]),
        });
        return { status: response.status, body: await response.text() };
      },

      async reconcile(_input, context) {
        const directory = context.experimental_paths.dataDir;
        const fresh = startup === null;
        const first = await ensureStartup(directory).catch(() => null);
        return fresh && first ? first : reconcile(directory);
      },
    },
    dispose: async () => {
      await Promise.allSettled([...reviews.values()].map(stopEntry));
    },
  });
}
