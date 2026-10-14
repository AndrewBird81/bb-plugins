// Server-side handle for a review running on another bb host. It presents the
// same shape as an in-process review so the server's lifecycle code is shared.
// Host signals are lossy, so the decision is also polled.
import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { RunningUpstreamReview, UpstreamDecision, UpstreamOrigin } from "./bridge";
import type { HostReviewState, hostContract, hostSignals } from "./host-contract";

export type PlannotatorHostClient = Pick<
  ExperimentalHostClient<typeof hostContract, typeof hostSignals>,
  "call"
>;

/** Starting Plannotator and publishing it can take longer than the 30 s default. */
export const HOST_START_TIMEOUT_MS = 60_000;
export const HOST_POLL_INTERVAL_MS = 5_000;
const HOST_CALL_TIMEOUT_MS = 15_000;
/** Consecutive failed polls before the host counts as disconnected. */
export const HOST_POLL_FAILURE_LIMIT = 3;

export type HostPlanReview = RunningUpstreamReview & {
  hostId: string;
  sessionId: string;
  /** Poll now, for example after a host signal. */
  refresh(): void;
  /** The host worker crashed, so the review cannot finish. */
  workerExited(): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function startHostPlanReview(options: {
  client: PlannotatorHostClient;
  hostId: string;
  sessionId: string;
  planMarkdown: string;
  cwd: string;
  origin: UpstreamOrigin;
  signal: AbortSignal;
  pollIntervalMs?: number;
  /** The host could not be told to stop, for example because it is offline. */
  onStopFailed?: () => void;
}): Promise<HostPlanReview> {
  const { client, hostId, sessionId } = options;
  const pollIntervalMs = options.pollIntervalMs ?? HOST_POLL_INTERVAL_MS;
  const started = await client.call(
    "startReview",
    {
      sessionId,
      planMarkdown: options.planMarkdown,
      cwd: options.cwd,
      origin: options.origin,
    },
    { hostId, signal: options.signal, timeoutMs: HOST_START_TIMEOUT_MS },
  );

  let settled = false;
  let resolveResult!: (decision: UpstreamDecision) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<UpstreamDecision>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let pollAgain = false;
  let failures = 0;

  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectResult(new Error(message));
  };

  const apply = (state: HostReviewState) => {
    if (settled || state.status === "pending") return;
    if (state.status === "decided") {
      settled = true;
      clearTimeout(timer);
      resolveResult(state.decision);
    } else if (state.status === "failed") {
      fail(state.error);
    } else {
      fail("The Plannotator worker on the thread's machine restarted, so the review ended.");
    }
  };

  const schedule = () => {
    if (!settled) timer = setTimeout(() => void poll(), pollIntervalMs);
  };

  async function poll(): Promise<void> {
    if (settled) return;
    if (polling) {
      pollAgain = true;
      return;
    }
    polling = true;
    clearTimeout(timer);
    try {
      apply(
        await client.call("getReview", { sessionId }, { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS }),
      );
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= HOST_POLL_FAILURE_LIMIT) {
        fail(`Lost contact with the thread's machine during the review: ${errorMessage(error)}`);
      }
    } finally {
      polling = false;
      if (pollAgain) {
        pollAgain = false;
        void poll();
      } else {
        schedule();
      }
    }
  }

  schedule();
  return {
    url: started.url,
    port: started.port,
    pid: undefined,
    hostId,
    sessionId,
    result,
    refresh: () => void poll(),
    workerExited: () => fail("The Plannotator worker on the thread's machine exited."),
    async stop() {
      fail("Plannotator review was cancelled");
      try {
        await client.call("stopReview", { sessionId }, { hostId, timeoutMs: HOST_CALL_TIMEOUT_MS });
      } catch {
        // The host may be offline. Its worker stops reviews nobody polls,
        // and the caller retries the cleanup when the host is back.
        options.onStopFailed?.();
      }
    },
  };
}
