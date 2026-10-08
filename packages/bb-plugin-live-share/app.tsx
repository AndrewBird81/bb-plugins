// Live Share frontend.
//
// - Thread header: a Share pill that opens a menu to start, manage, and stop
//   sharing the thread.
// - App overlay: while a thread is shared, a red frame around the window makes that
//   impossible to miss, and guests' cursors are drawn over
//   BB's own thread view, and the host's pointer is sent to the guests. Both
//   sides anchor cursors to BB's `data-timeline-row-id` rows.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useBbContext, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import {
  accessDescriptions,
  accessLabels,
  accessLevels,
  type Access,
  type Cursor,
  type Participant,
  type PanelRegion,
  type Region,
  type Selection,
  type View,
} from "./src/shared";
import type { GatewayStatus } from "./src/contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  applyScrollPoint,
  createHighlightPainter,
  cursorOver,
  isAtBottom,
  readScrollPoint,
  scrollRatio,
  watchIntent,
  cursorPoint,
  readSelection,
  scrollViewportOf,
  type Locator,
  type Resolver,
} from "./src/sync-dom";

const CURSOR_INTERVAL_MS = 50;
const ROW_SELECTOR = "[data-timeline-row-id]";

type OwnerState = {
  share: {
    id: string;
    threadId: string;
    access: Access;
    createdAt: number;
    link: string | null;
    password: string | null;
  } | null;
  gateway: GatewayStatus;
  participants: Participant[];
  me: { name: string; color: string };
};

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Could not copy to the clipboard");
  }
}

function applyCursor(participants: Participant[], id: string, region: Region | null, cursor: Cursor): Participant[] {
  return participants.map((participant) => (participant.id === id ? { ...participant, region, cursor } : participant));
}

