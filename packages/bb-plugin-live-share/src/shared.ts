// Wire types shared by the server, the guest page, and the app.
// Everything that crosses the tunnel is parsed with these schemas on arrival.
import { z } from "zod";

import { accessLevels } from "./access.js";

export { accessDescriptions, accessLabels, accessLevels, canControl, canSend, type Access } from "./access.js";

export const accessSchema = z.enum(accessLevels);

/**
 * Where a cursor or selection is: the conversation, BB's Info or Diff tab, or
 * another right-panel tab named by its title (`tab:package.json`).
 */
export const tabRegionSchema = z.string().regex(/^tab:.{1,300}$/u) as z.ZodType<`tab:${string}`>;
export const panelRegionSchema = z.union([z.enum(["changes", "info"]), tabRegionSchema]);
export type PanelRegion = z.infer<typeof panelRegionSchema>;
export const regionSchema = z.union([z.literal("transcript"), panelRegionSchema]);
export type Region = z.infer<typeof regionSchema>;

/**
 * A cursor is anchored to an element both sides render (a timeline row, a
 * changed file, or an info row), so it lands on the same content even when
 * the two windows have different sizes. `fx`/`fy` are fractions of that
 * element's box; `fy` may run a little past it when the pointer sits in the
 * gap between rows. With no anchor, they are fractions of the region itself
 * (the right panel, for instance).
 * `parent` names the enclosing row for a nested one (a tool inside an
 * expanded summary), so the other side can fall back to it.
 */
export const cursorSchema = z
  .object({
    region: regionSchema,
    anchor: z.string().max(1_000).nullable(),
    parent: z.string().max(1_000).nullable().default(null),
    fx: z.number().min(0).max(1),
    fy: z.number().min(-2).max(3),
    // Position within the whole region (the right panel), used when the other
    // side does not have the anchor, such as a file only one side lists.
    px: z.number().min(0).max(1).nullable().default(null),
    py: z.number().min(0).max(1).nullable().default(null),
  })
  .strict()
  .nullable();
export type Cursor = z.infer<typeof cursorSchema>;

const textPointSchema = z
  .object({
    anchor: z.string().max(1_000),
    offset: z.number().int().min(0).max(1_000_000),
  })
  .strict();

/**
 * A text selection, as character offsets into the text of the anchored
 * elements (the message body for a timeline row), so both sides can rebuild
 * the same range and highlight it.
 */
export const selectionSchema = z
  .object({ region: regionSchema, start: textPointSchema, end: textPointSchema })
  .strict()
  .nullable();
export type Selection = z.infer<typeof selectionSchema>;
export type TextPoint = z.infer<typeof textPointSchema>;

/** A scroll position: which anchored element is at the top, and how far into it. */
const scrollPointSchema = z
  .object({ anchor: z.string().max(1_000), fraction: z.number().min(-50).max(50) })
  .strict()
  .nullable();
export type ScrollPoint = z.infer<typeof scrollPointSchema>;

/** What someone is looking at, so others can follow them. */
export const viewSchema = z
  .object({
    panel: panelRegionSchema.nullable(),
    top: scrollPointSchema,
    // How far down the conversation is scrolled (0–1), for when the other
    // side has not rendered the top row (BB renders only nearby rows).
    ratio: z.number().min(0).max(1).nullable().default(null),
    atBottom: z.boolean(),
    panelTop: scrollPointSchema,
  })
  .strict()
  .nullable();
export type View = z.infer<typeof viewSchema>;

export const participantSchema = z
  .object({
    id: z.string().max(64),
    name: z.string().max(64),
    color: z.string().max(16),
    role: z.enum(["owner", "guest"]),
    access: accessSchema,
    region: regionSchema.nullable(),
    cursor: cursorSchema,
    selection: selectionSchema.default(null),
    view: viewSchema.default(null),
  })
  .strict();
export type Participant = z.infer<typeof participantSchema>;

export const workItemSchema = z
  .object({
    id: z.string().max(400),
    title: z.string().max(2_000),
    detail: z.string().max(40_000),
    duration: z.string().max(32).nullable(),
    status: z.string().max(32).nullable(),
  })
  .strict();
export type WorkItem = z.infer<typeof workItemSchema>;

export const rowSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("message"),
      id: z.string().max(400),
      role: z.enum(["user", "assistant"]),
      text: z.string().max(40_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("work"),
      id: z.string().max(1_000),
      label: z.string().max(400),
      pending: z.boolean(),
      items: z.array(workItemSchema).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("note"),
      id: z.string().max(400),
      title: z.string().max(2_000),
      text: z.string().max(40_000),
      tone: z.enum(["muted", "error"]),
    })
    .strict(),
]);
export type Row = z.infer<typeof rowSchema>;

