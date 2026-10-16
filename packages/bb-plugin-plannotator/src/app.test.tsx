// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PLANNOTATOR_RELAY_PATH } from "./embedded";
import { LOAD_SLOW_MS } from "../app";
import { PLANNOTATOR_REALTIME_CHANNEL } from "./constants";

const app = await loadPluginApp(() => import("../app"));

/** SDK fakes for the session launcher's file picker. */
function launcherSdk(paths: string[] = []) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    sdk: {
      threads: { get: async () => ({ environmentId: "env-1" }) },
      environments: {
        paths: async (args: Record<string, unknown>) => {
          calls.push(args);
          return {
            paths: paths.map((path) => ({ kind: "file", name: path, path, positions: [], score: 1 })),
            truncated: false,
          };
        },
      },
    } as never,
  };
}

afterEach(() => cleanup());

const payload = {
  kind: "plannotator" as const,
  sessionId: "session-1",
  threadId: "thread-1",
  sessionUrl: "http://127.0.0.1:43210",
  relayPath: PLANNOTATOR_RELAY_PATH,
  title: "Upstream plan review",
};

describe("Plannotator BB shell", () => {
  it("registers only the upstream panel", () => {
    expect(app.navPanels).toHaveLength(0);
    expect(app.threadPanelActions.map((action) => action.id)).toEqual([
      "plannotator-review",
    ]);
    expect(app.pendingInteractions).toHaveLength(0);
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual([
      "plannotator-focus-bridge",
    ]);
  });

  it("focuses the review panel from a same-thread realtime event", async () => {
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      {
        threadId: "thread-1",
        projectId: "project-1",
        isCompactViewport: false,
      },
      {
        openThreadPanel: () => true,
        rpc: { getActiveReview: () => null },
      },
    );

    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-opened",
      payload,
    });
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "openThreadPanel",
      options: { actionId: "plannotator-review", title: payload.title },
    });
  });

  it("opens every session in the thread's one param-less tab, so bb focuses it instead of adding another", async () => {
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      { threadId: "thread-1", projectId: "project-1", isCompactViewport: false },
      { openThreadPanel: () => true, rpc: { getActiveReview: () => null } },
    );

    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, { kind: "review-opened", payload });
    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-opened",
      payload: { ...payload, sessionId: "session-2", title: "Code review" },
    });

    // bb derives a tab's id from its action and params; with no params both
    // sessions name the same tab, which bb focuses and retitles.
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "openThreadPanel", options: { actionId: "plannotator-review", title: payload.title } },
      { method: "openThreadPanel", options: { actionId: "plannotator-review", title: "Code review" } },
    ]);
  });

  it("ignores review-opened events for other threads", async () => {
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      {
        threadId: "thread-2",
        projectId: "project-1",
        isCompactViewport: false,
      },
      {
        openThreadPanel: () => true,
        rpc: { getActiveReview: () => null },
      },
    );

    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-opened",
      payload,
    });
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });

  it("reconciles a durable active review on mount and reconnect", async () => {
    const slot = renderSlot(
      app.threadHeaderActions[0]!,
      {
        threadId: "thread-1",
        projectId: "project-1",
        isCompactViewport: false,
      },
      {
        openThreadPanel: () => true,
        rpc: { getActiveReview: () => payload },
      },
    );

    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "openThreadPanel",
        options: { actionId: "plannotator-review", title: payload.title },
      }),
    );
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "getActiveReview",
      input: { threadId: "thread-1" },
    });

    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          (call) => call.method === "getActiveReview",
        ),
      ).toHaveLength(2),
    );
    expect(
      slot.inspection.navigateCalls.filter(
        (call) => call.method === "openThreadPanel",
      ),
    ).toHaveLength(1);
  });

  it("renders the real upstream URL in the right-panel iframe", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getActiveReview: () => payload }, sdk: launcherSdk().sdk },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toBe(
      `http://${window.location.host}${PLANNOTATOR_RELAY_PATH}?sessionId=session-1&path=%2F&bbLoad=session--0`,
    );
    expect(iframe.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
    expect(document.cookie).toContain("plannotator-look-feel-announcement-seen=2");
    expect(document.cookie).toContain("plannotator-plan-look-choice-resolved=true");
  });

  it("iframes a session published by another host directly and pre-dismisses its update toast", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getActiveReview: () => ({
            ...payload,
            sessionId: "session-2",
            sessionUrl: "https://mac.tailnet-example.ts.net:19500",
            dismissUpdateVersion: "0.29.0",
          }),
        },
        sdk: launcherSdk().sdk,
      },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toBe("https://mac.tailnet-example.ts.net:19500/?bbLoad=session--0");
    expect((await slot.findByText("Open externally")).getAttribute("href")).toBe(
      "https://mac.tailnet-example.ts.net:19500",
    );
    expect(document.cookie).toContain("update-dismissed-version=0.29.0");
  });

  it("shows the thread's open session, not a session named in an older tab's params", async () => {
    const legacy = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: payload },
      { rpc: { getActiveReview: () => null }, sdk: launcherSdk().sdk },
    );
    await legacy.findByRole("button", { name: "Review changes" });
    expect(legacy.queryByTitle("Plannotator review")).toBeNull();
    legacy.lifecycle.unmount();
  });

  it("recovers the pending review when the panel action opens without params", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: {} },
      {
        rpc: {
          getActiveReview: () => payload,
          cancelReview: () => ({ cancelled: true }),
        },
        sdk: launcherSdk().sdk,
      },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toContain("sessionId=session-1");
    expect(slot.rpcCalls).toContainEqual({
      method: "getActiveReview",
      input: { threadId: "thread-1" },
    });
    expect(slot.queryByText("Annotate last finished reply", { selector: "div" })).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Cancel review" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "cancelReview",
        input: { threadId: "thread-1", sessionId: "session-1" },
      }),
    );
  });

  it("follows review open and close signals in a param-less panel", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: {} },
      { rpc: { getActiveReview: () => null }, sdk: launcherSdk().sdk },
    );

    await slot.findByRole("button", { name: "Review changes" });
    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-opened",
      payload: { ...payload, threadId: "thread-2" },
    });
    expect(slot.queryByTitle("Plannotator review")).toBeNull();

    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-opened",
      payload,
    });
    await slot.findByTitle("Plannotator review");

    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-closed",
      threadId: "thread-1",
      sessionId: "session-1",
    });
    await slot.findByRole("button", { name: "Review changes" });
  });

  it("starts a code review, an annotation of the last reply, and a file annotation from the launcher", async () => {
    const { sdk, calls } = launcherSdk(["docs/guide.md", "src/app.ts", "site/index.html"]);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getActiveReview: () => null,
          startSession: () => ({ status: "pending", reviewId: "r-1" }),
        },
        sdk,
      },
    );

    const idle = () =>
      waitFor(() =>
        expect((slot.getByRole("button", { name: "Review changes" }) as HTMLButtonElement).disabled).toBe(false),
      );
    fireEvent.change(await slot.findByLabelText("Diff type"), { target: { value: "uncommitted" } });
    fireEvent.click(slot.getByRole("button", { name: "Review changes" }));
    await idle();
    fireEvent.click(slot.getByRole("button", { name: "Annotate last finished reply" }));
    await idle();
    fireEvent.click(await slot.findByRole("button", { name: "site/index.html" }));

    await waitFor(() =>
      expect(slot.rpcCalls.filter(({ method }) => method === "startSession").map(({ input }) => input)).toEqual([
        { threadId: "thread-1", request: { mode: "review", diffType: "uncommitted" } },
        { threadId: "thread-1", request: { mode: "annotate-last" } },
        { threadId: "thread-1", request: { mode: "annotate", path: "site/index.html" } },
      ]),
    );
    // The picker lists only Markdown and HTML files from bb's workspace search.
    expect(slot.queryByRole("button", { name: "src/app.ts" })).toBeNull();
    expect(calls[0]).toMatchObject({ environmentId: "env-1", includeFiles: "true", includeDirectories: "false" });
  });

  it("hands a message-action launch to the thread's panel without tab params", async () => {
    const action = app.messageActions.find(({ id }) => id === "plannotator-annotate-message")!;
    const opened: unknown[] = [];
    const context = (selectedText?: string) =>
      ({
        threadId: "thread-1",
        message: { id: "m-1", threadId: "thread-1", role: "assistant", text: "Full reply", sourceSeqEnd: 1, experimental_messageSeq: 1 },
        ...(selectedText ? { selectedText } : {}),
        openPanel: (options: unknown) => {
          opened.push(options);
          return true;
        },
      }) as never;

    void action.run(context("Just this"));
    expect(opened).toEqual([{ actionId: "plannotator-review", title: "Plannotator" }]);

    // A session is already showing, so the server refuses another one; the
    // panel says so above the session.
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      {
        rpc: {
          getActiveReview: () => payload,
          startSession: () => ({ status: "already_active", reviewId: payload.sessionId }),
        },
        sdk: launcherSdk().sdk,
      },
    );
    await slot.findByTitle("Plannotator review");
    expect((await slot.findByRole("status")).textContent).toBe("A Plannotator session is already open in this thread.");

    // A panel that is already open takes the next request too.
    void action.run(context());
    await waitFor(() =>
      expect(slot.rpcCalls.filter(({ method }) => method === "startSession").map(({ input }) => input)).toEqual([
        { threadId: "thread-1", request: { mode: "annotate-last", markdown: "Just this" } },
        { threadId: "thread-1", request: { mode: "annotate-last", markdown: "Full reply" } },
      ]),
    );
  });

  it("drops a request whose panel did not open and says so", async () => {
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => 0 as never);
    const action = app.messageActions.find(({ id }) => id === "plannotator-annotate-message")!;
    void action.run({
      threadId: "thread-1",
      message: { id: "m-1", threadId: "thread-1", role: "assistant", text: "Reply", sourceSeqEnd: 1, experimental_messageSeq: 1 },
      openPanel: () => false,
    } as never);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("could not open its panel"));

    // Opening the panel later starts nothing.
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getActiveReview: () => null, startSession: () => ({ status: "pending", reviewId: "r" }) }, sdk: launcherSdk().sdk },
    );
    await slot.findByRole("button", { name: "Review changes" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.rpcCalls.filter(({ method }) => method === "startSession")).toHaveLength(0);
    toastError.mockRestore();
  });

  it("shows why a session the user started ended without a result", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getActiveReview: () => null }, sdk: launcherSdk().sdk },
    );
    await slot.findByRole("button", { name: "Review changes" });

    await slot.behavior.emitRealtime(PLANNOTATOR_REALTIME_CHANNEL, {
      kind: "review-failed",
      threadId: "thread-1",
      sessionId: "session-1",
      message: "Plannotator exited without a result.",
    });

    await slot.findByText("Plannotator exited without a result.");
  });

  it("reloads with a fresh URL and never hides a slow page behind a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const head = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", head);
    try {
      const slot = renderSlot(
        app.threadPanelActions[0]!,
        { threadId: "thread-1", params: null },
        {
          rpc: { getActiveReview: () => ({ ...payload, sessionUrl: "https://mac.tailnet-example.ts.net:19500" }) },
          sdk: launcherSdk().sdk,
          openThreadPanel: () => true,
        },
      );
      const iframe = await slot.findByTitle("Plannotator review");
      expect(slot.getByText("Loading Plannotator…")).toBeTruthy();

      await vi.advanceTimersByTimeAsync(LOAD_SLOW_MS + 10);
      // Still loading after the threshold: a notice, not a cover, and no failure.
      await slot.findByText(/still loading \(the page is large\)/u);
      expect(slot.queryByText("Loading Plannotator…")).toBeNull();
      expect(slot.queryByText(/cannot reach/u)).toBeNull();
      expect(head).toHaveBeenCalledWith("https://mac.tailnet-example.ts.net:19500", expect.objectContaining({ method: "HEAD", mode: "no-cors" }));

      fireEvent.click(slot.getByRole("button", { name: "Reload" }));
      const reloaded = await slot.findByTitle("Plannotator review");
      expect(reloaded.getAttribute("src")).toBe("https://mac.tailnet-example.ts.net:19500/?bbLoad=session--1");
      expect(reloaded).not.toBe(iframe);
      fireEvent.load(reloaded);
      await waitFor(() => expect(slot.queryByText("Loading Plannotator…")).toBeNull());
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("reports an unreachable session only when the page cannot be fetched at all", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    try {
      const slot = renderSlot(
        app.threadPanelActions[0]!,
        { threadId: "thread-1", params: null },
        { rpc: { getActiveReview: () => payload }, sdk: launcherSdk().sdk, openThreadPanel: () => true },
      );
      await slot.findByTitle("Plannotator review");
      await vi.advanceTimersByTimeAsync(LOAD_SLOW_MS + 10);
      await slot.findByText("This browser cannot reach the Plannotator session.");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("names the tab after the open session", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getActiveReview: () => ({ ...payload, title: "Code review" }) }, sdk: launcherSdk().sdk, openThreadPanel: () => true },
    );
    await slot.findByTitle("Plannotator review");
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({
        method: "openThreadPanel",
        options: { actionId: "plannotator-review", title: "Code review" },
      }),
    );
  });

  it("annotates assistant replies only", () => {
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => 0 as never);
    const action = app.messageActions.find(({ id }) => id === "plannotator-annotate-message")!;
    const opened: unknown[] = [];
    void action.run({
      threadId: "thread-1",
      message: { id: "m-1", threadId: "thread-1", role: "user", text: "My question", sourceSeqEnd: 1, experimental_messageSeq: 1 },
      openPanel: (options: unknown) => opened.push(options) > 0,
    } as never);
    expect(opened).toEqual([]);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("annotates the agent's replies"));
    toastError.mockRestore();
  });

  it("lists Markdown and HTML files in the picker before anything is typed", async () => {
    const { sdk, calls } = launcherSdk(["docs/guide.md", "page.html"]);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getActiveReview: () => null }, sdk },
    );
    await slot.findByRole("button", { name: "page.html" });
    await slot.findByRole("button", { name: "docs/guide.md" });
    expect(calls.map(({ query }) => query)).toEqual(["md", "html"]);
  });

  it("exposes explicit cancellation without a host interaction deadline", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: null },
      { rpc: { getActiveReview: () => payload, cancelReview: () => ({ cancelled: true }) }, sdk: launcherSdk().sdk },
    );

    await slot.findByRole("button", { name: "Cancel review" });
    expect(slot.queryByRole("timer")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Cancel review" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "cancelReview",
        input: { threadId: "thread-1", sessionId: "session-1" },
      }),
    );
  });

});
