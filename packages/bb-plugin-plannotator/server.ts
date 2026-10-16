// BB's Plannotator integration is intentionally a bridge, not a second
// review product. The released upstream binary owns the plan renderer,
// annotations, history, and feedback formatting. BB supplies the agent tool,
// embeds the upstream session, and delivers decisions in a later thread message.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BUNDLED_BINARY,
  DEFAULT_BINARY,
  ensureBundledPlannotatorBinary,
  fetchLatestUpstreamVersion,
  isSessionResult,
  missingBinaryMessage,
  REMOTE_PORT_RANGE,
  resolvePlannotatorBinary,
  startUpstreamSession,
  type RunningUpstreamReview,
  type UpstreamDecision,
  type UpstreamOrigin,
} from "./src/bridge";
import {
  PANEL_ACTION_ID,
  PLANNOTATOR_RELAY_PATH,
  PLANNOTATOR_REALTIME_CHANNEL,
} from "./src/constants";
import { isLocalBindHostname } from "./src/embedded";
import { runBridgeClient, type BridgeTransport } from "./src/bridge-client";
import { createForkAsker, summarizeExchanges, sweepForks, type ForkAsker } from "./src/fork-asker";
import { createRequestFilter } from "./src/request-filter";
import {
  MAX_ANNOTATE_MARKDOWN,
  diffTypeSchema,
  gitRefSchema,
  hostContract,
  hostSignals,
  type BridgeHost,
  type SessionRequest,
  type SessionResult,
} from "./src/host-contract";
import { HOST_DISCONNECT_GRACE_MS, startHostSession, type HostSession } from "./src/host-review";
import { lastFinishedReply } from "./src/last-reply";
import { SESSION_KINDS, resolveAnnotateTarget, sessionErrorOutput, type SessionKind } from "./src/session";
import {
  registerPlannotatorRelayRoutes,
  type RelaySession,
} from "./src/relay";

const titleSchema = z.string().trim().min(1).max(200);
const reviewToolParametersSchema = z
  .object({
    planMarkdown: z.string().trim().min(1).max(1_000_000),
    title: titleSchema.optional(),
    previousPlanMarkdown: z.string().max(1_000_000).optional(),
  })
  .strict();
const reviewChangesParametersSchema = z
  .object({ diffType: diffTypeSchema.optional(), base: gitRefSchema.optional(), title: titleSchema.optional() })
  .strict();
const annotatePathSchema = z.string().trim().min(1).max(4096);
const annotateFileParametersSchema = z
  .object({ path: annotatePathSchema, title: titleSchema.optional() })
  .strict();
const annotateMarkdownSchema = z.string().min(1).max(MAX_ANNOTATE_MARKDOWN);
const annotateReplyParametersSchema = z
  .object({ markdown: annotateMarkdownSchema.optional(), title: titleSchema.optional() })
  .strict();

/** What the bb panel can start; plan review is agent-only. */
const userSessionRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("review"), diffType: diffTypeSchema.optional(), base: gitRefSchema.optional() }).strict(),
  z.object({ mode: z.literal("annotate"), path: annotatePathSchema }).strict(),
  z.object({ mode: z.literal("annotate-last"), markdown: annotateMarkdownSchema.optional() }).strict(),
]);

/** A session request before the server resolves paths and text. */
type SessionInput =
  | { mode: "plan"; planMarkdown: string }
  | z.infer<typeof userSessionRequestSchema>;

const sessionKindSchema = z.enum(["plan", "code-review", "annotate", "annotate-reply"]);
const sessionInitiatorSchema = z.enum(["agent", "user"]);
type SessionInitiator = z.infer<typeof sessionInitiatorSchema>;

const interactionPayloadSchema = z
  .object({
    kind: z.literal("plannotator"),
    sessionId: z.string().min(1),
    threadId: z.string().min(1),
    sessionUrl: z.string().url(),
    relayPath: z.literal(PLANNOTATOR_RELAY_PATH),
    title: z.string().min(1),
    sessionKind: sessionKindSchema.optional(),
    /** Latest upstream release, so the panel can pre-dismiss its update toast. */
    dismissUpdateVersion: z.string().min(1).max(64).optional(),
  })
  .strict();
type ReviewPanelPayload = z.infer<typeof interactionPayloadSchema>;

export const rpcContract = defineRpcContract({
  /** A health check for the right-panel shell and plugin tests. */
  status: {
    // `bb plugin rpc call plannotator status` sends null without --input-file.
    input: z.object({}).strict().nullable(),
    output: z
      .object({
        binary: z.string().nullable(),
        configuredPath: z.string(),
      })
      .strict(),
  },
  getActiveReview: {
    input: z
      .object({
        threadId: z.string().min(1),
      })
      .strict(),
    output: interactionPayloadSchema.nullable(),
  },
  cancelReview: {
    input: z
      .object({
        threadId: z.string().min(1),
        sessionId: z.string().min(1),
      })
      .strict(),
    output: z.object({ cancelled: z.boolean() }).strict(),
  },
  /** Start a code review or annotation from the bb panel. */
  startSession: {
    input: z.object({ threadId: z.string().min(1), request: userSessionRequestSchema }).strict(),
    output: z
      .object({
        status: z.enum(["pending", "already_active", "error"]),
        reviewId: z.string().optional(),
        error: z.string().optional(),
      })
      .strict(),
  },
});

type ActiveReview = {
  sessionId: string;
  kind: SessionKind;
  initiator: SessionInitiator;
  payload: ReviewPanelPayload;
  review: RunningUpstreamReview | HostSession;
  controller: AbortController;
  cancelledByUser: boolean;
  /** The thread was deleted or archived: deliver no decision. */
  discarded: boolean;
  settled?: Promise<void>;
  /** Ask AI answered by the thread's agent: the bridge client and its forks. */
  askAi?: { controller: AbortController; asker: ForkAsker };
  /** Annotate reply: how the annotated reply starts. */
  annotatedReply?: string;
};

const reviewResultSchema = z.object({
  reviewId: z.string().uuid(),
  source: z.literal("plannotator"),
  kind: sessionKindSchema.optional(),
  decision: z.enum(["approved", "changes_requested", "annotated", "dismissed", "cancelled"]),
  feedback: z.string().optional(),
  savedPath: z.string().optional(),
  agentSwitch: z.string().optional(),
  error: z.string().optional(),
  /** Review and annotate: the agent-facing text upstream composed. */
  message: z.string().optional(),
  target: z.union([z.string(), z.array(z.string())]).optional(),
  annotationCount: z.number().int().optional(),
  /** Review and annotate: nothing for the agent (bare approval or close). */
  noop: z.boolean().optional(),
  /** What Plannotator printed when its result could not be read. */
  printedOutput: z.string().max(8_000).optional(),
  /** Ask AI questions and answers during the session, for the agent. */
  askAiSummary: z.string().max(8_000).optional(),
  /** Annotate reply: how the annotated reply starts, so the agent knows which. */
  annotatedReply: z.string().max(200).optional(),
});
type ReviewResult = z.infer<typeof reviewResultSchema>;

const storedReviewSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().min(1),
  /** Records from 0.4 and earlier are plan reviews started by an agent. */
  kind: sessionKindSchema.default("plan"),
  initiator: sessionInitiatorSchema.default("agent"),
  /** Set when the review runs on another bb host. */
  hostId: z.string().min(1).optional(),
  /** `closed`: finished without a thread message (user-initiated, nothing to say). */
  status: z.enum(["pending", "ready", "delivered", "closed"]),
  result: reviewResultSchema.optional(),
  updatedAt: z.number(),
});
type StoredReview = z.infer<typeof storedReviewSchema>;
const REVIEW_KEY_PREFIX = "review:";
const DELIVERED_REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERY_RETRY_MS = 30_000;
const LATEST_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
/** How long the thread's machine has to say whether it can publish a review. */
const PROBE_TIMEOUT_MS = 15_000;
/** A failed release lookup is retried soon, so one timeout does not show the toast for hours. */
const LATEST_VERSION_FAILURE_TTL_MS = 5 * 60 * 1000;
const HOST_CLEANUP_KEY_PREFIX = "host-cleanup:";
/** A host that stays unreachable this long is assumed gone. */
const HOST_CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const hostCleanupSchema = z
  .object({ hostId: z.string().min(1), sessionId: z.string().uuid(), queuedAt: z.number() })
  .strict();
type HostCleanup = z.infer<typeof hostCleanupSchema>;

/**
 * Map BB's provider ids to the identities the upstream UI knows how to name.
 * The child must not infer this from ambient OPENCODE/CODEX_* environment
 * variables: BB owns the review session and its follow-up message.
 */
export function upstreamOriginForProvider(
  providerId: string | null | undefined,
): UpstreamOrigin {
  const normalized = providerId?.trim().toLowerCase() ?? "";
  if (normalized === "opencode" || normalized.includes("open-code")) {
    return "opencode";
  }
  if (normalized === "claude" || normalized.includes("claude-code")) {
    return "claude-code";
  }
  if (normalized === "copilot" || normalized.includes("copilot-cli")) {
    return "copilot-cli";
  }
  if (normalized === "gemini" || normalized.includes("gemini-cli")) {
    return "gemini-cli";
  }
  if (
    normalized === "pi" ||
    normalized === "omp" ||
    normalized.includes("oh-my-pi")
  ) {
    return "pi";
  }
  return "codex";
}

/** Where a thread's review runs: in the server process, or on its own host. */
export type ReviewTarget =
  | { kind: "server"; cwd?: string }
  | { kind: "host"; hostId: string; cwd: string };

/**
 * A thread on the server machine keeps the in-process runtime, in its
 * worktree when that path exists here. Any other machine runs Plannotator
 * through this plugin's host entry, which needs the worktree path.
 */
export function reviewTargetFor(
  environment: { hostId: string; path: string | null },
  primaryHostId: string | null,
  pathExists: (path: string) => boolean = existsSync,
): ReviewTarget {
  if (!primaryHostId || environment.hostId === primaryHostId) {
    return environment.path && pathExists(environment.path)
      ? { kind: "server", cwd: environment.path }
      : { kind: "server" };
  }
  if (!environment.path) {
    throw new Error("The thread's environment has no workspace path on its machine.");
  }
  return { kind: "host", hostId: environment.hostId, cwd: environment.path };
}

/** Where reviews run, from the "Run reviews on" setting. */
export type RunReviewsOn = "auto" | "thread" | "server";
export type ReviewPlacement = { runsOn: "thread-host" | "server"; reason: string };
type ProbeResult = { publishable: boolean; reason?: string };

/**
 * Pick where a thread's session runs. `auto` uses the thread's own machine
 * when it can publish the review with tailscale serve, and otherwise the BB
 * server (Plannotator's original behaviour, which cannot see a worktree on
 * another machine). `thread` always uses the thread's machine and fails if it
 * cannot publish; `server` always uses the BB server.
 */
