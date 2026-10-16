import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type JsonValue,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  PANEL_ACTION_ID,
  PANEL_TITLE,
  PLANNOTATOR_REALTIME_CHANNEL,
} from "./src/constants";
import {
  PLANNOTATOR_RELAY_PATH,
  embeddedSessionUrl,
  iframeLoadUrl,
  sharedCookieDomain,
  upstreamOnboardingCookies,
} from "./src/embedded";
import { toast } from "sonner";
import {
  SessionLauncher,
  cancelPanelRequest,
  requestPanel,
  usePanelRequests,
  useSessionStarter,
  type PanelRequest,
} from "./src/launcher";

type PlannotatorPayload = {
  kind: "plannotator";
  sessionId: string;
  threadId: string;
  sessionUrl: string;
  relayPath: typeof PLANNOTATOR_RELAY_PATH;
  title: string;
  sessionKind?: string;
  dismissUpdateVersion?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): PlannotatorPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.kind !== "plannotator" ||
    typeof value.sessionId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.sessionUrl !== "string" ||
    (value.relayPath !== undefined && value.relayPath !== PLANNOTATOR_RELAY_PATH) ||
    typeof value.title !== "string" ||
    (value.dismissUpdateVersion !== undefined && typeof value.dismissUpdateVersion !== "string")
  ) {
    return null;
  }
  try {
    const url = new URL(value.sessionUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    kind: "plannotator",
    sessionId: value.sessionId,
    threadId: value.threadId,
    sessionUrl: value.sessionUrl,
    relayPath: PLANNOTATOR_RELAY_PATH,
    title: value.title,
    ...(typeof value.sessionKind === "string" ? { sessionKind: value.sessionKind } : {}),
    ...(value.dismissUpdateVersion ? { dismissUpdateVersion: value.dismissUpdateVersion } : {}),
  };
}

function parseReviewOpened(value: unknown): PlannotatorPayload | null {
  if (!isRecord(value) || value.kind !== "review-opened") return null;
  return parsePayload(value.payload);
}

function parseReviewFailed(value: unknown): { threadId: string; message: string } | null {
  if (
    !isRecord(value) ||
    value.kind !== "review-failed" ||
    typeof value.threadId !== "string" ||
    typeof value.message !== "string"
  ) {
    return null;
  }
  return { threadId: value.threadId, message: value.message };
}

function parseReviewClosed(
  value: unknown,
): { threadId: string; sessionId: string } | null {
  if (
    !isRecord(value) ||
    value.kind !== "review-closed" ||
    typeof value.threadId !== "string" ||
    typeof value.sessionId !== "string"
  ) {
    return null;
  }
  return { threadId: value.threadId, sessionId: value.sessionId };
}

/**
 * The thread's open session, from the server and kept current by realtime.
 * A thread has one Plannotator tab, without params, and it always shows this
 * session; tab params from older versions are ignored.
 */