/** Who the host is following, shared by the header menu, overlay, and frame. */
type Follow = { threadId: string; id: string; name: string; color: string } | null;
const followStore = (() => {
  let value: Follow = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: Follow) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();

function useFollow(threadId: string | null): Follow {
  const follow = useSyncExternalStore(followStore.subscribe, followStore.get);
  return follow && follow.threadId === threadId ? follow : null;
}

/** The share, gateway, and people for one thread, kept live over realtime. */
function useOwnerState(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<OwnerState | null>(null);
  const refetch = useCallback(() => {
    rpc.call("state", { threadId }).then(setState, () => undefined);
  }, [rpc, threadId]);
  useEffect(refetch, [refetch]);
  useRealtime("gateway", refetch);
  useRealtime("shares", refetch);
  useRealtime(`presence:${threadId}`, (payload) => {
    const participants = (payload as { participants?: Participant[] } | null)?.participants;
    if (participants) setState((current) => (current ? { ...current, participants } : current));
  });
  useRealtime(`view:${threadId}`, (payload) => {
    const event = payload as { participantId: string; view: View };
    setState((current) =>
      current
        ? {
            ...current,
            participants: current.participants.map((participant) =>
              participant.id === event.participantId ? { ...participant, view: event.view } : participant,
            ),
          }
        : current,
    );
  });
  useRealtime(`selection:${threadId}`, (payload) => {
    const event = payload as { participantId: string; selection: Selection };
    setState((current) =>
      current
        ? {
            ...current,
            participants: current.participants.map((participant) =>
              participant.id === event.participantId ? { ...participant, selection: event.selection } : participant,
            ),
          }
        : current,
    );
  });
  useRealtime(`cursor:${threadId}`, (payload) => {
    const event = payload as { participantId: string; region: Region | null; cursor: Cursor };
    setState((current) =>
      current ? { ...current, participants: applyCursor(current.participants, event.participantId, event.region, event.cursor) } : current,
    );
  });
  // Poll while the tunnel comes up; signals cover the rest.
  const connecting = Boolean(state?.share) && state?.gateway.tunnel === "connecting";
  useEffect(() => {
    if (!connecting) return;
    const timer = setInterval(refetch, 3_000);
    return () => clearInterval(timer);
  }, [connecting, refetch]);
  return { rpc, state, setState };
}

// --------------------------------------------------------- share menu

/** A row in BB's dropdown-menu style. */
function MenuItem({
  children,
  onSelect,
  checked,
  destructive,
  className,
}: {
  children: ReactNode;
  onSelect(): void;
  checked?: boolean;
  destructive?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-[0.3125rem] text-left text-xs outline-none hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover",
        destructive && "text-destructive hover:text-destructive",
        className,
      )}
    >
      {checked !== undefined ? (
        <span className="mt-px flex size-3.5 shrink-0 items-center justify-center">
          {checked ? <Icon name="Check" className="size-3.5" /> : null}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 py-[0.3125rem] text-xs font-normal text-muted-foreground">{children}</div>;
}

function MenuSeparator() {
  return <div role="separator" className="-mx-1 my-1 h-px bg-muted" />;
}

function AccessItems({ value, onChange }: { value: Access; onChange(access: Access): void }) {
  return (
    <>
      {accessLevels.map((level) => (
        <MenuItem key={level} checked={value === level} onSelect={() => onChange(level)}>
          <span className="block">{accessLabels[level]}</span>
          <span className="block text-[11px] leading-snug text-muted-foreground">{accessDescriptions[level]}</span>
        </MenuItem>
      ))}
    </>
  );
}

const fieldClass =
  "h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring";

function tunnelLine(gateway: GatewayStatus): string {
  if (!gateway.running) return "Starting the share gateway…";
  if (gateway.exposure === "local") return "Local only. The link works on this machine.";
  switch (gateway.tunnel) {
    case "connecting":
      return "Opening an encrypted tunnel. The first time takes about 40 seconds.";
    case "connected":
      return "End-to-end encrypted. Guests open the link in any browser.";
    case "reconnecting":
      return "Reconnecting the tunnel…";
    case "error":
      return `Tunnel error: ${gateway.error ?? "unknown"}. Retrying.`;
    default:
      return "Tunnel off.";
  }
}

function StartSharing({ threadId, onState }: { threadId: string; onState(state: OwnerState): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [access, setAccess] = useState<Access>("message");
  const [password, setPassword] = useState(generatePassword);
  const [busy, setBusy] = useState(false);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      onState(await rpc.call("share_start", { threadId, access, password }));
      await copy(password, "Password");
    } catch (cause) {
      toast.error(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={start}>
      <MenuLabel>Share this thread</MenuLabel>
      <AccessItems value={access} onChange={setAccess} />
      <MenuSeparator />
      <MenuLabel>Password</MenuLabel>
      <div className="flex items-center gap-1 px-2 pb-1">
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-label="Password"
          minLength={6}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          className={fieldClass}
        />
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="New password" onClick={() => setPassword(generatePassword())}>
          <Icon name="RotateCcw" className="size-3.5" />
        </Button>
      </div>
      <div className="px-2 pb-1 pt-1">
        <Button type="submit" size="sm" className="h-7 w-full" disabled={busy || password.length < 6}>
          {busy ? "Starting…" : "Start sharing"}
        </Button>
      </div>
    </form>
  );
}

function ManageSharing({ threadId, state, onState }: { threadId: string; state: OwnerState; onState(state: OwnerState): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const share = state.share!;
  const [changingPassword, setChangingPassword] = useState(false);
  const [password, setPassword] = useState("");
  const guests = state.participants.filter((participant) => participant.role === "guest");
  const followed = useFollow(threadId);

  const run = (work: Promise<OwnerState>, done?: string) =>
    work.then(
      (next) => {
        onState(next);
        if (done) toast.success(done);
      },
      (cause) => toast.error(message(cause)),
    );

  return (
    <>
      <div className="flex items-center gap-2 px-2 py-[0.3125rem] text-xs">
        <span className="size-1.5 shrink-0 rounded-full bg-red-500" />
        <span className="font-medium text-foreground">Sharing is on</span>
        <span className="text-muted-foreground">· {accessLabels[share.access]}</span>
      </div>
      <div className="flex items-center gap-1 px-2 pb-1">
        <input readOnly value={share.link ?? ""} placeholder="Waiting for the tunnel…" aria-label="Share link" className={fieldClass} onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Copy link" disabled={!share.link} onClick={() => share.link && void copy(linkWithPassword(share.link, share.password), "Link")}>
          <Icon name="Copy" className="size-3.5" />
        </Button>
      </div>
      <PasswordRow
        password={share.password}
        onReset={() => {
          const next = generatePassword();
          void run(rpc.call("share_update", { threadId, password: next })).then(() =>
            copy(share.link ? linkWithPassword(share.link, next) : next, share.link ? "New link" : "New password"),
          );
        }}
      />
      <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground">{tunnelLine(state.gateway)}</p>
      {share.link && share.password ? (
        <MenuItem onSelect={() => void copy(share.link!, "Link without password")}>Copy link without password</MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuLabel>Access</MenuLabel>
      <AccessItems
        value={share.access}
        onChange={(access) => {
          if (access !== share.access) void run(rpc.call("share_update", { threadId, access }));
        }}
      />
      <MenuSeparator />
      <MenuLabel>{guests.length === 0 ? "Nobody has joined yet" : "People"}</MenuLabel>
      {guests.map((guest) => (
        <div key={guest.id} className="group/person flex items-center gap-2 rounded-sm px-2 py-[0.3125rem] text-xs hover:bg-state-hover">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: guest.color }} />
          <span className="min-w-0 flex-1 truncate">{guest.name}</span>
          <button
            type="button"
            aria-pressed={followed?.id === guest.id}
            className="text-muted-foreground hover:text-foreground aria-pressed:font-medium aria-pressed:text-foreground"
            onClick={() =>
              followStore.set(followed?.id === guest.id ? null : { threadId, id: guest.id, name: guest.name, color: guest.color })
            }
          >
            {followed?.id === guest.id ? "Following" : "Follow"}
          </button>
          <button
            type="button"
            className="text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/person:opacity-100"
            onClick={() =>
              void rpc.call("kick", { threadId, participantId: guest.id }).then(
                () => toast.success(`Removed ${guest.name}`),
                (cause) => toast.error(message(cause)),
              )
            }
          >
            Remove
          </button>
        </div>
      ))}
      <MenuSeparator />
      {changingPassword ? (
        <form
          className="flex items-center gap-1 px-2 py-1"
          onSubmit={(event) => {
            event.preventDefault();
            void run(rpc.call("share_update", { threadId, password }), "Password changed. Guests must enter the new one.").then(() => {
              setPassword("");
              setChangingPassword(false);
            });
          }}
        >
          <input autoFocus value={password} onChange={(event) => setPassword(event.target.value)} placeholder="New password" aria-label="New password" minLength={6} autoComplete="off" className={fieldClass} />
          <Button type="submit" size="sm" className="h-7" disabled={password.length < 6}>
            Save
          </Button>
        </form>
      ) : (
        <MenuItem onSelect={() => setChangingPassword(true)}>Change password…</MenuItem>
      )}
      <MenuItem destructive onSelect={() => void run(rpc.call("share_stop", { threadId }), "Stopped sharing")}>
        Stop sharing
      </MenuItem>
    </>
  );
}

/**
 * The share link with the password in its fragment. Browsers do not send the
 * fragment to servers, so it never reaches the relay; the guest page reads it.
 */
function linkWithPassword(link: string, password: string | null): string {
  return password ? `${link}#p=${encodeURIComponent(password)}` : link;
}

function PasswordRow({ password, onReset }: { password: string | null; onReset(): void }) {
  const [visible, setVisible] = useState(false);
  if (!password) {
    // Shares started before passwords were kept have only a hash to show.
    return (
      <div className="flex items-center gap-1 px-2 pb-1">
        <input readOnly disabled value="••••••••" aria-label="Password" className={fieldClass} />
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onReset}>
          New password
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      <input
        readOnly
        type={visible ? "text" : "password"}
        value={password}
        aria-label="Password"
        className={fieldClass}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        onClick={() => setVisible((value) => !value)}
      >
        <Icon name="Eye" className="size-3.5" />
      </Button>
      <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Copy password" onClick={() => void copy(password, "Password")}>
        <Icon name="Copy" className="size-3.5" />
      </Button>
    </div>
  );
}

function ShareMenu({ threadId }: { threadId: string; projectId?: string | null; isCompactViewport?: boolean }) {
  const { state, setState } = useOwnerState(threadId);
  const follow = useFollow(threadId);
  const sharing = Boolean(state?.share);
  const guests = state?.participants.filter((participant) => participant.role === "guest") ?? [];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={sharing ? `Live Share: ${guests.length} joined` : "Share this thread"}
          className={cn(
            "flex h-7 min-w-0 max-w-56 items-center gap-1.5 rounded-md border pl-2 pr-1.5 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
            sharing
              ? "border-red-600 bg-red-600 font-medium text-white hover:bg-red-500"
              : "border-border bg-background text-muted-foreground hover:bg-state-hover hover:text-foreground data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
        >
          {sharing && guests.length > 0 ? (
            <span className="flex items-center">
              {guests.slice(0, 3).map((guest, index) => (
                <span
                  key={guest.id}
                  className={cn("grid size-4 place-items-center rounded-full text-[9px] font-semibold uppercase text-white ring-1 ring-background", index > 0 && "-ml-1")}
                  style={{ backgroundColor: guest.color }}
                >
                  {guest.name.slice(0, 1)}
                </span>
              ))}
            </span>
          ) : sharing ? (
            <LiveDot />
          ) : (
            <Icon name="UserRoundPlus" className="size-4 shrink-0" />
          )}
          <span className="truncate">
            {follow ? `Following ${follow.name}` : sharing ? (guests.length > 0 ? `Live · ${guests.length}` : "Live") : "Share"}
          </span>
          <Icon name="ChevronDown" className="size-4 shrink-0 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        {!state ? (
          <MenuLabel>Loading…</MenuLabel>
        ) : state.share ? (
          <ManageSharing threadId={threadId} state={state} onState={setState} />
        ) : (
          <StartSharing threadId={threadId} onState={setState} />
        )}
      </PopoverContent>
    </Popover>
  );
}

// ------------------------------------------------- cursors on the thread
//
// BB's thread page has two shared surfaces: the timeline (rows carry
// `data-timeline-row-id`) and the right panel. In the panel, the Info tab's
// rows are anchored by their label and the Diff tab's file cards by path;
// anywhere else in the panel, a cursor is a fraction of the panel's box.

const PANEL_SELECTOR = "aside:has([data-testid='thread-secondary-panel-top-chrome'])";
const FILE_TOGGLE = 'button[aria-label^="Expand "], button[aria-label^="Collapse "]';
const FILE_CARD = "div.overflow-clip.rounded-lg";

function rightPanel(): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(PANEL_SELECTOR)) {
    if (element.getBoundingClientRect().width > 0) return element;
  }
  return null;
}

/** The panel tab BB is showing, as a shared region; null for tabs guests do not have. */
const TAB_STRIP = '[data-testid="secondary-panel-tab-strip"]';

/** Content tabs (files, VS Code, terminals…) in BB's panel tab strip, by title. */
function contentTabs(panel: HTMLElement): Array<{ button: HTMLElement; title: string }> {
  return [...panel.querySelectorAll<HTMLElement>(`${TAB_STRIP} button[aria-pressed]`)].flatMap((button) => {
    const title = button.innerText.trim();
    return title ? [{ button, title }] : [];
  });
}

/** The panel tab BB is showing, as a shared region. */
function panelRegion(panel: HTMLElement): PanelRegion | null {
  if (panel.querySelector('button[aria-label="Show thread info panel"][aria-pressed="true"]')) return "info";
  if (panel.querySelector('button[aria-label^="Show diff panel"][aria-pressed="true"]')) return "changes";
  const active = contentTabs(panel).find((tab) => tab.button.getAttribute("aria-pressed") === "true");
  return active ? `tab:${active.title.slice(0, 300)}` : null;
}

function panelTabButton(panel: HTMLElement, region: PanelRegion): HTMLElement | null {
  if (region === "info") return panel.querySelector<HTMLElement>('button[aria-label="Show thread info panel"]');
  if (region === "changes") return panel.querySelector<HTMLElement>('button[aria-label^="Show diff panel"]');
  return contentTabs(panel).find((tab) => `tab:${tab.title.slice(0, 300)}` === region)?.button ?? null;
}

function infoRow(panel: HTMLElement, label: string): HTMLElement | null {
  for (const dt of panel.querySelectorAll<HTMLElement>("dt")) {
    if (dt.textContent?.trim() === label) return dt.closest<HTMLElement>("div.grid");
  }
  return null;
}

function visibleRow(id: string): HTMLElement | null {
  const escaped = CSS.escape(id);
  for (const element of document.querySelectorAll<HTMLElement>(`[data-timeline-row-id="${escaped}"]`)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return element;
  }
  return null;
}

const resolveHost: Resolver = (region, anchor) => {
  if (region === "transcript") return anchor ? visibleRow(anchor) : null;
  const panel = rightPanel();
  if (!panel || panelRegion(panel) !== region) return null;
  if (!anchor) return panel;
  if (anchor.startsWith("file:")) {
    const path = CSS.escape(anchor.slice("file:".length));
    return panel.querySelector<HTMLElement>(`button[aria-label="Expand ${path}"], button[aria-label="Collapse ${path}"]`)?.closest<HTMLElement>(FILE_CARD) ?? null;
  }
  if (anchor.startsWith("info:")) return infoRow(panel, anchor.slice("info:".length));
  return null;
};

function cursorFromPointer(event: PointerEvent, threadId: string): Cursor {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  const panel = target.closest<HTMLElement>(PANEL_SELECTOR);
  if (panel) {
    const region = panelRegion(panel);
    if (!region) return null;
    const card = region === "changes" ? target.closest<HTMLElement>(FILE_CARD) : null;
    const toggle = card?.querySelector(FILE_TOGGLE)?.getAttribute("aria-label");
    if (card && toggle) return cursorOver(event, region, card, `file:${toggle.replace(/^(Expand|Collapse) /u, "")}`, null, panel);
    const row = region === "info" ? target.closest<HTMLElement>("div.grid") : null;
    const label = row?.querySelector("dt")?.textContent?.trim();
    if (row && label) return cursorOver(event, region, row, `info:${label}`, null, panel);
    return cursorOver(event, region, panel, null);
  }
  const prefix = `${threadId}:`;
  let row = target.closest<HTMLElement>(ROW_SELECTOR);
  if (row && !row.dataset.timelineRowId?.startsWith(prefix)) row = null;
  if (!row) {
    // Between rows, anchor to the nearest row of this thread's timeline.
    const scroller = target.closest<HTMLElement>(".thread-scrollbar");
    if (!scroller) return null;
    let best: { element: HTMLElement; distance: number } | null = null;
    for (const element of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      if (!element.dataset.timelineRowId?.startsWith(prefix) || element.parentElement?.closest(ROW_SELECTOR)) continue;
      const rect = element.getBoundingClientRect();
      const distance = event.clientY < rect.top ? rect.top - event.clientY : Math.max(0, event.clientY - rect.bottom);
      if (!best || distance < best.distance) best = { element, distance };
    }
    row = best?.element ?? null;
  }
  if (!row) return null;
  const parent = row.parentElement?.closest<HTMLElement>(ROW_SELECTOR);
  return cursorOver(event, "transcript", row, row.dataset.timelineRowId ?? null, parent?.dataset.timelineRowId ?? null);
}

/** Selections are shared on the timeline, where both sides render the same text. */
function hostLocator(threadId: string): Locator {
  return (node) => {
    const element = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(ROW_SELECTOR);
    const anchor = element?.dataset.timelineRowId;
    if (!element || !anchor?.startsWith(`${threadId}:`)) return null;
    return { region: "transcript", element, anchor };
  };
}


function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

function timelineRows(threadId: string): HTMLElement[] {
  const prefix = `${threadId}:`;
  return [...document.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter(
    (row) => row.dataset.timelineRowId?.startsWith(prefix) && !row.parentElement?.closest(ROW_SELECTOR),
  );
}

/** The right-panel items a follower can scroll to: info rows or file cards. */
function panelItems(panel: HTMLElement, region: Region): Array<{ element: HTMLElement; id: string }> {
  if (region !== "info" && region !== "changes") return [];
  if (region === "info") {
    return [...panel.querySelectorAll<HTMLElement>("div.grid")].flatMap((element) => {
      const label = element.querySelector("dt")?.textContent?.trim();
      return label ? [{ element, id: `info:${label}` }] : [];
    });
  }
  return [...panel.querySelectorAll<HTMLElement>(FILE_CARD)].flatMap((element) => {
    const toggle = element.querySelector(FILE_TOGGLE)?.getAttribute("aria-label");
    return toggle ? [{ element, id: `file:${toggle.replace(/^(Expand|Collapse) /u, "")}` }] : [];
  });
}

/** What the host is looking at in BB, in the same shape the guest page sends. */
function readHostView(threadId: string): View {
  const rows = timelineRows(threadId);
  const scroller = rows[0]?.closest<HTMLElement>(".thread-scrollbar") ?? null;
  const panel = rightPanel();
  const region = panel ? panelRegion(panel) : null;
  const panelView = region;
  let panelTop = null;
  if (panel && panelView) {
    const items = panelItems(panel, panelView);
    const panelScroller = items[0] ? scrollParent(items[0].element) : null;
    const ids = new Map(items.map((item) => [item.element, item.id]));
    if (panelScroller) panelTop = readScrollPoint(panelScroller, ids.keys(), (element) => ids.get(element) ?? null);
  }
  return {
    panel: panelView,
    top: scroller ? readScrollPoint(scroller, rows, (row) => row.dataset.timelineRowId ?? null) : null,
    ratio: scroller ? scrollRatio(scroller) : null,
    atBottom: scroller ? isAtBottom(scroller) : true,
    panelTop,
  };
}

/** Moves BB's own view to match a followed guest's. */
function applyHostView(threadId: string, view: NonNullable<View>): void {
  if (view.panel) {
    let panel = rightPanel();
    if (!panel) {
      document.querySelector<HTMLElement>('button[aria-label^="Show right panel"]')?.click();
      panel = rightPanel();
    }
    if (panel && panelRegion(panel) !== view.panel) panelTabButton(panel, view.panel)?.click();
    if (panel && view.panelTop && panelRegion(panel) === view.panel) {
      const item = panelItems(panel, view.panel).find((candidate) => candidate.id === view.panelTop!.anchor);
      const panelScroller = item ? scrollParent(item.element) : null;
      if (item && panelScroller) applyScrollPoint(panelScroller, item.element, view.panelTop.fraction);
    }
  }
  const rows = timelineRows(threadId);
  const scroller = rows[0]?.closest<HTMLElement>(".thread-scrollbar");
  if (!scroller) return;
  if (view.atBottom) {
    scroller.scrollTop = scroller.scrollHeight;
  } else if (view.top) {
    // BB pins an idle timeline to the bottom until it sees a scroll gesture;
    // a tiny synthetic wheel releases that pin before following moves it.
    if (isAtBottom(scroller)) scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
    // BB renders only nearby rows. For one out of range, jump to the same
    // overall position first; the next pass finds the row and lands exactly.
    const row = visibleRow(view.top.anchor);
    if (row) applyScrollPoint(scroller, row, view.top.fraction);
    else if (view.ratio !== null) scroller.scrollTop = view.ratio * (scroller.scrollHeight - scroller.clientHeight);
  }
}

/** Throttled, de-duplicated sender for one kind of presence update. */
function useSender<T>(send: (value: T) => void, interval: number) {
  const latest = useRef(send);
  latest.current = send;
  return useRef(
    (() => {
      let last: string | undefined;
      let pending: { value: T } | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      return (value: T) => {
        pending = { value };
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          const next = pending;
          pending = null;
          if (!next) return;
          const key = JSON.stringify(next.value);
          if (key === last) return;
          last = key;
          latest.current(next.value);
        }, interval);
      };
    })(),
  ).current;
}