export async function placeReview(
  target: ReviewTarget,
  runOn: RunReviewsOn,
  probe: () => Promise<ProbeResult>,
  pathExists: (path: string) => boolean = existsSync,
): Promise<{ target: ReviewTarget; placement: ReviewPlacement }> {
  if (target.kind === "server") {
    return { target, placement: { runsOn: "server", reason: "the thread runs on the BB server machine" } };
  }
  const onServer: ReviewTarget = pathExists(target.cwd) ? { kind: "server", cwd: target.cwd } : { kind: "server" };
  if (runOn === "server") {
    return { target: onServer, placement: { runsOn: "server", reason: 'the "Run reviews on" setting is server' } };
  }
  if (runOn === "thread") {
    return { target, placement: { runsOn: "thread-host", reason: 'the "Run reviews on" setting is thread' } };
  }
  let probed: ProbeResult;
  try {
    probed = await probe();
  } catch (error) {
    probed = { publishable: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (probed.publishable) {
    return {
      target,
      placement: { runsOn: "thread-host", reason: "the thread's machine can publish the review with tailscale serve" },
    };
  }
  return {
    target: onServer,
    placement: {
      runsOn: "server",
      reason: `the thread's machine cannot publish the review (${probed.reason ?? "unknown reason"}), so it runs on the BB server, which cannot read files in the thread's worktree`,
    },
  };
}

async function resolveReviewContext(
  bb: BbPluginApi,
  threadId: string,
  signal: AbortSignal,
): Promise<{ origin: UpstreamOrigin; providerId: string | null; environmentId?: string; target: ReviewTarget }> {
  let thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;
  try {
    thread = await bb.sdk.threads.get({ threadId, signal });
  } catch {
    // Without thread metadata, keep the original in-process behavior. The
    // provider identity is presentation-only.
    return { origin: "codex", providerId: null, target: { kind: "server" } };
  }
  const origin = upstreamOriginForProvider(thread.providerId);
  if (!thread.environmentId) return { origin, providerId: thread.providerId, target: { kind: "server" } };
  const [environment, systemConfig] = await Promise.all([
    bb.sdk.environments.get({ environmentId: thread.environmentId, signal }),
    bb.sdk.system.config({ signal }),
  ]);
  return {
    origin,
    providerId: thread.providerId,
    environmentId: thread.environmentId,
    target: reviewTargetFor(environment, systemConfig.primaryHostId),
  };
}

/** Who answers the session's Ask AI questions, and why. */
export type AskAiPlacement = { answersFrom: "thread" | "local"; reason: string };

/**
 * `thread` mode needs a fork of the thread, so the thread's provider must be
 * able to fork. A provider that can't, or one this plugin can't look up,
 * keeps Plannotator's local AI tools: with the bridge on, Ask AI offers only
 * the bridge, and every question would fail.
 */
export async function placeAskAi(
  providers: Pick<BbPluginApi["sdk"]["providers"], "list">,
  source: string,
  thread: { providerId: string | null; environmentId?: string },
  signal: AbortSignal,
): Promise<AskAiPlacement> {
  if (source !== "thread") {
    return { answersFrom: "local", reason: 'the "Ask AI answers from" setting is local' };
  }
  const local = (why: string): AskAiPlacement => ({
    answersFrom: "local",
    reason: `${why}, so Ask AI uses the AI tools on the machine where Plannotator runs`,
  });
  if (!thread.providerId) return local("the thread's provider is unknown");
  let canFork: boolean;
  try {
    const list = await providers.list(
      thread.environmentId ? { environmentId: thread.environmentId, signal } : { signal },
    );
    canFork = list.some((provider) => provider.id === thread.providerId && provider.capabilities.supportsFork);
  } catch (error) {
    return local(`could not check whether the thread's provider can fork (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!canFork) return local(`the thread's provider (${thread.providerId}) cannot fork`);
  return { answersFrom: "thread", reason: "the thread's agent answers in a hidden fork" };
}

/**
 * The bridge host value for a thread's provider. It drives upstream's Ask AI
 * label; there is no `bb` or `codex` value, and `opencode` advertises nothing.
 */
export function bridgeHostForProvider(providerId: string | null | undefined): BridgeHost {
  const normalized = providerId?.trim().toLowerCase() ?? "";
  if (normalized === "claude" || normalized.includes("claude-code")) return "claude-code";
  if (normalized === "pi" || normalized === "omp" || normalized.includes("oh-my-pi")) return "pi";
  return "opencode";
}

/** The thread's latest event sequence, where Ask AI forks are pinned. */
async function latestThreadSequence(bb: BbPluginApi, threadId: string): Promise<number | undefined> {
  try {
    const rows = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
    return rows[0]?.seq;
  } catch {
    return undefined;
  }
}

function isHostReview(review: ActiveReview["review"]): review is HostSession {
  return "hostId" in review;
}

export function shouldUseRemotePlannotatorMode(
  serverUrl: string | undefined,
  env: Partial<Pick<NodeJS.ProcessEnv, "BB_APP_URL" | "BB_SERVER_BIND_HOST">> = process.env,
): boolean {
  const configuredUrl = env.BB_APP_URL?.trim() || serverUrl?.trim();
  if (configuredUrl) {
    try {
      if (!isLocalBindHostname(new URL(configuredUrl).hostname)) return true;
    } catch {
      // Fall through to the explicit bind-host signal below.
    }
  }
  return env.BB_SERVER_BIND_HOST?.trim() === "0.0.0.0";
}

async function resolveUpstreamRuntimeConfig(
  bb: BbPluginApi,
  signal: AbortSignal,
): Promise<{ dataDir?: string; remote: boolean }> {
  try {
    const systemConfig = await bb.sdk.system.config({ signal });
    return {
      dataDir: join(systemConfig.dataDir, "plugins", bb.pluginId, "plannotator"),
      remote: shouldUseRemotePlannotatorMode(systemConfig.serverUrl),
    };
  } catch {
    // External runtimes remain usable if an older host does not expose the
    // system data directory. The bundled runtime already needs this lookup.
    return {
      remote: shouldUseRemotePlannotatorMode(undefined),
    };
  }
}

/** The origin browsers load bb from, which host reviews allow as their frame parent. */
export function bbPageOrigin(appUrl: string | null, serverUrl: string | undefined): string | undefined {
  for (const candidate of [appUrl, serverUrl]) {
    if (!candidate?.trim()) continue;
    try {
      const url = new URL(candidate.trim());
      // A loopback URL is not where other devices load bb from.
      if ((url.protocol === "https:" || url.protocol === "http:") && !isLocalBindHostname(url.hostname)) {
        return url.origin;
      }
    } catch {
      // Try the next source.
    }
  }
  return undefined;
}

function resolveEmbedHost(bb: BbPluginApi): string | undefined {
  try {
    return new URL(bb.server.loopbackBaseUrl).hostname;
  } catch {
    return undefined;
  }
}

function panelSessionId(paramsJson: string | null): string | null {
  if (!paramsJson) return null;
  try {
    const value = JSON.parse(paramsJson) as unknown;
    return isRecord(value) && typeof value.sessionId === "string"
      ? value.sessionId
      : null;
  } catch {
    return null;
  }
}

/**
 * Remove tabs that 0.5.1 and earlier opened for this review. Those versions
 * persisted a tab per review; a thread now has one param-less Plannotator tab,
 * which the browser opens, so new reviews leave nothing here to remove.
 */
async function closeReviewPanel(
  bb: BbPluginApi,
  threadId: string,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const current = await bb.sdk.threads.tabs.get({ threadId });
      const remaining = current.tabs.filter((tab) => {
        if (tab.kind !== "plugin-panel") return true;
        return !(
          tab.pluginId === bb.pluginId &&
          tab.actionId === PANEL_ACTION_ID &&
          panelSessionId(tab.paramsJson) === sessionId
        );
      });
      if (remaining.length === current.tabs.length) return;

      await bb.sdk.threads.tabs.update({
        threadId,
        expectedRevision: current.revision,
        tabs: remaining,
      });
      return;
    } catch (error) {
      if (attempt === 2) {
        bb.log.warn(
          `Could not close Plannotator tab for ${threadId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decisionLabel(decision: UpstreamDecision): "approved" | "changes_requested" | "cancelled" {
  if (decision.approved) return "approved";
  return decision.feedback?.trim() ? "changes_requested" : "cancelled";
}

/**
 * Upstream's feedback tells the agent to resubmit with its own plan tool,
 * such as ExitPlanMode. A bb agent resubmits with this plugin's tool.
 */
export function feedbackForBbAgent(feedback: string): string {
  return feedback.replace(
    /before calling \S+ again\./u,
    "before calling plannotator_review_plan again with the revised plan.",
  );
}

function reviewResult(reviewId: string, decision: UpstreamDecision): ReviewResult {
  return {
    reviewId,
    source: "plannotator",
    kind: "plan",
    decision: decisionLabel(decision),
    ...(decision.feedback ? { feedback: feedbackForBbAgent(decision.feedback) } : {}),
    ...(decision.savedPath ? { savedPath: decision.savedPath } : {}),
    ...(decision.agentSwitch ? { agentSwitch: decision.agentSwitch } : {}),
  };
}

function sessionReviewResult(reviewId: string, kind: SessionKind, result: SessionResult): ReviewResult {
  return {
    reviewId,
    source: "plannotator",
    kind,
    decision: result.decision,
    noop: result.noop,
    ...(result.message.trim() ? { message: result.message } : {}),
    ...(result.target !== undefined ? { target: result.target } : {}),
    ...(result.annotationCount !== undefined ? { annotationCount: result.annotationCount } : {}),
  };
}

/** The agent tool each kind answers. */
export const TOOL_FOR_KIND: Record<SessionKind, string> = {
  plan: "plannotator_review_plan",
  "code-review": "plannotator_review_changes",
  annotate: "plannotator_annotate_file",
  "annotate-reply": "plannotator_annotate_reply",
};
const KIND_NOUN: Record<SessionKind, string> = {
  plan: "review",
  "code-review": "code review",
  annotate: "annotation",
  "annotate-reply": "annotation",
};

/** The first line of an annotated reply, short enough to quote. */
export function replyExcerpt(markdown: string): string {
  const line = markdown.split(/\r?\n/u).map((text) => text.replace(/^[#>*\-\s]+/u, "").trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function closingSentence(kind: SessionKind, initiator: SessionInitiator, annotatedReply?: string): string {
  if (kind === "plan") {
    return "This answers the earlier plannotator_review_plan call. Continue the original task if approved; revise the plan if changes were requested. Cancellation is not approval. Do not repeat this review unless asked.";
  }
  const subject = {
    "code-review": "the worktree changes",
    annotate: "the annotated file",
    "annotate-reply": annotatedReply ? `your earlier reply that starts "${annotatedReply}"` : "your earlier reply",
  }[kind];
  const opening =
    initiator === "agent"
      ? `This answers the earlier ${TOOL_FOR_KIND[kind]} call.`
      : `The user opened this Plannotator ${KIND_NOUN[kind]} from the bb panel.`;
  return `${opening} Treat any annotations above as the user's feedback on ${subject}. Approval or dismissal with no annotations means no changes were requested; cancellation is not approval. Do not repeat this ${KIND_NOUN[kind]} unless asked.`;
}

export function reviewMessage(
  result: ReviewResult,
  kind: SessionKind = "plan",
  initiator: SessionInitiator = "agent",
): string {
  const { message, noop: _noop, printedOutput, askAiSummary, ...summary } = result;
  return [
    `Plannotator ${KIND_NOUN[kind]} ${result.reviewId} has finished.`,
    JSON.stringify(summary),
    ...(message ? [message] : []),
    ...(printedOutput ? [`What Plannotator printed:\n\n${printedOutput}`] : []),
    ...(askAiSummary ? [askAiSummary] : []),
    closingSentence(kind, initiator, result.annotatedReply),
  ].join("\n\n");
}

/**
 * User-initiated sessions message the thread only when there is feedback, or
 * when feedback may have been lost (Plannotator printed something but BB
 * could not read its result).
 */
function shouldDeliver(initiator: SessionInitiator, result: ReviewResult): boolean {
  return initiator === "agent" || result.noop === false || result.printedOutput !== undefined;
}

const DEFAULT_TITLES: Record<SessionKind, string> = {
  plan: "Plannotator review",
  "code-review": "Code review",
  annotate: "Annotate file",
  "annotate-reply": "Annotate reply",
};

function errorResponse(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ decision: "cancelled", source: "plannotator", error: message }) }],
    isError: true,
  };
}

// A refusal is not a review outcome. Report it with a distinct status so an
// agent cannot mistake it for the user cancelling the pending review.
function alreadyActiveResponse(reviewId: string | undefined) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        status: "already_active",
        source: "plannotator",
        ...(reviewId ? { reviewId } : {}),
        error: "A Plannotator session is already open in this thread. No new session was started.",
        message: "Ask the user to finish or cancel the open session. They can reopen it from the Plannotator thread panel action. Its result will arrive as a new message in this thread.",
      }),
    }],
    isError: true,
  };
}

