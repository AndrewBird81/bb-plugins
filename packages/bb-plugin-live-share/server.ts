// Live Share — share a thread and its workbench through a password-protected,
// end-to-end encrypted link that opens in any browser.
//
// A share is a password-protected grant on one thread. Guests reach this
// server only through the host worker's gateway (see host.ts), which serves
// the guest page and forwards its API calls to the token-protected `/guest/*`
// routes registered below. Every guest request carries a session token issued
// by `/guest/login`, and every capability is checked against the share's
// current access level.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals, type GatewayStatus } from "./src/contract.js";
import {
  accessSchema,
  canControl,
  canSend,
  clientMessageSchema,
  cursorColors,
  cursorSchema,
  loginResponseSchema,
  participantSchema,
  regionSchema,
  selectionSchema,
  viewSchema,
  type Access,
  type Changes,
  type ChangedFile,
  type Cursor,
  type EditorMirror,
  type Info,
  type PanelTab,
  type Participant,
  type Region,
  type Selection,
  type ServerMessage,
  type View,
  type Snapshot,
} from "./src/shared.js";
import { projectTimeline } from "./src/timeline.js";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SHARES_KEY = "shares";
const OWNER_ID = "owner";
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const TIMELINE_SEGMENTS = "40";
const MAX_MESSAGE_CHARS = 8_000;
const MAX_FILE_PATCH = 200_000;
const MAX_TOTAL_PATCH = 1_500_000;

const shareRecordSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  access: accessSchema,
  salt: z.string(),
  hash: z.string(),
  // Kept so the host can see the password again. It stays in this plugin's
  // storage on the host machine and is never sent to guests.
  password: z.string().nullable().default(null),
  createdAt: z.number(),
});
type ShareRecord = z.infer<typeof shareRecordSchema>;

const shareViewSchema = z
  .object({
    id: z.string(),
    threadId: z.string(),
    access: accessSchema,
    createdAt: z.number(),
    link: z.string().nullable(),
    password: z.string().nullable(),
  })
  .strict();

const gatewayStatusSchema = z.object({
  running: z.boolean(),
  exposure: z.enum(["opentunnel", "local"]).nullable(),
  localUrl: z.string().nullable(),
  publicUrl: z.string().nullable(),
  tunnel: z.enum(["off", "connecting", "connected", "reconnecting", "error"]),
  error: z.string().nullable(),
});

const ownerStateSchema = z
  .object({
    share: shareViewSchema.nullable(),
    gateway: gatewayStatusSchema,
    participants: z.array(participantSchema),
    me: z.object({ name: z.string(), color: z.string() }).strict(),
  })
  .strict();

const threadIdInput = z.object({ threadId: z.string().min(1).max(64) }).strict();
const passwordSchema = z.string().min(6, "Use at least 6 characters").max(200);
const textSchema = z.string().trim().min(1).max(MAX_MESSAGE_CHARS);

export const rpcContract = defineRpcContract({
  state: { input: threadIdInput, output: ownerStateSchema },
  share_start: {
    input: z.object({ threadId: z.string().min(1).max(64), access: accessSchema, password: passwordSchema }).strict(),
    output: ownerStateSchema,
  },
  share_update: {
    input: z
      .object({
        threadId: z.string().min(1).max(64),
        access: accessSchema.optional(),
        password: passwordSchema.optional(),
      })
      .strict(),
    output: ownerStateSchema,
  },
  share_stop: { input: threadIdInput, output: ownerStateSchema },
  shares_list: {
    input: z.null(),
    output: z.object({
      shares: z.array(
        z.object({ threadId: z.string(), title: z.string(), access: accessSchema, guests: z.number() }).strict(),
      ),
    }),
  },
  kick: {
    input: z.object({ threadId: z.string().min(1).max(64), participantId: z.string().max(64) }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  owner_view: {
    input: z.object({ threadId: z.string().min(1).max(64), view: viewSchema }).strict(),
    output: z.null(),
  },
  owner_selection: {
    input: z.object({ threadId: z.string().min(1).max(64), selection: selectionSchema }).strict(),
    output: z.null(),
  },
  owner_cursor: {
    input: z
      .object({ threadId: z.string().min(1).max(64), region: regionSchema.nullable(), cursor: cursorSchema })
      .strict(),
    output: z.null(),
  },
});

class GuestError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
  }
}

function randomId(bytes: number): string {
  // Lowercase and unambiguous, so ids read well in links.
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (const byte of randomBytes(bytes)) out += alphabet[byte % alphabet.length];
  return out;
}

async function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return scrypt(password.normalize("NFC"), salt, 32);
}

