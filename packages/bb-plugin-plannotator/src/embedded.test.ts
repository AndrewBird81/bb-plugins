import { describe, expect, it } from "vitest";
import {
  PLANNOTATOR_RELAY_PATH,
  buildPlannotatorRelayUrl,
  embeddedSessionUrl,
  normalizeEmbeddedSessionUrl,
  sharedCookieDomain,
  upstreamOnboardingCookies,
} from "./embedded";

describe("embedded Plannotator host seams", () => {
  it("aligns local upstream URLs with the browser-facing loopback host", () => {
    expect(
      normalizeEmbeddedSessionUrl("http://127.0.0.1:43210", "localhost"),
    ).toBe("http://localhost:43210");
    expect(
      normalizeEmbeddedSessionUrl("http://localhost:43210", "127.0.0.1"),
    ).toBe("http://127.0.0.1:43210");
  });

  it("does not rewrite already-public sessions", () => {
    expect(
      normalizeEmbeddedSessionUrl("https://review.example.test:43210", "localhost"),
    ).toBe("https://review.example.test:43210");
  });

  it("rewrites local and wildcard upstream binds for remote browsers", () => {
    expect(
      normalizeEmbeddedSessionUrl("http://127.0.0.1:43210", "review.example.test"),
    ).toBe("http://review.example.test:43210");
    expect(
      normalizeEmbeddedSessionUrl("http://0.0.0.0:43210", "review.example.test"),
    ).toBe("http://review.example.test:43210");
    expect(
      normalizeEmbeddedSessionUrl("http://[::]:43210", "review.example.test"),
    ).toBe("http://review.example.test:43210");
  });

  it("pre-dismisses every upstream first-run dialog host-only by default", () => {
    expect(upstreamOnboardingCookies()).toEqual([
      "plannotator-look-feel-announcement-seen=2; path=/; max-age=31536000; SameSite=Lax",
      "plannotator-plan-look-choice-resolved=true; path=/; max-age=31536000; SameSite=Lax",
      "plannotator-permission-mode-configured=true; path=/; max-age=31536000; SameSite=Lax",
      "plannotator-announce-tui-herdr-seen=1; path=/; max-age=31536000; SameSite=Lax",
      "plannotator-announce-ask-session-seen=1; path=/; max-age=31536000; SameSite=Lax",
      "plannotator-announce-agent-tool-seen=1; path=/; max-age=31536000; SameSite=Lax",
    ]);
  });

  it("also scopes the cookies to a shared parent domain and dismisses the update toast", () => {
    const cookies = upstreamOnboardingCookies({
      domain: "tailnet-example.ts.net",
      dismissUpdateVersion: "0.29.0",
    });
    expect(cookies).toHaveLength(14);
    expect(cookies).toContain(
      "update-dismissed-version=0.29.0; path=/; max-age=31536000; SameSite=Lax",
    );
    expect(cookies).toContain(
      "plannotator-announce-tui-herdr-seen=1; path=/; max-age=31536000; SameSite=Lax; domain=tailnet-example.ts.net",
    );
  });

  it("finds the parent domain a BB page shares with another tailnet host", () => {
    expect(
      sharedCookieDomain("bb-server.tailnet-example.ts.net", "https://laptop.tailnet-example.ts.net:19500"),
    ).toBe("tailnet-example.ts.net");
    expect(sharedCookieDomain("bb-server.tailnet-example.ts.net", "https://bb-server.tailnet-example.ts.net/x")).toBeNull();
    expect(sharedCookieDomain("localhost", "http://127.0.0.1:43210")).toBeNull();
    expect(sharedCookieDomain("a.example", "https://b.test")).toBeNull();
    expect(sharedCookieDomain("100.64.0.1", "https://mac.tailnet-example.ts.net:19500")).toBeNull();
  });

  it("uses the same-origin relay for local sessions over HTTP and HTTPS", () => {
    expect(
      embeddedSessionUrl(
        "http://127.0.0.1:43210",
        "session-1",
        {
          hostname: "machine.example.ts.net",
          protocol: "https:",
          origin: "https://machine.example.ts.net",
        },
      ),
    ).toBe(
      `https://machine.example.ts.net${PLANNOTATOR_RELAY_PATH}?sessionId=session-1&path=%2F`,
    );
    expect(
      embeddedSessionUrl(
        "https://127.0.0.1:43210",
        "session-2",
        {
          hostname: "machine.example.ts.net",
          protocol: "https:",
          origin: "https://machine.example.ts.net",
        },
      ),
    ).toBe(
      `https://machine.example.ts.net${PLANNOTATOR_RELAY_PATH}?sessionId=session-2&path=%2F`,
    );
  });

  it("keeps already-public sessions direct", () => {
    expect(
      embeddedSessionUrl(
        "https://review.example.test:43210",
        "session-1",
        {
          hostname: "machine.example.ts.net",
          protocol: "http:",
          origin: "http://machine.example.ts.net",
        },
      ),
    ).toBe("https://review.example.test:43210");
  });

  it("builds relay URLs with an encoded upstream path and query", () => {
    expect(
      buildPlannotatorRelayUrl(
        "session-1",
        "/api/plan?path=hello world",
        "https://machine.example.ts.net",
      ),
    ).toBe(
      `https://machine.example.ts.net${PLANNOTATOR_RELAY_PATH}?sessionId=session-1&path=%2Fapi%2Fplan%3Fpath%3Dhello+world`,
    );
  });
});
