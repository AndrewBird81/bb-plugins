// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PLANNOTATOR_RELAY_PATH } from "./embedded";
import { PLANNOTATOR_REALTIME_CHANNEL } from "./constants";

const app = await loadPluginApp(() => import("../app"));

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
          sessionUrl: "https://mac.tailnet-example.ts.net:19500",
          dismissUpdateVersion: "0.29.0",
        },
      },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toBe("https://mac.tailnet-example.ts.net:19500");
    expect((await slot.findByText("Open externally")).getAttribute("href")).toBe(
      "https://mac.tailnet-example.ts.net:19500",
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
      },
    );

    const iframe = await slot.findByTitle("Plannotator review");
    expect(iframe.getAttribute("src")).toContain("sessionId=session-1");
    expect(slot.rpcCalls).toContainEqual({
      method: "getActiveReview",
      input: { threadId: "thread-1" },
    });
    expect(slot.queryByText(/Start a plan review from the agent/)).toBeNull();

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
      { rpc: { getActiveReview: () => null } },
    );

    await slot.findByText(/Start a plan review from the agent/);
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
    await slot.findByText(/Start a plan review from the agent/);
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