/** Splits one unified diff into per-file patches the guest page renders. */
function splitDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let total = 0;
  const chunks = diff.split(/^(?=diff --git )/mu).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/mu.exec(chunk);
    const plus = /^\+\+\+ b\/(.+)$/mu.exec(chunk);
    const path = (plus?.[1] ?? header?.[2] ?? "unknown").trim();
    let additions = 0;
    let deletions = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    const patch = chunk.length > MAX_FILE_PATCH ? "" : chunk;
    total += patch.length;
    if (total > MAX_TOTAL_PATCH) break;
    files.push({ path, additions, deletions, patch });
    if (files.length >= 500) break;
  }
  return files;
}

type Session = {
  token: string;
  shareId: string;
  threadId: string;
  participantId: string;
  name: string;
  color: string;
  lastSeen: number;
  region: Region | null;
  cursor: Cursor;
  selection: Selection;
  view: View;
};

type GuestSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    displayName: {
      type: "string",
      label: "Your name",
      description: "Shown to people you share a thread with.",
      default: "",
    },
    exposure: {
      type: "select",
      label: "Exposure",
      description:
        "opentunnel publishes an end-to-end encrypted public URL. local only listens on 127.0.0.1, for testing or your own tunnel.",
      options: ["opentunnel", "local"],
      default: "opentunnel",
    },
    gatewayPort: {
      type: "number",
      label: "Gateway port",
      description: "Loopback port for the share gateway. 0 picks a free port.",
      experimental_schema: z.number().int().min(0).max(65_535),
      default: 0,
    },
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  // ---------------------------------------------------------------- state

  const sessions = new Map<string, Session>();
  const sockets = new Map<string, Set<GuestSocket>>(); // session token -> sockets
  const loginFailures = new Map<string, number[]>(); // share id -> failure times
  type Presence = { region: Region | null; cursor: Cursor; selection: Selection; view: View };
  const ownerPresence = new Map<string, Presence>();
  const emptyPresence = (): Presence => ({ region: null, cursor: null, selection: null, view: null });
  let gatewayStatus: GatewayStatus = {
    running: false,
    exposure: null,
    localUrl: null,
    publicUrl: null,
    tunnel: "off",
    error: null,
  };

  async function readShares(): Promise<ShareRecord[]> {
    const raw = (await bb.storage.kv.get<unknown>(SHARES_KEY)) ?? [];
    const parsed = z.array(shareRecordSchema).safeParse(raw);
    return parsed.success ? parsed.data : [];
  }
  async function writeShares(shares: ShareRecord[]): Promise<void> {
    await bb.storage.kv.set(SHARES_KEY, shares);
    bb.realtime.publish("shares", { count: shares.length });
  }
  async function shareForThread(threadId: string): Promise<ShareRecord | null> {
    return (await readShares()).find((share) => share.threadId === threadId) ?? null;
  }

  async function myName(): Promise<string> {
    const { displayName } = await settings.get();
    return displayName.trim() || "Host";
  }

  // -------------------------------------------------------------- gateway

  host.experimental_onSignal("status", ({ payload }) => {
    gatewayStatus = payload;
    bb.realtime.publish("gateway", payload);
  });

  async function primaryHostId(): Promise<string> {
    const config = await bb.sdk.system.config();
    if (!config.primaryHostId) throw new Error("This BB server has no local machine to run the share gateway.");
    return config.primaryHostId;
  }

  async function ensureGateway(): Promise<GatewayStatus> {
    const { exposure, gatewayPort } = await settings.get();
    const { token } = await bb.sdk.plugins.token({ pluginId: bb.pluginId });
    gatewayStatus = await host.call(
      "start",
      {
        upstreamBaseUrl: bb.server.loopbackBaseUrl,
        pluginId: bb.pluginId,
        pluginToken: token,
        exposure: exposure === "local" ? "local" : "opentunnel",
        port: gatewayPort,
      },
      { hostId: await primaryHostId() },
    );
    bb.realtime.publish("gateway", gatewayStatus);
    return gatewayStatus;
  }

  async function refreshGateway(): Promise<GatewayStatus> {
    if (!gatewayStatus.running) return gatewayStatus;
    try {
      gatewayStatus = await host.call("status", null, { hostId: await primaryHostId() });
    } catch (error) {
      bb.log.warn(`gateway status failed: ${String(error)}`);
    }
    return gatewayStatus;
  }

  async function reconcileGateway(): Promise<void> {
    const shares = await readShares();
    try {
      if (shares.length > 0) await ensureGateway();
      else if (gatewayStatus.running) {
        gatewayStatus = await host.call("stop", null, { hostId: await primaryHostId() });
        bb.realtime.publish("gateway", gatewayStatus);
      }
    } catch (error) {
      bb.log.error(`gateway reconcile failed: ${String(error)}`);
    }
  }

  host.experimental_onWorkerExit(() => {
    gatewayStatus = { ...gatewayStatus, running: false, tunnel: "off" };
    void reconcileGateway();
  });
  settings.onChange(() => void reconcileGateway());

  function shareLink(share: ShareRecord): string | null {
    const base = gatewayStatus.exposure === "local" ? gatewayStatus.localUrl : gatewayStatus.publicUrl;
    return base ? `${base}/s/${share.id}` : null;
  }

  // ------------------------------------------------------------- presence

  function sessionsForThread(threadId: string): Session[] {
    return [...sessions.values()].filter(
      (session) => session.threadId === threadId && (sockets.get(session.token)?.size ?? 0) > 0,
    );
  }

  async function participantsFor(threadId: string): Promise<Participant[]> {
    const share = await shareForThread(threadId);
    const owner = ownerPresence.get(threadId);
    return [
      {
        id: OWNER_ID,
        name: await myName(),
        color: cursorColors[0]!,
        role: "owner",
        access: "full",
        region: owner?.region ?? null,
        cursor: owner?.cursor ?? null,
        selection: owner?.selection ?? null,
        view: owner?.view ?? null,
      },
      ...sessionsForThread(threadId).map((session) => ({
        id: session.participantId,
        name: session.name,
        color: session.color,
        role: "guest" as const,
        access: share?.access ?? "read",
        region: session.region,
        cursor: session.cursor,
        selection: session.selection,
        view: session.view,
      })),
    ];
  }

  function sendTo(token: string, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of sockets.get(token) ?? []) {
      try {
        socket.send(data);
      } catch {
        // A closing socket is cleaned up by its onClose handler.
      }
    }
  }

  function broadcastToGuests(threadId: string, message: ServerMessage, exceptToken?: string): void {
    for (const session of sessionsForThread(threadId)) {
      if (session.token !== exceptToken) sendTo(session.token, message);
    }
  }

  async function broadcastParticipants(threadId: string): Promise<void> {
    const participants = await participantsFor(threadId);
    broadcastToGuests(threadId, { type: "participants", participants });
    bb.realtime.publish(`presence:${threadId}`, { participants });
    bb.realtime.publish("shares", { threadId });
  }

  function broadcastCursor(
    threadId: string,
    participantId: string,
    region: Region | null,
    cursor: Cursor,
    exceptToken?: string,
  ): void {
    broadcastToGuests(threadId, { type: "cursor", participantId, region, cursor }, exceptToken);
    if (participantId !== OWNER_ID) {
      bb.realtime.publish(`cursor:${threadId}`, { participantId, region, cursor });
    }
  }

  function broadcastSelection(threadId: string, participantId: string, selection: Selection, exceptToken?: string): void {
    broadcastToGuests(threadId, { type: "selection", participantId, selection }, exceptToken);
    if (participantId !== OWNER_ID) bb.realtime.publish(`selection:${threadId}`, { participantId, selection });
  }

  function broadcastView(threadId: string, participantId: string, view: View, exceptToken?: string): void {
    broadcastToGuests(threadId, { type: "view", participantId, view }, exceptToken);
    if (participantId !== OWNER_ID) bb.realtime.publish(`view:${threadId}`, { participantId, view });
  }

  function endSession(token: string, reason: string): void {
    const session = sessions.get(token);
    sendTo(token, { type: "ended", reason });
    for (const socket of sockets.get(token) ?? []) socket.close(4401, reason);
    sockets.delete(token);
    sessions.delete(token);
    if (session) void broadcastParticipants(session.threadId);
  }

  function endSessionsForShare(shareId: string, reason: string): void {
    for (const session of [...sessions.values()]) {
      if (session.shareId === shareId) endSession(session.token, reason);
    }
  }

  // --------------------------------------------------- thread projections

  async function snapshotFor(threadId: string, access: Access, shareId: string): Promise<Snapshot> {
    const [thread, timeline] = await Promise.all([
      bb.sdk.threads.get({ threadId }),
      bb.sdk.threads.timeline({ threadId, segmentLimit: TIMELINE_SEGMENTS }),
    ]);
    return {
      shareId,
      threadId,
      title: thread.title ?? "Untitled thread",
      status: String(thread.status),
      maxSeq: Number(timeline.maxSeq) || 0,
      access,
      hasOlderRows: Boolean(timeline.timelinePage?.hasOlderRows),
      rows: projectTimeline(threadId, timeline.rows as unknown as Array<Record<string, unknown>>),
    };
  }

  async function changesFor(threadId: string): Promise<Changes> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) {
      return { scope: "uncommitted", available: false, message: "This thread has no workspace.", shortstat: "", truncated: false, files: [] };
    }
    // Match BB's Diff tab default: everything on the branch since its merge
    // base, committed or not. Without a merge base, show uncommitted changes.
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null);
    const mergeBaseBranch = environment?.mergeBaseBranch ?? null;
    const scope = mergeBaseBranch ? ("all" as const) : ("uncommitted" as const);
    const result = await bb.sdk.environments.diff(
      mergeBaseBranch
        ? { environmentId: thread.environmentId, target: "all", mergeBaseBranch }
        : { environmentId: thread.environmentId, target: "uncommitted" },
    );
    if (result.outcome !== "available") {
      return {
        scope,
        available: false,
        message: result.outcome === "not_applicable" ? result.message : result.failure.message,
        shortstat: "",
        truncated: false,
        files: [],
      };
    }
    return {
      scope,
      available: true,
      message: null,
      shortstat: result.diff.shortstat,
      truncated: result.diff.truncated,
      files: splitDiff(result.diff.diff),
    };
  }

  /**
   * The host's right-panel tabs, titled the way BB's tab strip shows them.
   * The studio-code workspace id stays on the server.
   */
  async function hostTabs(threadId: string): Promise<Array<{ tab: PanelTab; workspaceId: string | null }>> {
    const result = await bb.sdk.threads.tabs.get({ threadId }).catch(() => null);
    const raw = ((result as { tabs?: unknown[] } | null)?.tabs ?? []) as Array<Record<string, unknown>>;
    const tabs: Array<{ tab: PanelTab; workspaceId: string | null }> = [];
    for (const tab of raw) {
      if (tab.kind === "thread-info") tabs.push({ tab: { region: "info", title: "Info", kind: "info", path: null }, workspaceId: null });
      else if (tab.kind === "git-diff") tabs.push({ tab: { region: "changes", title: "Diff", kind: "diff", path: null }, workspaceId: null });
      else {
        const owner = (tab.fileOpenerOwner ?? null) as { tab?: { path?: unknown } } | null;
        const path = typeof owner?.tab?.path === "string" ? owner.tab.path : null;
        const title = (typeof tab.title === "string" && tab.title ? tab.title : path?.split("/").pop() ?? String(tab.kind)).slice(0, 300);
        let workspaceId: string | null = null;
        if (tab.pluginId === "studio-code" && tab.actionId === "code" && typeof tab.paramsJson === "string") {
          try {
            const params = JSON.parse(tab.paramsJson) as { workspaceId?: unknown };
            workspaceId = typeof params.workspaceId === "string" ? params.workspaceId : null;
          } catch {
            workspaceId = null;
          }
        }
        const kind = workspaceId ? "vscode" : path ? "file" : "other";
        tabs.push({ tab: { region: `tab:${title}`, title, kind, path }, workspaceId });
      }
    }
    return tabs.slice(0, 50);
  }

  async function tabsFor(threadId: string): Promise<PanelTab[]> {
    return (await hostTabs(threadId)).map((entry) => entry.tab);
  }

  const editorStateOutput = z.object({
    state: z
      .object({
        focused: z.boolean(),
        activeFile: z
          .object({
            path: z.string(),
            language: z.string(),
            selection: z.object({ startLine: z.number(), startColumn: z.number(), endLine: z.number(), endColumn: z.number() }),
            visible: z.object({ startLine: z.number(), endLine: z.number() }).nullable(),
          })
          .passthrough()
          .nullable(),
        openFiles: z.array(z.string()),
        unsavedFiles: z.array(z.string()),
      })
      .passthrough()
      .nullable(),
  });
  const workspaceOutput = z.object({ workspace: z.object({ folders: z.array(z.string()) }).passthrough().nullable() }).passthrough();
  const readFileOutput = z.object({ text: z.string().nullable(), reason: z.string().nullable() });

  /** Mirrors the studio-code VS Code tab: what is open, where, and what is selected. */
  async function editorMirror(threadId: string, region: string, knownHash: string | null): Promise<EditorMirror> {
    const empty = (message: string): EditorMirror => ({ available: false, message, focused: false, openFiles: [], file: null });
    const entry = (await hostTabs(threadId)).find((candidate) => candidate.tab.region === region);
    if (!entry?.workspaceId) return empty("That tab is no longer open.");
    const id = entry.workspaceId;
    const call = <T>(method: string, input: unknown, outputSchema: z.ZodType<T>) =>
      bb.sdk.plugins.callRpc({ pluginId: "studio-code", method, input, outputSchema } as never) as Promise<T>;
    const [state, workspace] = await Promise.all([
      call("editorState", { id }, editorStateOutput).catch(() => null),
      call("get", { id }, workspaceOutput).catch(() => null),
    ]);
    if (!state) return empty("VS Code is not reachable on the host.");
    if (!state.state) return empty("VS Code is not open on the host right now.");
    const folders = workspace?.workspace?.folders ?? [];
    // Never send absolute paths from the host's disk; show them workspace-relative.
    const relative = (path: string): string | null => {
      for (const folder of folders) {
        const prefix = folder.endsWith("/") ? folder : `${folder}/`;
        if (path.startsWith(prefix)) return path.slice(prefix.length);
      }
      return null;
    };
    const openFiles = state.state.openFiles.flatMap((path) => {
      const rel = relative(path);
      return rel ? [rel] : [];
    });
    const active = state.state.activeFile;
    const activePath = active ? relative(active.path) : null;
    if (!active || !activePath) {
      return { available: true, message: null, focused: state.state.focused, openFiles, file: null };
    }
    const read = await call("readFile", { id, path: active.path }, readFileOutput).catch(() => null);
    const text = read?.text ?? null;
    const capped = text === null ? null : text.slice(0, MAX_FILE_PATCH * 2);
    const hash = createHash("sha256").update(capped ?? `none:${read?.reason ?? ""}`).digest("hex").slice(0, 32);
    const clampLine = (value: number) => Math.max(1, Math.floor(value));
    return {
      available: true,
      message: null,
      focused: state.state.focused,
      openFiles,
      file: {
        path: activePath,
        language: active.language.slice(0, 100),
        unsaved: state.state.unsavedFiles.includes(active.path),
        selection: {
          startLine: clampLine(active.selection.startLine),
          startColumn: clampLine(active.selection.startColumn),
          endLine: clampLine(active.selection.endLine),
          endColumn: clampLine(active.selection.endColumn),
        },
        visible: active.visible ? { startLine: clampLine(active.visible.startLine), endLine: clampLine(active.visible.endLine) } : null,
        hash,
        content: hash === knownHash ? null : (capped ?? ""),
        reason: text === null ? (read?.reason ?? "The file could not be read.") : null,
      },
    };
  }

  /** The safe subset of BB's thread info panel: no machine, paths, or files from storage. */
  async function infoFor(threadId: string): Promise<Info> {
    const thread = await bb.sdk.threads.get({ threadId });
    const info: Info = {
      project: null,
      environment: null,
      branch: null,
      mergeBase: null,
      gitStatus: null,
      status: String(thread.status),
      files: [],
      additions: 0,
      deletions: 0,
    };
    if (thread.projectId) {
      info.project = await bb.sdk.projects.get({ projectId: thread.projectId }).then((project) => project.name, () => null);
    }
    if (!thread.environmentId) return info;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null);
    if (!environment) return info;
    const providers = await bb.sdk.environments.listProviders().catch(() => null);
    const providerList = (Array.isArray(providers) ? providers : ((providers as { providers?: unknown[] } | null)?.providers ?? [])) as Array<{
      id?: string;
      displayName?: string;
    }>;
    const providerId = (environment as { environmentProviderId?: string | null }).environmentProviderId ?? null;
    info.environment = providerList.find((provider) => provider.id === providerId)?.displayName ?? providerId;
    info.branch = environment.branchName ?? null;
    info.mergeBase = environment.mergeBaseBranch ?? null;
    const status = await bb.sdk.environments
      .status({ environmentId: thread.environmentId, ...(info.mergeBase ? { mergeBaseBranch: info.mergeBase } : {}) })
      .catch(() => null);
    const workspace = (status as { outcome?: string; workspace?: Record<string, unknown> } | null)?.outcome === "available"
      ? ((status as { workspace: Record<string, unknown> }).workspace)
      : null;
    if (workspace) {
      const tree = (workspace.workingTree ?? {}) as {
        insertions?: number;
        deletions?: number;
        files?: Array<{ path: string; status: string; insertions?: number; deletions?: number }>;
      };
      info.files = (tree.files ?? []).slice(0, 500).map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.insertions ?? 0,
        deletions: file.deletions ?? 0,
      }));
      info.additions = tree.insertions ?? 0;
      info.deletions = tree.deletions ?? 0;
      const mergeBase = workspace.mergeBase as { aheadCount?: number; behindCount?: number; mergeBaseBranch?: string } | null;
      if (mergeBase && info.mergeBase) {
        const ahead = mergeBase.aheadCount ?? 0;
        const behind = mergeBase.behindCount ?? 0;
        info.gitStatus =
          ahead === 0 && behind === 0
            ? `Even with ${info.mergeBase}`
            : [ahead ? `${ahead} ahead` : "", behind ? `${behind} behind` : ""].filter(Boolean).join(", ") + ` ${info.mergeBase}`;
      }
    }
    return info;
  }

  bb.events.on("experimental_thread.events", ({ thread, sequence }) => {
    void (async () => {
      if (!(await shareForThread(thread.id))) return;
      broadcastToGuests(thread.id, { type: "thread", maxSeq: Number(sequence) || 0, status: String(thread.status) });
    })();
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    void (async () => {
      const shares = await readShares();
      const doomed = shares.filter((share) => share.threadId === thread.id);
      if (doomed.length === 0) return;
      for (const share of doomed) endSessionsForShare(share.id, "The thread was deleted.");
      await writeShares(shares.filter((share) => share.threadId !== thread.id));
      await reconcileGateway();
    })();
  });

  // ------------------------------------------------------ guest endpoints

  async function guestSession(token: string | undefined): Promise<{ session: Session; share: ShareRecord }> {
    const session = token ? sessions.get(token) : undefined;
    if (!session || Date.now() - session.lastSeen > SESSION_IDLE_MS) {
      if (session) sessions.delete(session.token);
      throw new GuestError(401, "Your session ended. Enter the password again.");
    }
    const share = (await readShares()).find((candidate) => candidate.id === session.shareId);
    if (!share) {
      endSession(session.token, "The host stopped sharing.");
      throw new GuestError(401, "The host stopped sharing.");
    }
    session.lastSeen = Date.now();
    return { session, share };
  }

  type HonoLike = {
    req: { header(name: string): string | undefined; json(): Promise<unknown> };
    json(body: unknown, status?: number): Response;
  };

  function guestRoute(
    name: string,
    handler: (context: { body: unknown; session: string | undefined }) => Promise<unknown>,
  ): void {
    bb.http.route(
      "POST",
      `/guest/${name}`,
      async (raw) => {
        const c = raw as unknown as HonoLike;
        try {
          const body = await c.req.json().catch(() => ({}));
          const result = await handler({ body, session: c.req.header("x-live-share-session") });
          return c.json(result);
        } catch (error) {
          if (error instanceof GuestError) return c.json({ error: error.message }, error.status);
          if (error instanceof z.ZodError) return c.json({ error: "Invalid request." }, 400);
          bb.log.error(`guest ${name} failed: ${String(error)}`);
          return c.json({ error: "Something went wrong on the host." }, 500);
        }
      },
      { auth: "token" },
    );
  }

  // The host's palette, so the guest page matches the host's BB. A theme is
  // not secret, so this is the one route that needs no session.
  guestRoute("theme", async () => {
    const theme = await bb.sdk.theme.get();
    return { css: theme.customCss ?? "" };
  });

  guestRoute("login", async ({ body }) => {
    const input = z
      .object({
        shareId: z.string().min(1).max(64),
        password: z.string().min(1).max(200),
        name: z.string().trim().min(1).max(40),
      })
      .parse(body);
    const now = Date.now();
    const failures = (loginFailures.get(input.shareId) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS);
    if (failures.length >= LOGIN_MAX_FAILURES) {
      throw new GuestError(429, "Too many wrong passwords. Try again in a few minutes.");
    }
    const share = (await readShares()).find((candidate) => candidate.id === input.shareId);
    // Hash even for unknown shares so timing does not reveal which ids exist.
    const salt = share ? Buffer.from(share.salt, "hex") : randomBytes(16);
    const actual = await hashPassword(input.password, salt);
    const expected = share ? Buffer.from(share.hash, "hex") : randomBytes(32);
    if (!share || !timingSafeEqual(actual, expected)) {
      failures.push(now);
      loginFailures.set(input.shareId, failures);
      throw new GuestError(401, "Wrong link or password.");
    }
    loginFailures.delete(input.shareId);
    const thread = await bb.sdk.threads.get({ threadId: share.threadId });
    const used = new Set(sessionsForThread(share.threadId).map((session) => session.color));
    const color = cursorColors.slice(1).find((candidate) => !used.has(candidate)) ?? cursorColors[1]!;
    const session: Session = {
      token: randomBytes(32).toString("base64url"),
      shareId: share.id,
      threadId: share.threadId,
      participantId: `g_${randomId(8)}`,
      name: input.name,
      color,
      lastSeen: now,
      region: null,
      cursor: null,
      selection: null,
      view: null,
    };
    sessions.set(session.token, session);
    return loginResponseSchema.parse({
      sessionToken: session.token,
      participantId: session.participantId,
      access: share.access,
      title: thread.title ?? "Untitled thread",
      hostName: await myName(),
    });
  });

  guestRoute("snapshot", async ({ session: token }) => {
    const { share } = await guestSession(token);
    return snapshotFor(share.threadId, share.access, share.id);
  });

  guestRoute("changes", async ({ session: token }) => {
    const { share } = await guestSession(token);
    return changesFor(share.threadId);
  });

  guestRoute("tabs", async ({ session: token }) => {
    const { share } = await guestSession(token);
    return { tabs: await tabsFor(share.threadId) };
  });

  guestRoute("file", async ({ body, session: token }) => {
    const { share } = await guestSession(token);
    const { path } = z.object({ path: z.string().min(1).max(2_000) }).parse(body);
    // Only files the host has open in a panel tab are readable.
    const open = (await tabsFor(share.threadId)).some((tab) => tab.kind === "file" && tab.path === path);
    if (!open) throw new GuestError(403, "That file is not open on the host.");
    const thread = await bb.sdk.threads.get({ threadId: share.threadId });
    if (!thread.environmentId) throw new GuestError(404, "This thread has no workspace.");
    const file = await bb.sdk.environments
      .diffFile({ environmentId: thread.environmentId, target: "uncommitted", path, side: "new" })
      .catch(() => null);
    if (!file) throw new GuestError(404, "The file could not be read.");
    const binary = file.contentEncoding !== "utf8";
    const content = binary ? "" : file.content;
    return { path, content: content.slice(0, MAX_FILE_PATCH * 2), truncated: content.length > MAX_FILE_PATCH * 2, binary };
  });

  guestRoute("vscode", async ({ body, session: token }) => {
    const { share } = await guestSession(token);
    const input = z.object({ region: z.string().max(400), knownHash: z.string().max(64).nullable().default(null) }).parse(body);
    return editorMirror(share.threadId, input.region, input.knownHash);
  });

  guestRoute("info", async ({ session: token }) => {
    const { share } = await guestSession(token);
    return infoFor(share.threadId);
  });

  guestRoute("send", async ({ body, session: token }) => {
    const { session, share } = await guestSession(token);
    if (!canSend(share.access)) throw new GuestError(403, "This share is read only.");
    const { text } = z.object({ text: textSchema }).parse(body);
    // Attribute the message so the agent and the host know who wrote it, and
    // queue it behind a running turn instead of steering it.
    await bb.sdk.threads.send({
      threadId: share.threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text: `[${session.name}] ${text}`, mentions: [] }],
    });
    return { ok: true };
  });

  guestRoute("stop", async ({ session: token }) => {
    const { share } = await guestSession(token);
    if (!canControl(share.access)) throw new GuestError(403, "Stopping the agent needs full access.");
    await bb.sdk.threads.stop({ threadId: share.threadId });
    return { ok: true };
  });

  guestRoute("leave", async ({ session: token }) => {
    const session = token ? sessions.get(token) : undefined;
    if (session) endSession(session.token, "You left.");
    return { ok: true };
  });

  bb.http.experimental_websocket(
    "/guest/socket",
    ({ url }) => {
      const token = url.searchParams.get("session") ?? "";
      let counter = { windowStart: Date.now(), count: 0 };
      let self: GuestSocket | null = null;
      return {
        async onOpen(socket) {
          self = socket;
          let ctx: { session: Session; share: ShareRecord };
          try {
            ctx = await guestSession(token);
          } catch {
            socket.send(JSON.stringify({ type: "ended", reason: "Your session ended." } satisfies ServerMessage));
            socket.close(4401, "session ended");
            return;
          }
          const set = sockets.get(token) ?? new Set<GuestSocket>();
          set.add(socket);
          sockets.set(token, set);
          socket.send(
            JSON.stringify({
              type: "hello",
              participantId: ctx.session.participantId,
              access: ctx.share.access,
              participants: await participantsFor(ctx.share.threadId),
            } satisfies ServerMessage),
          );
          await broadcastParticipants(ctx.share.threadId);
        },
        onMessage(socket, data) {
          const session = sessions.get(token);
          if (!session) return socket.close(4401, "session ended");
          const now = Date.now();
          if (now - counter.windowStart > 1_000) counter = { windowStart: now, count: 0 };
          counter.count += 1;
          if (counter.count > 60) return;
          let message;
          try {
            const text = typeof data === "string" ? data : new TextDecoder().decode(data);
            message = clientMessageSchema.parse(JSON.parse(text));
          } catch {
            return;
          }
          session.lastSeen = now;
          if (message.type === "cursor") {
            session.region = message.region;
            session.cursor = message.cursor;
            broadcastCursor(session.threadId, session.participantId, message.region, message.cursor, token);
          } else if (message.type === "view") {
            session.view = message.view;
            broadcastView(session.threadId, session.participantId, message.view, token);
          } else if (message.type === "selection") {
            session.selection = message.selection;
            broadcastSelection(session.threadId, session.participantId, message.selection, token);
          }
        },
        onClose() {
          const set = sockets.get(token);
          if (self) set?.delete(self);
          if (set && set.size === 0) sockets.delete(token);
          const session = sessions.get(token);
          if (session) {
            session.cursor = null;
            session.selection = null;
            session.view = null;
            void broadcastParticipants(session.threadId);
          }
        },
      };
    },
    { auth: "token" },
  );

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (now - session.lastSeen > SESSION_IDLE_MS) endSession(token, "Your session timed out.");
    }
  }, 60_000);
  bb.onDispose(() => clearInterval(sweep));

  // ------------------------------------------------------------ owner RPC

  async function ownerState(threadId: string) {
    const share = await shareForThread(threadId);
    await refreshGateway();
    return {
      share: share
        ? {
            id: share.id,
            threadId: share.threadId,
            access: share.access,
            createdAt: share.createdAt,
            link: shareLink(share),
            password: share.password,
          }
        : null,
      gateway: gatewayStatus,
      participants: await participantsFor(threadId),
      me: { name: await myName(), color: cursorColors[0]! },
    };
  }

  bb.rpc.register(rpcContract, {
    state: ({ threadId }) => ownerState(threadId),

    async share_start({ threadId, access, password }) {
      await bb.sdk.threads.get({ threadId });
      const shares = await readShares();
      if (shares.some((share) => share.threadId === threadId)) {
        throw new Error("This thread is already shared. Stop sharing first, or change access.");
      }
      const salt = randomBytes(16);
      const hash = await hashPassword(password, salt);
      shares.push({
        id: randomId(16),
        threadId,
        access,
        salt: salt.toString("hex"),
        hash: hash.toString("hex"),
        password,
        createdAt: Date.now(),
      });
      await writeShares(shares);
      await ensureGateway();
      return ownerState(threadId);
    },

    async share_update({ threadId, access, password }) {
      const shares = await readShares();
      const share = shares.find((candidate) => candidate.threadId === threadId);
      if (!share) throw new Error("This thread is not shared.");
      if (access) share.access = access;
      if (password) {
        const salt = randomBytes(16);
        share.salt = salt.toString("hex");
        share.hash = (await hashPassword(password, salt)).toString("hex");
        share.password = password;
      }
      await writeShares(shares);
      if (password) endSessionsForShare(share.id, "The host changed the password.");
      else if (access) {
        for (const session of sessionsForThread(threadId)) sendTo(session.token, { type: "access", access });
        await broadcastParticipants(threadId);
      }
      return ownerState(threadId);
    },

    async share_stop({ threadId }) {
      const shares = await readShares();
      const share = shares.find((candidate) => candidate.threadId === threadId);
      if (share) {
        endSessionsForShare(share.id, "The host stopped sharing.");
        await writeShares(shares.filter((candidate) => candidate.id !== share.id));
        await reconcileGateway();
      }
      ownerPresence.delete(threadId);
      return ownerState(threadId);
    },

    async shares_list() {
      const out = [];
      for (const share of await readShares()) {
        let title = "Untitled thread";
        try {
          title = (await bb.sdk.threads.get({ threadId: share.threadId })).title ?? title;
        } catch {
          // A missing thread still lists, so the user can see it is shared.
        }
        out.push({ threadId: share.threadId, title, access: share.access, guests: sessionsForThread(share.threadId).length });
      }
      return { shares: out };
    },

    async kick({ threadId, participantId }) {
      const session = sessionsForThread(threadId).find((candidate) => candidate.participantId === participantId);
      if (!session) return { removed: false };
      endSession(session.token, "The host removed you from this share.");
      return { removed: true };
    },

    owner_view({ threadId, view }) {
      const current = ownerPresence.get(threadId) ?? emptyPresence();
      ownerPresence.set(threadId, { ...current, view });
      broadcastView(threadId, OWNER_ID, view);
      return null;
    },

    owner_selection({ threadId, selection }) {
      const current = ownerPresence.get(threadId) ?? emptyPresence();
      ownerPresence.set(threadId, { ...current, selection });
      broadcastSelection(threadId, OWNER_ID, selection);
      return null;
    },

    owner_cursor({ threadId, region, cursor }) {
      const current = ownerPresence.get(threadId) ?? emptyPresence();
      ownerPresence.set(threadId, { ...current, region, cursor });
      broadcastCursor(threadId, OWNER_ID, region, cursor);
      return null;
    },
  });

  // Bring the gateway back for shares that survived a restart or reload.
  bb.background.service("gateway", {
    async start(signal) {
      await reconcileGateway();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
}
