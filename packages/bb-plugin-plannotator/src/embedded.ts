/**
 * Small host-side seams for embedding the official Plannotator runtime.
 *
 * Plannotator keeps its one-time UI announcements in cookies. BB's browser
 * page shares those cookies with the iframe when both use the same hostname,
 * or through a Domain cookie on a parent domain both hosts share. Ports are
 * ignored by cookie scoping, so one cookie covers every review port.
 */
import { PLANNOTATOR_RELAY_PATH } from "./constants";

/**
 * Upstream v0.28 first-run gates, each dismissed by one cookie value: the
 * plan look chooser (current and legacy keys), Claude Code permission-mode
 * setup, and the terminal-tools, "Ask this session" and agent-tool
 * announcements. None of them applies to a review BB opened.
 */
export const UPSTREAM_DISMISSED_COOKIES: ReadonlyArray<readonly [string, string]> = [
  ["plannotator-look-feel-announcement-seen", "2"],
  ["plannotator-plan-look-choice-resolved", "true"],
  ["plannotator-permission-mode-configured", "true"],
  ["plannotator-announce-tui-herdr-seen", "1"],
  ["plannotator-announce-ask-session-seen", "1"],
  ["plannotator-announce-agent-tool-seen", "1"],
  // Code review: "Introducing Guided Reviews", "Edit code to suggest" and
  // "Hover cards".
  ["plannotator-guide-intro-seen", "2"],
  ["plannotator-edit-mode-announcement-seen", "3"],
  ["plannotator-token-hover-announcement-seen", "1"],
];
/** Upstream hides its update toast when this names the latest release. */
export const UPSTREAM_UPDATE_DISMISSED_COOKIE = "update-dismissed-version";
export { PLANNOTATOR_RELAY_PATH } from "./constants";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_BIND_HOSTNAMES = new Set([
  ...LOOPBACK_HOSTNAMES,
  "0.0.0.0",
  "::",
  "[::]",
]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/** Hostnames an upstream server may report for a listener local to BB. */
export function isLocalBindHostname(hostname: string): boolean {
  return LOCAL_BIND_HOSTNAMES.has(hostname.trim().toLowerCase());
}

/**
 * Make the child URL use the hostname visible to the BB browser page.
 *
 * The server-side loopback address is not necessarily the browser-facing
 * address: BB can serve its UI from localhost while its backend advertises
 * 127.0.0.1. Remote-mode Plannotator can also report a wildcard bind address
 * such as 0.0.0.0. Those values are server-local transport details, not
 * browser destinations, so rewrite them to the host visible to the browser.
 * Already-public upstream URLs are left alone.
 */
export function normalizeEmbeddedSessionUrl(
  url: string,
  browserHostname: string,
): string {
  const targetHostname = browserHostname.trim();
  if (!targetHostname) return url;

  try {
    const parsed = new URL(url);
    if (!isLocalBindHostname(parsed.hostname)) return url;
    parsed.hostname = targetHostname;
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return url;
  }
}

export function buildPlannotatorRelayUrl(
  sessionId: string,
  upstreamPath = "/",
  browserOrigin = "http://bb.invalid",
): string {
  const relay = new URL(PLANNOTATOR_RELAY_PATH, browserOrigin);
  relay.searchParams.set("sessionId", sessionId);
  relay.searchParams.set("path", upstreamPath);
  return browserOrigin === "http://bb.invalid"
    ? `${relay.pathname}${relay.search}`
    : relay.toString();
}

/**
 * A local child listener is reachable by BB, but not necessarily by the
 * browser. Use the same-origin relay for both HTTP and HTTPS BB pages so a
 * remote client only needs the BB/Tailscale endpoint; already-public upstream
 * URLs remain direct.
 */
export function embeddedSessionUrl(
  sessionUrl: string,
  sessionId: string,
  browserLocation: { hostname: string; protocol: string; origin: string },
): string {
  try {
    const parsed = new URL(sessionUrl);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLocalBindHostname(parsed.hostname)
    ) {
      return buildPlannotatorRelayUrl(
        sessionId,
        "/",
        browserLocation.origin,
      );
    }
  } catch {
    return sessionUrl;
  }
  return normalizeEmbeddedSessionUrl(sessionUrl, browserLocation.hostname);
}

function isIpLiteral(hostname: string): boolean {
  return hostname.includes(":") || /^[\d.]+$/u.test(hostname);
}

/**
 * The parent domain shared by the BB page and a session on another host, for
 * example `tailnet-example.ts.net` for two tailnet machines. Null for the same
 * host, IP literals, or hosts that share only a top-level label. Browsers
 * reject a Domain cookie on a public suffix, so a wrong guess is harmless.
 */
export function sharedCookieDomain(pageHostname: string, sessionUrl: string): string | null {
  let sessionHostname: string;
  try {
    sessionHostname = new URL(sessionUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const pageHost = pageHostname.trim().toLowerCase();
  if (!pageHost || pageHost === sessionHostname) return null;
  if (isIpLiteral(pageHost) || isIpLiteral(sessionHostname)) return null;
  const pageLabels = pageHost.split(".").reverse();
  const sessionLabels = sessionHostname.split(".").reverse();
  const shared: string[] = [];
  for (let index = 0; index < Math.min(pageLabels.length, sessionLabels.length); index += 1) {
    if (pageLabels[index] !== sessionLabels[index]) break;
    shared.push(pageLabels[index]!);
  }
  return shared.length >= 2 ? shared.reverse().join(".") : null;
}

/**
 * Cookies that pre-dismiss upstream first-run dialogs and, when the latest
 * release is known, its update toast. Each is written host-only and, when
 * given, on `domain` so a session on another tailnet host reads it too.
 */
/**
 * The iframe URL for one load of a session. Each session and each Reload
 * gets its own URL, so a browser never waits on an earlier, stalled request
 * for the same 20+ MB page (its HTTP cache serializes identical URLs).
 */
export function iframeLoadUrl(embeddedUrl: string, sessionId: string, attempt: number): string {
  try {
    const url = new URL(embeddedUrl, "http://bb.invalid");
    url.searchParams.set("bbLoad", `${sessionId.slice(0, 8)}-${attempt}`);
    return embeddedUrl.startsWith("/") ? `${url.pathname}${url.search}` : url.toString();
  } catch {
    return embeddedUrl;
  }
}

export function upstreamOnboardingCookies(
  options: { domain?: string | null; dismissUpdateVersion?: string } = {},
): string[] {
  const values: Array<readonly [string, string]> = [...UPSTREAM_DISMISSED_COOKIES];
  if (options.dismissUpdateVersion) {
    values.push([UPSTREAM_UPDATE_DISMISSED_COOKIE, options.dismissUpdateVersion]);
  }
  const scopes = ["", ...(options.domain ? [`; domain=${options.domain}`] : [])];
  return scopes.flatMap((scope) =>
    values.map(
      ([name, value]) =>
        `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax${scope}`,
    ),
  );
}