function ThreadCursors({ threadId }: { threadId: string }) {
  const { rpc, state } = useOwnerState(threadId);
  const shared = Boolean(state?.share);
  const participants = state?.participants ?? [];
  const guests = participants.filter((participant) => participant.role === "guest");
  const [, setFrame] = useState(0);

  const sendCursor = useSender<Cursor>((cursor) => {
    void rpc.call("owner_cursor", { threadId, region: cursor?.region ?? null, cursor }).catch(() => undefined);
  }, CURSOR_INTERVAL_MS);
  const sendSelection = useSender<Selection>((selection) => {
    void rpc.call("owner_selection", { threadId, selection }).catch(() => undefined);
  }, 120);

  // Send the host's pointer and text selection.
  useEffect(() => {
    if (!shared) return;
    const locate = hostLocator(threadId);
    const onMove = (event: PointerEvent) => sendCursor(cursorFromPointer(event, threadId));
    const onLeave = () => sendCursor(null);
    const onSelection = () => sendSelection(readSelection(locate));
    document.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("selectionchange", onSelection);
      void rpc.call("owner_cursor", { threadId, region: null, cursor: null }).catch(() => undefined);
      void rpc.call("owner_selection", { threadId, selection: null }).catch(() => undefined);
    };
  }, [shared, rpc, threadId, sendCursor, sendSelection]);

  // Share the host's view so guests can follow it.
  useEffect(() => {
    if (!shared) return;
    let last = "";
    const timer = setInterval(() => {
      const view = readHostView(threadId);
      const key = JSON.stringify(view);
      if (key === last) return;
      last = key;
      void rpc.call("owner_view", { threadId, view }).catch(() => undefined);
    }, 300);
    return () => {
      clearInterval(timer);
      void rpc.call("owner_view", { threadId, view: null }).catch(() => undefined);
    };
  }, [shared, rpc, threadId]);

  // Follow a guest until the host scrolls or clicks on their own.
  const follow = useFollow(threadId);
  const leader = follow ? guests.find((guest) => guest.id === follow.id) : undefined;
  useEffect(() => {
    if (follow && state && !leader) followStore.set(null);
  }, [follow, state, leader]);
  useEffect(() => {
    if (!follow) return;
    // Let the click that started following finish before watching for intent.
    let stop: (() => void) | null = null;
    const timer = setTimeout(() => {
      stop = watchIntent(document, () => followStore.set(null));
    }, 300);
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }, [follow]);
  const leaderView = leader?.view ?? null;
  useLayoutEffect(() => {
    if (!leaderView) return;
    applyHostView(threadId, leaderView);
    // Tab switches and far jumps render over the next frames; settle then.
    let frame = 0;
    let passes = 0;
    const settle = () => {
      applyHostView(threadId, leaderView);
      if (++passes < 6) frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [threadId, leaderView]);
  useEffect(() => () => followStore.set(null), []);

  // Paint guests' selections. BB re-renders and virtualizes rows, so repaint
  // on a short timer while anyone has a selection.
  const selections = guests.filter((guest) => guest.selection);
  const selectionKey = JSON.stringify(selections.map((guest) => [guest.id, guest.selection]));
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
  useEffect(() => {
    if (!shared) return;
    const painter = createHighlightPainter("ls-host");
    const paint = () => painter.paint(participantsRef.current, "owner", resolveHost);
    paint();
    const timer = selectionKey === "[]" ? null : setInterval(paint, 300);
    return () => {
      if (timer) clearInterval(timer);
      painter.dispose();
    };
  }, [shared, selectionKey]);

  // Rows move as BB scrolls and streams, so repaint cursors every frame while
  // a guest cursor is on screen.
  const active = shared && guests.some((guest) => guest.cursor);
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const loop = () => {
      setFrame((value) => (value + 1) % 1_000_000);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  if (!active) return null;
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[60]">
      {guests.map((guest) => {
        const point = cursorPoint(guest, resolveHost, scrollViewportOf);
        if (!point) return null;
        return (
          <div key={guest.id} className="absolute left-0 top-0" style={{ transform: `translate(${point.x}px, ${point.y}px)` }}>
            <svg width="16" height="20" viewBox="0 0 16 20" className="drop-shadow-sm">
              <path d="M1 1 L1 16 L5 12 L8 19 L11 17.8 L8 11 L14 11 Z" fill={guest.color} stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span
              className="absolute left-3.5 top-4 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-none text-white shadow-sm"
              style={{ backgroundColor: guest.color }}
            >
              {guest.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function LiveDot() {
  return (
    <span className="relative flex size-2 shrink-0">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75" />
      <span className="relative inline-flex size-2 rounded-full bg-white" />
    </span>
  );
}

type ShareSummary = { threadId: string; title: string; access: Access; guests: number };

function useShares() {
  const rpc = useRpc<typeof rpcContract>();
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const refetch = useCallback(() => {
    rpc.call("shares_list").then((result) => setShares(result.shares), () => undefined);
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("shares", refetch);
  return { rpc, shares };
}

/**
 * While the open thread is shared: a red frame around the window, like a
 * screen-share indicator.
 * Elsewhere: a badge that says how many threads are shared.
 */
function SharingIndicator({ threadId }: { threadId: string | null }) {
  const { shares } = useShares();
  const navigate = useBbNavigate();
  const follow = useFollow(threadId);
  if (shares.length === 0) return null;
  const current = threadId ? shares.find((share) => share.threadId === threadId) : undefined;
  const pill =
    "pointer-events-auto flex items-center gap-2 rounded-full bg-red-600 py-1 pl-2.5 pr-1 text-xs font-medium text-white shadow-lg ring-1 ring-red-700/50";
  if (current) {
    // Only a frame: anything floating here would cover the header's controls.
    // The red Live pill in the header carries the details and Stop.
    // While following a guest, the frame takes their color.
    return (
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[70] border-[3px] border-red-600"
        style={follow ? { borderColor: follow.color } : undefined}
      />
    );
  }
  const first = shares[0]!;
  return (
    <div className="pointer-events-none fixed bottom-3 left-1/2 z-[70] -translate-x-1/2">
      <button type="button" className={cn(pill, "pr-2.5")} onClick={() => navigate.toThread(first.threadId)}>
        <LiveDot />
        {shares.length === 1 ? `Sharing “${first.title}”` : `Sharing ${shares.length} threads`}
      </button>
    </div>
  );
}

function CursorOverlay() {
  const { threadId } = useBbContext();
  return (
    <>
      <SharingIndicator threadId={threadId ?? null} />
      {threadId ? <ThreadCursors key={threadId} threadId={threadId} /> : null}
    </>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "share",
    title: "Live Share",
    component: ShareMenu,
  });
  app.slots.experimental_appOverlay({
    id: "cursors",
    component: CursorOverlay,
  });
});