type StartOutcome =
  | { status: "pending"; reviewId: string; kind: SessionKind; placement?: ReviewPlacement; askAi?: AskAiPlacement }
  | { status: "already_active"; reviewId?: string }
  | { status: "error"; error: string };

function toolResponse(outcome: StartOutcome) {
  if (outcome.status === "already_active") return alreadyActiveResponse(outcome.reviewId);
  if (outcome.status === "error") return errorResponse(outcome.error);
  return JSON.stringify({
    status: "pending",
    reviewId: outcome.reviewId,
    kind: outcome.kind,
    source: "plannotator",
    ...(outcome.placement ? { runsOn: outcome.placement.runsOn, runsOnReason: outcome.placement.reason } : {}),
    ...(outcome.askAi ? { askAiAnswersFrom: outcome.askAi.answersFrom, askAiReason: outcome.askAi.reason } : {}),
    message: `End this turn. The ${KIND_NOUN[outcome.kind]} result will arrive as a new message in this thread.`,
  });
}

async function getConfiguredPath(settings: { get(): Promise<{ binaryPath: string }> }): Promise<string> {
  const configured = await settings.get();
  return configured.binaryPath.trim() || BUNDLED_BINARY;
}

async function resolveRuntimeBinary(
  bb: BbPluginApi,
  configuredPath: string,
  signal: AbortSignal,
): Promise<string> {
  const environmentOverride = process.env.PLANNOTATOR_BIN?.trim();
  if (environmentOverride) {
    const external = resolvePlannotatorBinary(environmentOverride);
    if (!external) throw new Error(missingBinaryMessage(environmentOverride));
    return external;
  }

  // Preserve compatibility with the first adapter release, where the
  // default was the standalone `plannotator` command. Explicit paths remain
  // strict; only the old command name falls back to the bundled runtime.
  if (configuredPath !== BUNDLED_BINARY) {
    const external = resolvePlannotatorBinary(configuredPath, {
      ...process.env,
      PLANNOTATOR_BIN: "",
    });
    if (external) return external;
    if (configuredPath !== DEFAULT_BINARY && configuredPath !== "auto") {
      throw new Error(missingBinaryMessage(configuredPath));
    }
  }

  const systemConfig = await bb.sdk.system.config({ signal });
  try {
    return await ensureBundledPlannotatorBinary({
      runtimeDir: join(systemConfig.dataDir, "plugins", bb.pluginId, "runtime"),
      signal,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${missingBinaryMessage(BUNDLED_BINARY)} ${detail}`, {
      cause: error,
    });
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    binaryPath: {
      type: "string",
      label: "Plannotator binary",
      description:
        `Use the bundled official runtime by default, or enter a path/command to override it. Set to \"${BUNDLED_BINARY}\" to restore the default.`,
      default: BUNDLED_BINARY,
    },
    askAiSource: {
      type: "select",
      label: "Ask AI answers from",
      description:
        "thread: Plannotator's Ask AI is answered by the thread's own agent, in a hidden fork that knows the conversation (if the thread's provider cannot fork, the session uses local). local: the AI tools installed on the thread's machine (Claude, Codex, Pi, OpenCode), which start without the conversation.",
      options: ["thread", "local"],
      default: "thread",
    },
    runReviewsOn: {
      type: "select",
      label: "Run reviews on",
      description:
        "auto: the thread's own machine when it is not the BB server and can publish the review with tailscale serve, otherwise the BB server. thread: always the thread's machine (an error if it cannot publish). server: always the BB server, which cannot read files in a worktree on another machine.",
      options: ["auto", "thread", "server"],
      default: "auto",
    },
  });

  const hostClient = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });
  const activeHostReviews = (hostId: string) =>
    [...activeReviews.values()]
      .map(({ review }) => review)
      .filter((review): review is HostSession => isHostReview(review) && review.hostId === hostId);
  hostClient.experimental_onSignal("reviewChanged", ({ hostId, payload }) => {
    for (const review of activeHostReviews(hostId)) {
      if (review.sessionId === payload.sessionId) review.refresh();
    }
  });
  hostClient.experimental_onWorkerExit(({ hostId }) => {
    for (const review of activeHostReviews(hostId)) review.workerExited();
    // The next call starts a fresh worker, which removes what the dead one left.
    void hostClient.call("reconcile", {}, { hostId }).catch((error: unknown) => {
      bb.log.warn(`Could not reconcile Plannotator on ${hostId}: ${String(error)}`);
    });
  });

  // Host reviews that may have left a process or serve mapping behind. Kept in
  // KV so a plugin or server restart does not lose them, and retried until the
  // host answers: stop the review if its worker survived, then reconcile so
  // the worker removes what it recorded.
  const hostCleanupKey = (sessionId: string) => `${HOST_CLEANUP_KEY_PREFIX}${sessionId}`;
  async function runHostCleanup(cleanup: HostCleanup): Promise<void> {
    try {
      await hostClient.call("stopReview", { sessionId: cleanup.sessionId }, { hostId: cleanup.hostId });
      await hostClient.call("reconcile", {}, { hostId: cleanup.hostId });
      await bb.storage.kv.delete(hostCleanupKey(cleanup.sessionId));
    } catch {
      // Still unreachable; try again on the next delivery pass.
    }
  }
  function queueHostCleanup(hostId: string, sessionId: string): void {
    const cleanup: HostCleanup = { hostId, sessionId, queuedAt: Date.now() };
    void bb.storage.kv
      .set(hostCleanupKey(sessionId), cleanup)
      .then(() => runHostCleanup(cleanup))
      .catch((error: unknown) => {
        bb.log.warn(`Could not queue Plannotator cleanup on ${hostId}: ${String(error)}`);
      });
  }
  async function retryHostCleanups(): Promise<void> {
    for (const key of await bb.storage.kv.list(HOST_CLEANUP_KEY_PREFIX)) {
      const parsed = hostCleanupSchema.safeParse(await bb.storage.kv.get(key));
      if (!parsed.success || Date.now() - parsed.data.queuedAt > HOST_CLEANUP_RETENTION_MS) {
        await bb.storage.kv.delete(key);
        continue;
      }
      await runHostCleanup(parsed.data);
    }
  }

  let latestVersion: { value: string | null; fetchedAt: number } | null = null;
  async function latestUpstreamVersion(): Promise<string | undefined> {
    const ttl = latestVersion?.value ? LATEST_VERSION_TTL_MS : LATEST_VERSION_FAILURE_TTL_MS;
    if (!latestVersion || Date.now() - latestVersion.fetchedAt > ttl) {
      latestVersion = { value: await fetchLatestUpstreamVersion(), fetchedAt: Date.now() };
    }
    return latestVersion.value ?? undefined;
  }

  const activeReviews = new Map<string, ActiveReview>();
  const startingReviews = new Set<string>();
  const relaySessions = new Map<string, RelaySession>();
  const delivering = new Set<string>();
  let disposing = false;

  const reviewKey = (id: string) => `${REVIEW_KEY_PREFIX}${id}`;
  async function loadReview(id: string): Promise<StoredReview | null> {
    const parsed = storedReviewSchema.safeParse(await bb.storage.kv.get(reviewKey(id)));
    return parsed.success ? parsed.data : null;
  }

  async function deliverReview(record: StoredReview): Promise<void> {
    if (disposing || record.status !== "ready" || !record.result || delivering.has(record.id)) return;
    delivering.add(record.id);
    try {
      // A queued send waits for the current agent turn to finish. An idle
      // thread starts a new turn immediately. Both paths avoid a long tool call.
      await bb.sdk.threads.send({
        threadId: record.threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: reviewMessage(record.result, record.kind, record.initiator), mentions: [] }],
      });
      await bb.storage.kv.set(reviewKey(record.id), {
        ...record,
        status: "delivered",
        updatedAt: Date.now(),
      } satisfies StoredReview);
    } catch (error) {
      // An archived or deleted thread takes no message: stop retrying.
      const thread = await bb.sdk.threads.get({ threadId: record.threadId }).catch(() => null);
      if (thread && (thread.archivedAt !== null || thread.deletedAt !== null)) {
        await bb.storage.kv
          .set(reviewKey(record.id), { ...record, status: "closed", updatedAt: Date.now() } satisfies StoredReview)
          .catch(() => undefined);
      } else {
        bb.log.warn(`Could not deliver Plannotator review ${record.id}: ${String(error)}`);
      }
    } finally {
      delivering.delete(record.id);
    }
  }

  async function recoverReviews(): Promise<void> {
    for (const key of await bb.storage.kv.list(REVIEW_KEY_PREFIX)) {
      if (disposing) return;
      const parsed = storedReviewSchema.safeParse(await bb.storage.kv.get(key));
      if (!parsed.success) {
        bb.log.warn(`Ignoring invalid Plannotator review record ${key}`);
        continue;
      }
      let record = parsed.data;
      if (record.status === "delivered" || record.status === "closed") {
        if (Date.now() - record.updatedAt > DELIVERED_REVIEW_RETENTION_MS) {
          await bb.storage.kv.delete(key);
        }
        continue;
      }
      if (record.status === "pending") {
        if (activeReviews.get(record.threadId)?.sessionId === record.id) continue;
        if (record.hostId) queueHostCleanup(record.hostId, record.id);
        await closeReviewPanel(bb, record.threadId, record.id);
        record = {
          ...record,
          // The user closed nothing and asked nothing: no message for them.
          status: record.initiator === "user" ? "closed" : "ready",
          result: {
            reviewId: record.id,
            source: "plannotator",
            kind: record.kind,
            decision: "cancelled",
            error: "The review ended when the Plannotator plugin restarted.",
          },
          updatedAt: Date.now(),
        };
        await bb.storage.kv.set(key, record);
      }
      await deliverReview(record);
    }
  }

  bb.background.service("review-delivery", {
    async start(signal) {
      // Forks a crashed or replaced plugin left behind. No session is open yet.
      try {
        const swept = await sweepForks(bb.sdk.threads, bb.pluginId, (message) => bb.log.warn(message));
        if (swept > 0) bb.log.info(`Archived ${swept} Plannotator Ask AI fork(s) left from earlier sessions`);
      } catch (error) {
        bb.log.warn(`Could not sweep Plannotator Ask AI forks: ${String(error)}`);
      }
      while (!signal.aborted) {
        try {
          await recoverReviews();
          await retryHostCleanups();
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`Could not recover Plannotator reviews: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DELIVERY_RETRY_MS);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  async function settleReview(threadId: string, active: ActiveReview): Promise<void> {
    let result: ReviewResult;
    try {
      const decision = await active.review.result;
      result = isSessionResult(decision)
        ? sessionReviewResult(active.sessionId, active.kind, decision)
        : reviewResult(active.sessionId, decision);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const printedOutput = active.cancelledByUser ? undefined : sessionErrorOutput(error);
      result = {
        reviewId: active.sessionId,
        source: "plannotator",
        kind: active.kind,
        decision: "cancelled",
        ...(!active.cancelledByUser
          ? {
              error: printedOutput
                ? `${message} Feedback the user submitted may have been lost; what Plannotator printed follows.`
                : message,
            }
          : {}),
        ...(printedOutput ? { printedOutput } : {}),
      };
      // The user started this session and sees no thread message unless
      // feedback may be lost: tell the panel what happened.
      if (active.initiator === "user" && !active.cancelledByUser) {
        bb.realtime.publish(PLANNOTATOR_REALTIME_CHANNEL, {
          kind: "review-failed",
          threadId,
          sessionId: active.sessionId,
          message: printedOutput
            ? `${message} Your feedback may have been lost; what Plannotator printed was sent to the thread.`
            : `Plannotator ended without a result: ${message}`,
        });
      }
    }
    const askAiSummary = active.askAi
      ? summarizeExchanges(active.askAi.asker.exchanges(), KIND_NOUN[active.kind])
      : null;
    if (askAiSummary) result = { ...result, askAiSummary };
    if (active.annotatedReply) result = { ...result, annotatedReply: active.annotatedReply };
    // The session has its decision: free the thread now, so a new session can
    // start while this one's cleanup (stopping the process, the host's serve
    // mapping) and its message delivery are still running.
    if (activeReviews.get(threadId) === active) activeReviews.delete(threadId);
    void stopAskAi(active);
    relaySessions.delete(active.sessionId);
    // Open panels switch to the launcher.
    bb.realtime.publish(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-closed",
      threadId,
      sessionId: active.sessionId,
    });
    await closeReviewPanel(bb, threadId, active.sessionId);
    try {
      await active.review.stop();
    } catch (error) {
      bb.log.warn(`Could not stop Plannotator review ${active.sessionId}: ${String(error)}`);
    }
    if (disposing || active.discarded) return;
    const record: StoredReview = {
      id: active.sessionId,
      threadId,
      kind: active.kind,
      initiator: active.initiator,
      status: shouldDeliver(active.initiator, result) ? "ready" : "closed",
      result,
      updatedAt: Date.now(),
    };
    try {
      await bb.storage.kv.set(reviewKey(record.id), record);
    } catch (error) {
      bb.log.warn(`Could not save Plannotator decision ${record.id}: ${String(error)}`);
    }
    await deliverReview(record);
  }

  registerPlannotatorRelayRoutes(bb, relaySessions, () =>
    bbPageOrigin(bb.server.experimental_appUrl, undefined),
  );

  bb.rpc.register(rpcContract, {
    async status() {
      const configuredPath = await getConfiguredPath(settings);
      return {
        configuredPath,
        binary:
          configuredPath === BUNDLED_BINARY
            ? null
          : resolvePlannotatorBinary(configuredPath),
      };
    },
    async getActiveReview({ threadId }) {
      return activeReviews.get(threadId)?.payload ?? null;
    },
    async cancelReview({ threadId, sessionId }) {
      const active = activeReviews.get(threadId);
      if (!active || active.sessionId !== sessionId) {
        return { cancelled: false };
      }
      active.cancelledByUser = true;
      await active.review.stop();
      return { cancelled: true };
    },
    async startSession({ threadId, request }) {
      const outcome = await startSession(threadId, request, { initiator: "user" });
      if (outcome.status === "pending") return { status: "pending" as const, reviewId: outcome.reviewId };
      if (outcome.status === "already_active") {
        return { status: "already_active" as const, ...(outcome.reviewId ? { reviewId: outcome.reviewId } : {}) };
      }
      return { status: "error" as const, error: outcome.error };
    },
  });

  /** Resolve a request against the thread's worktree and machine. */
  async function resolveSessionRequest(
    threadId: string,
    input: SessionInput,
    target: ReviewTarget,
    signal: AbortSignal,
  ): Promise<SessionRequest> {
    if (input.mode === "plan" || input.mode === "annotate-last") {
      if (input.mode === "plan") return input;
      let markdown = input.markdown;
      if (markdown === undefined) {
        // Never the text of a turn still running: an agent calling the tool
        // mid-turn means its previous reply.
        const last = await lastFinishedReply(bb.sdk.threads, threadId, signal);
        if (!last.reply?.trim()) {
          throw new Error(
            last.running
              ? "The thread's agent is still working and has no finished reply yet. Try again when its turn ends."
              : "This thread has no assistant reply to annotate yet.",
          );
        }
        markdown = last.reply;
      }
      if (!markdown.trim()) throw new Error("This thread has no assistant reply to annotate yet.");
      if (markdown.length > MAX_ANNOTATE_MARKDOWN) {
        throw new Error("The reply is longer than Plannotator's 2 MiB annotation limit.");
      }
      return { mode: "annotate-last", markdown };
    }
    if (!target.cwd) {
      throw new Error("Code review and file annotation need the thread's worktree on its machine.");
    }
    if (input.mode === "review") return input;
    // On the server, check the file here. A host checks it again on its own
    // filesystem before Plannotator starts.
    const path =
      target.kind === "server"
        ? await resolveAnnotateTarget(target.cwd, input.path)
        : resolve(target.cwd, input.path);
    return { mode: "annotate", path };
  }

  /** Answer the session's Ask AI questions with the thread's agent. */
  function startAskAi(
    active: ActiveReview,
    threadId: string,
    transport: BridgeTransport,
    sourceSeqEnd: number | undefined,
    onHost: boolean,
  ): void {
    const controller = new AbortController();
    const asker = createForkAsker({
      threads: bb.sdk.threads,
      sourceThreadId: threadId,
      ...(sourceSeqEnd !== undefined ? { sourceSeqEnd } : {}),
      sessionId: active.sessionId,
      pluginId: bb.pluginId,
      log: (message) => bb.log.warn(message),
    });
    active.askAi = { controller, asker };
    void runBridgeClient({
      transport,
      answer: (question, signal) => asker.ask(question, signal),
      signal: controller.signal,
      // A host session survives a daemon disconnect this long; so must Ask AI.
      ...(onHost ? { giveUpAfterMs: HOST_DISCONNECT_GRACE_MS } : {}),
      log: (message) => bb.log.info(`${message} (session ${active.sessionId})`),
    }).catch((error: unknown) => {
      bb.log.warn(`Plannotator bridge for ${active.sessionId} failed: ${String(error)}`);
    });
  }

  /** Stop the bridge client and archive the session's forks. */
  async function stopAskAi(active: ActiveReview): Promise<void> {
    if (!active.askAi) return;
    active.askAi.controller.abort();
    await active.askAi.asker.dispose().catch((error: unknown) => {
      bb.log.warn(`Could not archive Plannotator forks of ${active.sessionId}: ${String(error)}`);
    });
  }

  /**
   * Start a session of any kind for a thread. One session is open per thread.
   * Agent tools and the bb panel share this path.
   */
  async function startSession(
    threadId: string,
    input: SessionInput,
    options: { initiator: SessionInitiator; title?: string; signal?: AbortSignal },
  ): Promise<StartOutcome> {
    if (activeReviews.has(threadId) || startingReviews.has(threadId)) {
      return { status: "already_active", reviewId: activeReviews.get(threadId)?.sessionId };
    }
    startingReviews.add(threadId);

    const kind = SESSION_KINDS[input.mode];
    const sessionId = randomUUID();
    const controller = new AbortController();
    const abortStartup = () => controller.abort();
    options.signal?.addEventListener("abort", abortStartup, { once: true });
    const dismissUpdateVersion = latestUpstreamVersion();
    let upstream: RunningUpstreamReview | HostSession;
    let hostId: string | undefined;
    let annotatedPath: string | undefined;
    let annotatedReply: string | undefined;
    let transport: BridgeTransport | undefined;
    let relaySession: RelaySession | undefined;
    let sourceSeqEnd: number | undefined;
    let placement: ReviewPlacement | undefined;
    let askAi: AskAiPlacement | undefined;
    try {
      const context = await resolveReviewContext(bb, threadId, controller.signal);
      const { origin, providerId } = context;
      const { runReviewsOn } = await settings.get();
      const runOn: RunReviewsOn = runReviewsOn === "thread" || runReviewsOn === "server" ? runReviewsOn : "auto";
      const placed = await placeReview(context.target, runOn, () =>
        context.target.kind === "host"
          ? hostClient.call("probe", {}, { hostId: context.target.hostId, signal: controller.signal, timeoutMs: PROBE_TIMEOUT_MS })
          : Promise.resolve({ publishable: false }),
      );
      const target = placed.target;
      placement = placed.placement;
      const session = await resolveSessionRequest(threadId, input, target, controller.signal);
      if (session.mode === "annotate") annotatedPath = session.path;
      if (session.mode === "annotate-last") annotatedReply = replyExcerpt(session.markdown);
      const { askAiSource } = await settings.get();
      askAi = await placeAskAi(bb.sdk.providers, askAiSource, context, controller.signal);
      if (askAi.answersFrom === "local" && askAiSource === "thread") bb.log.info(`Plannotator Ask AI is local: ${askAi.reason}`);
      const bridgeHost = askAi.answersFrom === "thread" ? bridgeHostForProvider(providerId) : undefined;
      if (bridgeHost) sourceSeqEnd = await latestThreadSequence(bb, threadId);
      if (target.kind === "host") {
        hostId = target.hostId;
        const systemConfig = await bb.sdk.system.config({ signal: controller.signal });
        const frameAncestor = bbPageOrigin(bb.server.experimental_appUrl, systemConfig.serverUrl);
        upstream = await startHostSession({
          client: hostClient,
          hostId: target.hostId,
          sessionId,
          session,
          cwd: target.cwd,
          origin,
          ...(frameAncestor ? { frameAncestor } : {}),
          ...(bridgeHost ? { bridgeHost } : {}),
          signal: controller.signal,
          onCleanupNeeded: () => queueHostCleanup(target.hostId, sessionId),
        });
        const hostTarget = target.hostId;
        // The worker adds the token it generated; it never leaves the host.
        if (bridgeHost) {
          transport = (path, body, { waitMs, signal }) =>
            hostClient.call(
              "bridgeFetch",
              { sessionId, path, body, ...(waitMs !== undefined ? { waitMs } : {}) },
              { hostId: hostTarget, signal, timeoutMs: (waitMs ?? 0) + 10_000 },
            );
        }
      } else {
        const configuredPath = await getConfiguredPath(settings);
        const binaryPath = await resolveRuntimeBinary(bb, configuredPath, controller.signal);
        const runtimeConfig = await resolveUpstreamRuntimeConfig(bb, controller.signal);
        const token = bridgeHost ? randomBytes(32).toString("base64url") : undefined;
        // Loopback only, as on a Mac: upstream turns the bridge off in remote
        // mode, and the relay is the only way in. Remote BB keeps its port range.
        upstream = await startUpstreamSession({
          binaryPath,
          session,
          sessionId,
          timeoutSeconds: null,
          signal: controller.signal,
          origin,
          dataDir: runtimeConfig.dataDir,
          remote: false,
          ...(runtimeConfig.remote ? { portRange: REMOTE_PORT_RANGE } : {}),
          disableSharing: runtimeConfig.remote,
          ...(token && bridgeHost ? { bridge: { token, host: bridgeHost } } : {}),
          embedHost: resolveEmbedHost(bb),
          cwd: target.cwd,
        });
        const cwd = target.cwd ?? process.cwd();
        relaySession = {
          url: upstream.url,
          filter: await createRequestFilter({ cwd, allowedRoots: [cwd, join(tmpdir(), "plannotator")] }),
        };
        if (token) {
          const base = `http://127.0.0.1:${upstream.port}`;
          // No Origin header: upstream refuses bridge requests from a browser.
          transport = async (path, body, { waitMs, signal }) => {
            const response = await fetch(`${base}${path}`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
              body,
              signal: AbortSignal.any([signal, AbortSignal.timeout((waitMs ?? 0) + 10_000)]),
            });
            return { status: response.status, body: await response.text() };
          };
        }
      }
    } catch (error) {
      options.signal?.removeEventListener("abort", abortStartup);
      startingReviews.delete(threadId);
      // An aborted or timed-out call may still have started and published
      // the review on the host.
      if (hostId) queueHostCleanup(hostId, sessionId);
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
    // The process can exit while the panel and stored review are opening.
    // Attach a rejection handler before any further awaits.
    void upstream.result.catch(() => undefined);

    const title =
      options.title?.trim() ||
      (annotatedPath ? `Annotate ${basename(annotatedPath)}` : DEFAULT_TITLES[kind]);
    const updateVersion = await dismissUpdateVersion;
    const payload = interactionPayloadSchema.parse({
      kind: "plannotator",
      sessionId,
      threadId,
      sessionUrl: upstream.url,
      relayPath: PLANNOTATOR_RELAY_PATH,
      title,
      sessionKind: kind,
      // RPC results are strict JSON: omit the field rather than send undefined.
      ...(updateVersion ? { dismissUpdateVersion: updateVersion } : {}),
    });
    // Host reviews are published on their own machine; only in-process
    // listeners go through BB's relay.
    if (relaySession) relaySessions.set(sessionId, relaySession);
    const active: ActiveReview = {
      sessionId, kind, initiator: options.initiator, payload, review: upstream, controller,
      cancelledByUser: false, discarded: false,
      ...(annotatedReply ? { annotatedReply } : {}),
    };
    activeReviews.set(threadId, active);
    startingReviews.delete(threadId);
    if (transport) startAskAi(active, threadId, transport, sourceSeqEnd, hostId !== undefined);

    try {
      if (options.signal?.aborted || active.discarded || controller.signal.aborted) {
        throw new Error("Plannotator review was cancelled before opening");
      }
      await bb.storage.kv.set(reviewKey(sessionId), {
        id: sessionId,
        threadId,
        kind,
        initiator: options.initiator,
        ...(isHostReview(upstream) ? { hostId: upstream.hostId } : {}),
        status: "pending",
        updatedAt: Date.now(),
      } satisfies StoredReview);
      bb.realtime.publish(PLANNOTATOR_REALTIME_CHANNEL, {
        kind: "review-opened",
        payload,
      });
      options.signal?.removeEventListener("abort", abortStartup);
      active.settled = settleReview(threadId, active).catch((error) => {
        bb.log.error(`Could not settle Plannotator review ${sessionId}: ${String(error)}`);
      });
      return { status: "pending", reviewId: sessionId, kind, ...(placement ? { placement } : {}), ...(askAi ? { askAi } : {}) };
    } catch (error) {
      options.signal?.removeEventListener("abort", abortStartup);
      activeReviews.delete(threadId);
      relaySessions.delete(sessionId);
      void stopAskAi(active);
      await Promise.allSettled([
        bb.storage.kv.delete(reviewKey(sessionId)),
        closeReviewPanel(bb, threadId, sessionId),
        upstream.stop(),
      ]);
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  bb.agents.registerTool({
    name: "plannotator_review_plan",
    description:
      "Optionally open the upstream Plannotator plan-review UI in BB. Return a review ID; the decision arrives in a later thread message.",
    instructions:
      "Use this optional tool only when the user explicitly asks for Plannotator or a plan review. Pass the complete Markdown plan. The tool returns a pending review ID promptly: end your turn and wait for the Plannotator decision in a new message on this thread. Do not poll or claim approval while the review is pending. On approval, continue the original task. On requested changes, revise the plan. Cancellation is not approval. Native Plan mode remains separate and provider-controlled.",
    presentation: {
      label: {
        pending: "Waiting for Plannotator",
        completed: "Plannotator review opened",
      },
    },
    parameters: reviewToolParametersSchema,
    async execute(params, context) {
      return toolResponse(
        await startSession(
          context.threadId,
          { mode: "plan", planMarkdown: params.planMarkdown },
          { initiator: "agent", title: params.title, signal: context.signal },
        ),
      );
    },
  });

  const sessionToolNote =
    "The tool returns a pending review ID promptly: end your turn and wait for the result in a new message on this thread. Do not poll. Only one Plannotator session can be open per thread.";

  bb.agents.registerTool({
    name: "plannotator_review_changes",
    description:
      "Optionally open Plannotator's code review of the thread's worktree changes in BB. The user's annotations arrive in a later thread message.",
    instructions: `Use this optional tool only when the user asks for Plannotator or a code review of the changes in Plannotator. By default it shows all changes since the default branch, including uncommitted and untracked files; pass diffType to choose another view (uncommitted, staged, unstaged, last-commit, branch, merge-base, all) and base for another git ref. ${sessionToolNote}`,
    presentation: { label: { pending: "Opening Plannotator code review", completed: "Plannotator code review opened" } },
    parameters: reviewChangesParametersSchema,
    async execute(params, context) {
      return toolResponse(
        await startSession(
          context.threadId,
          {
            mode: "review",
            ...(params.diffType ? { diffType: params.diffType } : {}),
            ...(params.base ? { base: params.base } : {}),
          },
          { initiator: "agent", title: params.title, signal: context.signal },
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "plannotator_annotate_file",
    description:
      "Optionally open a Markdown or HTML file from the thread's worktree in Plannotator for the user to annotate. The annotations arrive in a later thread message.",
    instructions: `Use this optional tool only when the user asks to annotate or review a document in Plannotator. Pass a .md, .markdown, .html or .htm path relative to the worktree (or absolute inside it). ${sessionToolNote}`,
    presentation: { label: { pending: "Opening Plannotator annotation", completed: "Plannotator annotation opened" } },
    parameters: annotateFileParametersSchema,
    async execute(params, context) {
      return toolResponse(
        await startSession(
          context.threadId,
          { mode: "annotate", path: params.path },
          { initiator: "agent", title: params.title, signal: context.signal },
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "plannotator_annotate_reply",
    description:
      "Optionally open an assistant reply in Plannotator for the user to annotate. The annotations arrive in a later thread message.",
    instructions: `Use this optional tool only when the user asks to annotate a reply in Plannotator. Without markdown it opens this thread's last finished assistant reply, never the text of a turn still running (so mid-turn it is your previous reply); pass markdown to annotate other text, including text from the current turn. ${sessionToolNote}`,
    presentation: { label: { pending: "Opening Plannotator annotation", completed: "Plannotator annotation opened" } },
    parameters: annotateReplyParametersSchema,
    async execute(params, context) {
      return toolResponse(
        await startSession(
          context.threadId,
          { mode: "annotate-last", ...(params.markdown ? { markdown: params.markdown } : {}) },
          { initiator: "agent", title: params.title, signal: context.signal },
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "plannotator_review_status",
    description: "Recover the status or result of a Plannotator session (plan review, code review or annotation) in this thread. Do not poll while a session is open.",
    parameters: z.object({ reviewId: z.string().uuid() }).strict(),
    async execute({ reviewId }, context) {
      const record = await loadReview(reviewId);
      if (!record || record.threadId !== context.threadId) {
        return JSON.stringify({ reviewId, status: "not_found" });
      }
      return JSON.stringify({
        reviewId,
        kind: record.kind,
        status: record.status,
        ...(record.result ? { result: record.result } : {}),
      });
    },
  });

  bb.agents.configure(() => ({
    tools: [
      "plannotator_review_plan",
      "plannotator_review_changes",
      "plannotator_annotate_file",
      "plannotator_annotate_reply",
      "plannotator_review_status",
    ],
    skills: [],
  }));

  /** Stop a thread's pending review without delivering a decision. */
  async function discardActiveReview(threadId: string): Promise<ActiveReview | null> {
    const active = activeReviews.get(threadId);
    if (!active) return null;
    // Remove the lookup before asynchronous cleanup starts. A discarded
    // review must not be eligible for panel reconciliation while the
    // upstream process is winding down.
    activeReviews.delete(threadId);
    active.discarded = true;
    active.controller.abort();
    // Open panels switch to the launcher now rather than showing a dead session.
    bb.realtime.publish(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-closed",
      threadId,
      sessionId: active.sessionId,
    });
    await Promise.allSettled([
      closeReviewPanel(bb, threadId, active.sessionId),
      active.review.stop(),
      stopAskAi(active),
    ]);
    relaySessions.delete(active.sessionId);
    return active;
  }

  // An archived thread's review would otherwise keep its process and serve
  // mapping until someone cancels it. Record the cancellation for
  // plannotator_review_status without messaging the archived thread.
  bb.events.on("thread.archived", async ({ thread }) => {
    const active = await discardActiveReview(thread.id);
    if (!active) return;
    await bb.storage.kv.set(reviewKey(active.sessionId), {
      id: active.sessionId,
      threadId: thread.id,
      kind: active.kind,
      initiator: active.initiator,
      status: "closed",
      result: {
        reviewId: active.sessionId,
        source: "plannotator",
        kind: active.kind,
        decision: "cancelled",
        error: "The review ended when its thread was archived.",
      },
      updatedAt: Date.now(),
    } satisfies StoredReview);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    const active = await discardActiveReview(thread.id);
    if (active) await bb.storage.kv.delete(reviewKey(active.sessionId));
    for (const key of await bb.storage.kv.list(REVIEW_KEY_PREFIX)) {
      const parsed = storedReviewSchema.safeParse(await bb.storage.kv.get(key));
      if (parsed.success && parsed.data.threadId === thread.id) {
        await bb.storage.kv.delete(key);
      }
    }
  });

  bb.onDispose(async () => {
    disposing = true;
    await Promise.allSettled(
      [...activeReviews.entries()].map(async ([threadId, active]) => {
        const { sessionId, review, controller, settled } = active;
        controller.abort();
        await Promise.allSettled([
          closeReviewPanel(bb, threadId, sessionId),
          review.stop(),
          stopAskAi(active),
        ]);
        if (settled) await settled;
      }),
    );
    activeReviews.clear();
    startingReviews.clear();
    relaySessions.clear();
  });

  bb.log.info("loaded upstream Plannotator bridge");
}