export const snapshotSchema = z
  .object({
    shareId: z.string().nullable(),
    threadId: z.string(),
    title: z.string(),
    status: z.string(),
    maxSeq: z.number(),
    access: accessSchema,
    hasOlderRows: z.boolean(),
    rows: z.array(rowSchema).max(400),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

export const changedFileSchema = z
  .object({
    path: z.string().max(2_000),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string(),
  })
  .strict();
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const changesSchema = z
  .object({
    scope: z.enum(["all", "uncommitted"]).default("uncommitted"),
    available: z.boolean(),
    message: z.string().nullable(),
    shortstat: z.string(),
    truncated: z.boolean(),
    files: z.array(changedFileSchema).max(500),
  })
  .strict();
export type Changes = z.infer<typeof changesSchema>;

/** Messages the owner sends to a guest over the session socket. */
export const serverMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      participantId: z.string(),
      access: accessSchema,
      participants: z.array(participantSchema).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("participants"),
      participants: z.array(participantSchema).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("cursor"),
      participantId: z.string(),
      region: regionSchema.nullable(),
      cursor: cursorSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("selection"), participantId: z.string(), selection: selectionSchema })
    .strict(),
  z.object({ type: z.literal("view"), participantId: z.string(), view: viewSchema }).strict(),
  z
    .object({ type: z.literal("thread"), maxSeq: z.number(), status: z.string() })
    .strict(),
  z.object({ type: z.literal("access"), access: accessSchema }).strict(),
  z.object({ type: z.literal("ended"), reason: z.string().max(200) }).strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** Messages a guest sends to the owner over the session socket. */
export const clientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("cursor"),
      region: regionSchema.nullable(),
      cursor: cursorSchema,
    })
    .strict(),
  z.object({ type: z.literal("selection"), selection: selectionSchema }).strict(),
  z.object({ type: z.literal("view"), view: viewSchema }).strict(),
  z.object({ type: z.literal("ping") }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** The host's right-panel tabs, as the guest page mirrors them. */
export const panelTabSchema = z
  .object({
    region: panelRegionSchema,
    title: z.string().max(300),
    // "file": a file the host opened, shown read-only. "other": a tab only
    // the host can see, such as VS Code, a terminal, or a browser.
    // "vscode": the studio-code VS Code tab, mirrored read-only.
    kind: z.enum(["info", "diff", "file", "vscode", "other"]),
    path: z.string().max(2_000).nullable(),
  })
  .strict();
export type PanelTab = z.infer<typeof panelTabSchema>;

export const fileSchema = z
  .object({ path: z.string(), content: z.string(), truncated: z.boolean(), binary: z.boolean() })
  .strict();
export type FileView = z.infer<typeof fileSchema>;

const editorLine = z.number().int().min(1);

/** The host's VS Code editor, mirrored read-only. Paths are workspace-relative. */
export const editorMirrorSchema = z
  .object({
    available: z.boolean(),
    message: z.string().nullable(),
    focused: z.boolean(),
    openFiles: z.array(z.string().max(4_096)).max(50),
    file: z
      .object({
        path: z.string().max(4_096),
        language: z.string().max(100),
        unsaved: z.boolean(),
        selection: z.object({ startLine: editorLine, startColumn: editorLine, endLine: editorLine, endColumn: editorLine }).strict(),
        visible: z.object({ startLine: editorLine, endLine: editorLine }).strict().nullable(),
        hash: z.string().max(64),
        // Omitted when it matches the hash the guest already has.
        content: z.string().nullable(),
        reason: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type EditorMirror = z.infer<typeof editorMirrorSchema>;

/** The guest's Info tab: the safe subset of BB's thread info panel. */
export const infoSchema = z
  .object({
    project: z.string().nullable(),
    environment: z.string().nullable(),
    branch: z.string().nullable(),
    mergeBase: z.string().nullable(),
    gitStatus: z.string().nullable(),
    status: z.string(),
    files: z
      .array(
        z
          .object({ path: z.string().max(2_000), status: z.string().max(8), additions: z.number(), deletions: z.number() })
          .strict(),
      )
      .max(500),
    additions: z.number(),
    deletions: z.number(),
  })
  .strict();
export type Info = z.infer<typeof infoSchema>;

export const loginResponseSchema = z
  .object({
    sessionToken: z.string().min(16).max(200),
    participantId: z.string(),
    access: accessSchema,
    title: z.string(),
    hostName: z.string(),
  })
  .strict();
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const cursorColors = [
  "#e5484d",
  "#3e63dd",
  "#30a46c",
  "#f76b15",
  "#8e4ec6",
  "#12a594",
  "#d6409f",
  "#ffb224",
];
