// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PLANNOTATOR_RELAY_PATH } from "./embedded";
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
      options: {
        actionId: "plannotator-review",
        title: payload.title,
        params: payload,
      },
    });
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
        options: {
          actionId: "plannotator-review",
          title: payload.title,
          params: payload,
        },
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
      { threadId: "thread-1", params: payload },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toBe(
      `http://${window.location.host}${PLANNOTATOR_RELAY_PATH}?sessionId=session-1&path=%2F`,
    );
    expect(iframe.getAttribute("allow")).toBe("clipboard-read; clipboard-write");
    expect(document.cookie).toContain("plannotator-look-feel-announcement-seen=2");
    expect(document.cookie).toContain("plannotator-plan-look-choice-resolved=true");
  });

  it("iframes a session published by another host directly and pre-dismisses its update toast", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      {
        threadId: "thread-1",
        params: {
          ...payload,
          sessionId: "session-2",
          sessionUrl: "https://mac.tail1b968e.ts.net:19500",
          dismissUpdateVersion: "0.29.0",
        },
      },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toBe("https://mac.tail1b968e.ts.net:19500");
    expect((await slot.findByText("Open externally")).getAttribute("href")).toBe(
      "https://mac.tail1b968e.ts.net:19500",
    );
    expect(document.cookie).toContain("update-dismissed-version=0.29.0");
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
    expect(slot.queryByText("Annotate last reply", { selector: "div" })).toBeNull();

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
    fireEvent.click(slot.getByRole("button", { name: "Annotate last reply" }));
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

  it("starts a launch request from panel params once and shows a refusal", async () => {
    const params = { launch: { id: "launch-1", request: { mode: "annotate-last", markdown: "Hello" } } };
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params },
      {
        rpc: {
          getActiveReview: () => null,
          startSession: () => ({ status: "already_active", reviewId: "r-0" }),
        },
        sdk: launcherSdk().sdk,
      },
    );

    await slot.findByText("A Plannotator session is already open in this thread.");
    expect(slot.rpcCalls.filter(({ method }) => method === "startSession")).toEqual([
      { method: "startSession", input: { threadId: "thread-1", request: { mode: "annotate-last", markdown: "Hello" } } },
    ]);
  });

  it("annotates a message, or its selected text, through the panel", () => {
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

    void action.run(context());
    void action.run(context("Just this"));

    expect(opened).toMatchObject([
      { actionId: "plannotator-review", params: { launch: { request: { mode: "annotate-last", markdown: "Full reply" } } } },
      { actionId: "plannotator-review", params: { launch: { request: { mode: "annotate-last", markdown: "Just this" } } } },
    ]);
  });

  it("exposes explicit cancellation without a host interaction deadline", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thread-1", params: payload },
      { rpc: { cancelReview: () => ({ cancelled: true }) } },
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
