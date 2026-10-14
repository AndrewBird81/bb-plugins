// The typed boundary between the plugin server and its `bb.host` entry. The
// host entry runs Plannotator on the thread's own machine and publishes it to
// the tailnet with `tailscale serve`.
import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Loopback ports the review proxy may bind on a non-server host.
 * `tailscale serve` publishes the same port number over HTTPS. Reconcile
 * removes only mappings it recorded that still proxy to
 * `http://127.0.0.1:<same port>`.
 */
export const HOST_PORT_RANGE = { first: 19500, last: 19509 } as const;

export const upstreamOriginSchema = z.enum([
  "claude-code",
  "opencode",
  "codex",
  "copilot-cli",
  "gemini-cli",
  "pi",
]);

export const upstreamDecisionSchema = z
  .object({
    approved: z.boolean(),
    feedback: z.string().optional(),
    savedPath: z.string().optional(),
    agentSwitch: z.string().optional(),
  })
  .strict();

/** Upstream's `review --diff-type` values. */
export const diffTypeSchema = z.enum([
  "since-base",
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
  "merge-base",
  "all",
]);
/** A git ref passed as one argv entry; never an option. */
export const gitRefSchema = z.string().regex(/^[^-\s][^\s]{0,199}$/u);
/** Upstream's per-message cap for annotate-last. */
export const MAX_ANNOTATE_MARKDOWN = 2 * 1024 * 1024;

/**
 * One Plannotator session. `annotate.path` is absolute here; the server
 * resolves it against the worktree and the side that spawns Plannotator
 * checks it again.
 */
export const sessionRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("plan"), planMarkdown: z.string().min(1).max(1_000_000) }).strict(),
  z
    .object({
      mode: z.literal("review"),
      diffType: diffTypeSchema.optional(),
      base: gitRefSchema.optional(),
    })
    .strict(),
  z.object({ mode: z.literal("annotate"), path: z.string().min(1).max(4096) }).strict(),
  z
    .object({ mode: z.literal("annotate-last"), markdown: z.string().min(1).max(MAX_ANNOTATE_MARKDOWN) })
    .strict(),
]);
export type SessionRequest = z.infer<typeof sessionRequestSchema>;
export type SessionMode = SessionRequest["mode"];

/** The record review and annotate sessions write to `PLANNOTATOR_HOST_RESULT_FILE`. */
export const sessionResultSchema = z
  .object({
    surface: z.enum(["review", "annotate", "annotate-last"]),
    decision: z.enum(["approved", "annotated", "dismissed"]),
    message: z.string(),
    noop: z.boolean(),
    annotationCount: z.number().int().nonnegative().optional(),
    target: z.union([z.string(), z.array(z.string())]).optional(),
  })
  .strict();
export type SessionResult = z.infer<typeof sessionResultSchema>;

const sessionIdSchema = z.object({ sessionId: z.string().uuid() }).strict();

export const hostReviewStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z
    .object({
      status: z.literal("decided"),
      decision: z.union([upstreamDecisionSchema, sessionResultSchema]),
    })
    .strict(),
  z.object({ status: z.literal("failed"), error: z.string() }).strict(),
  // The worker has no record of the review: it restarted or already cleaned up.
  z.object({ status: z.literal("unknown") }).strict(),
]);
export type HostReviewState = z.infer<typeof hostReviewStateSchema>;

export const hostContract = defineRpcContract({
  startReview: {
    input: z
      .object({
        sessionId: z.string().uuid(),
        cwd: z.string().min(1),
        origin: upstreamOriginSchema,
        session: sessionRequestSchema,
      })
      .strict(),
    output: z
      .object({ url: z.string().url(), port: z.number().int() })
      .strict(),
  },
  getReview: {
    input: sessionIdSchema,
    output: hostReviewStateSchema,
  },
  stopReview: {
    input: sessionIdSchema,
    output: z.object({ stopped: z.boolean() }).strict(),
  },
  /** Remove stale serve mappings and orphan processes from a dead worker. */
  reconcile: {
    input: z.object({}).strict(),
    output: z
      .object({
        removedPorts: z.array(z.number().int()),
        killedPids: z.array(z.number().int()),
      })
      .strict(),
  },
});

export const hostSignals = {
  /** A review's state changed. Lossy: the server also polls `getReview`. */
  reviewChanged: {
    payload: sessionIdSchema,
  },
} satisfies ExperimentalHostSignals;