function useActiveReview(threadId: string): PlannotatorPayload | null {
  const rpc = useRpc<typeof rpcContract>();
  const realtimeConnectionState = useRealtimeConnectionState();
  const [active, setActive] = useState<PlannotatorPayload | null>(null);

  useRealtime(PLANNOTATOR_REALTIME_CHANNEL, (value) => {
    const opened = parseReviewOpened(value);
    if (opened && opened.threadId === threadId) {
      setActive(opened);
      return;
    }
    const closed = parseReviewClosed(value);
    if (closed && closed.threadId === threadId) {
      setActive((current) =>
        current?.sessionId === closed.sessionId ? null : current,
      );
    }
  });

  useEffect(() => {
    if (realtimeConnectionState !== "connected") return;
    let cancelled = false;
    void rpc
      .call("getActiveReview", { threadId })
      .then((value) => {
        if (cancelled) return;
        const payload = parsePayload(value);
        setActive(payload && payload.threadId === threadId ? payload : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [realtimeConnectionState, rpc, threadId]);

  return active;
}

/**
 * Opens and focuses the thread's Plannotator tab when a session starts. It
 * passes no params, so bb keeps exactly one such tab per thread and focuses
 * it again for every session. Renders no control.
 */
function PlannotatorFocusBridge({
  threadId,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const realtimeConnectionState = useRealtimeConnectionState();
  const focusedSessionId = useRef<string | null>(null);

  const focusReview = useCallback(
    (value: unknown) => {
      const payload = parsePayload(value);
      if (!payload || payload.threadId !== threadId) return;
      if (focusedSessionId.current === payload.sessionId) return;

      if (navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: payload.title })) {
        focusedSessionId.current = payload.sessionId;
      }
    },
    [navigate, threadId],
  );

  useRealtime(PLANNOTATOR_REALTIME_CHANNEL, (value) => {
    const review = parseReviewOpened(value);
    if (review) focusReview(review);
  });

  // Realtime signals are intentionally ephemeral. Reconcile the durable
  // active-review record on first mount and after reconnect so a late-mounted
  // or temporarily disconnected BB client still focuses the persisted tab.
  useEffect(() => {
    if (realtimeConnectionState !== "connected") return;
    let cancelled = false;
    void rpc
      .call("getActiveReview", { threadId })
      .then((value) => {
        if (!cancelled) focusReview(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [focusReview, realtimeConnectionState, rpc, threadId]);

  return null;
}

type LoadState = "loading" | "slow" | "loaded" | "unreachable";
/** After this, a page still loading stops being covered by the spinner. */
export const LOAD_SLOW_MS = 15_000;

function PlannotatorPanel({ threadId }: PluginThreadPanelProps) {
  const payload = useActiveReview(threadId);
  const rpc = useRpc<typeof rpcContract>();
  const starter = useSessionStarter(threadId);
  const [focusFilePicker, setFocusFilePicker] = useState(false);
  usePanelRequests(threadId, (request) => {
    if (request.kind === "launch") starter.start(request.request);
    else setFocusFilePicker(true);
  });
  useRealtime(PLANNOTATOR_REALTIME_CHANNEL, (value) => {
    const failed = parseReviewFailed(value);
    if (failed && failed.threadId === threadId) starter.notify(failed.message);
  });
  const navigate = useBbNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [embeddedUrl, setEmbeddedUrl] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  // The tab shows the open session's title.
  useEffect(() => {
    if (payload) navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: payload.title });
  }, [navigate, payload?.sessionId, payload?.title]);

  // A slow link only delays the page: the review is 20+ MB. After a while,
  // stop covering whatever has rendered, and check the session is reachable
  // at all before calling it a failure.
  useEffect(() => {
    setLoadState("loading");
    if (!embeddedUrl) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoadState((state) => (state === "loading" ? "slow" : state));
      void fetch(embeddedUrl, { method: "HEAD", mode: "no-cors", cache: "no-store" }).catch(() => {
        if (!cancelled) setLoadState((state) => (state === "loaded" ? state : "unreachable"));
      });
    }, LOAD_SLOW_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [embeddedUrl, reloadKey]);

  // The upstream runtime stores its one-time dialog dismissals in cookies.
  // Prime them from BB before mounting the iframe: host-only for the relay,
  // and on the shared parent domain for a session on another tailnet host.
  // This keeps the real upstream UI while removing standalone-browser
  // onboarding from the embedded workflow.
  useLayoutEffect(() => {
    setCanceling(false);
    if (!payload) {
      setEmbeddedUrl(null);
      return;
    }

    for (const cookie of upstreamOnboardingCookies({
      domain: sharedCookieDomain(window.location.hostname, payload.sessionUrl),
      dismissUpdateVersion: payload.dismissUpdateVersion,
    })) {
      document.cookie = cookie;
    }
    setEmbeddedUrl(
      embeddedSessionUrl(payload.sessionUrl, payload.sessionId, {
        hostname: window.location.hostname,
        protocol: window.location.protocol,
        origin: window.location.origin,
      }),
    );
  }, [payload?.sessionId, payload?.sessionUrl, payload?.dismissUpdateVersion]);

  if (!payload) {
    return <SessionLauncher threadId={threadId} starter={starter} focusFilePicker={focusFilePicker} />;
  }

  if (!embeddedUrl) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-background text-xs text-muted-foreground">
        Loading Plannotator…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs">
        <div className="min-w-0 truncate text-muted-foreground" title={embeddedUrl}>
          {payload.title}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Reload
          </button>
          <a
            className="rounded border border-border px-2 py-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            href={embeddedUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open externally
          </a>
          <button
            type="button"
            disabled={canceling}
            className="rounded border border-destructive/40 px-2 py-1 text-destructive hover:bg-destructive/10 disabled:opacity-60"
            onClick={() => {
              if (!payload) return;
              setCanceling(true);
              void rpc
                .call("cancelReview", { threadId, sessionId: payload.sessionId })
                .then((result) => {
                  if (!result.cancelled) setCanceling(false);
                })
                .catch(() => setCanceling(false));
            }}
          >
            {canceling ? "Cancelling…" : payload.sessionKind && payload.sessionKind !== "plan" ? "Cancel session" : "Cancel review"}
          </button>
        </div>
      </div>
      {starter.message ? (
        <div role="status" className="shrink-0 border-b border-border px-3 py-1 text-xs text-destructive">
          {starter.message}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {loadState === "loading" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background text-xs text-muted-foreground">
            Loading Plannotator…
          </div>
        ) : null}
        {loadState === "slow" ? (
          <div className="absolute inset-x-0 top-0 z-10 border-b border-border bg-background px-3 py-1 text-xs text-muted-foreground">
            Plannotator is still loading (the page is large). If nothing appears, try Reload or Open externally.
          </div>
        ) : null}
        {loadState === "unreachable" ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center text-xs text-muted-foreground">
            <div>This browser cannot reach the Plannotator session.</div>
            <div>Try Reload or Open externally.</div>
          </div>
        ) : null}
        <iframe
          key={reloadKey}
          title="Plannotator review"
          src={iframeLoadUrl(embeddedUrl, payload.sessionId, reloadKey)}
          className="h-full w-full border-0"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
          onLoad={() => setLoadState("loaded")}
          onError={() => setLoadState("unreachable")}
        />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: PANEL_TITLE,
    icon: "ClipboardCheck",
    layout: "flush",
    component: PlannotatorPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "plannotator-focus-bridge",
    title: "Plannotator focus bridge",
    component: PlannotatorFocusBridge,
  });
  const openWith = (
    context: { threadId: string | null; openPanel(options: { actionId: string; title?: string }): boolean },
    request: PanelRequest,
  ) => {
    if (!context.threadId) return;
    requestPanel(context.threadId, request);
    if (!context.openPanel({ actionId: PANEL_ACTION_ID, title: PANEL_TITLE })) {
      cancelPanelRequest(context.threadId, request);
      toast.error("Plannotator could not open its panel here. Open the thread's side panel and try again.");
    }
  };
  app.slots.messageAction({
    id: "plannotator-annotate-message",
    title: "Annotate in Plannotator",
    icon: "ClipboardCheck",
    run(context) {
      // bb shows message actions on every message; Plannotator annotates replies.
      if (context.message.role !== "assistant") {
        toast.error("Plannotator annotates the agent's replies. Use it on an assistant message.");
        return;
      }
      const markdown = context.selectedText?.trim() ? context.selectedText : context.message.text;
      openWith(context, { kind: "launch", request: { mode: "annotate-last", markdown } });
    },
  });
  const inThread = (context: { threadId: string | null }) => context.threadId !== null;
  app.commands.register({
    id: "plannotator-review-changes",
    title: "Plannotator: Review changes",
    isAvailable: inThread,
    run: (context) => openWith(context, { kind: "launch", request: { mode: "review" } }),
  });
  app.commands.register({
    id: "plannotator-annotate-last-reply",
    title: "Plannotator: Annotate last finished reply",
    isAvailable: inThread,
    run: (context) => openWith(context, { kind: "launch", request: { mode: "annotate-last" } }),
  });
  app.commands.register({
    id: "plannotator-annotate-file",
    title: "Plannotator: Annotate file…",
    isAvailable: inThread,
    run: (context) => openWith(context, { kind: "view", view: "annotate-file" }),
  });
});
