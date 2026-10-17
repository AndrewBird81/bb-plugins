import type { BbPluginApi, PluginHttpHandler } from "@get-bb/plugin-sdk";
import { PLANNOTATOR_RELAY_PATH } from "./constants";
import {
  MAX_CAPABILITIES_BODY_BYTES,
  MAX_DECISION_BODY_BYTES,
  isRelabelableCapabilities,
  isScriptableImage,
  relabelCapabilitiesBody,
  rewriteDecisionBody,
  scriptableImagePolicy,
  type RequestFilter,
} from "./request-filter";

/** The single BB route used when the browser can only reach BB's origin. */
export const PLANNOTATOR_RELAY_ROUTE = "/review";

const MAX_UPSTREAM_PATH_LENGTH = 16_384;
const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** A session BB relays: Plannotator's loopback URL and its request filter. */
export type RelaySession = { url: string; filter: RequestFilter };
type RelaySessionMap = Map<string, RelaySession>;
type RelayContext = Parameters<PluginHttpHandler>[0];
type FetchLike = typeof fetch;

export function buildPlannotatorRelayUrl(
  relayPath: string,
  sessionId: string,
  upstreamPath = "/",
  origin?: string,
): string {
  const base = origin ?? "http://bb.invalid";
  const url = new URL(relayPath, base);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("path", upstreamPath);
  return origin ? url.toString() : `${url.pathname}${url.search}`;
}

export function isSafeUpstreamPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_UPSTREAM_PATH_LENGTH &&
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !path.includes("\\") &&
    !path.includes("\u0000") &&
    !path.includes("#")
  );
}

function relayLocation(
  value: string,
  upstreamBaseUrl: string,
  relayPath: string,
  sessionId: string,
): string {
  try {
    const base = new URL(upstreamBaseUrl);
    const location = new URL(value, base);
    if (location.origin !== base.origin) return value;
    return buildPlannotatorRelayUrl(
      relayPath,
      sessionId,
      `${location.pathname}${location.search}`,
    );
  } catch {
    return value;
  }
}

function copyResponseHeaders(
  response: Response,
  options: {
    upstreamBaseUrl: string;
    upstreamPathname: string;
    relayPath: string;
    sessionId: string;
    html: boolean;
  },
): Headers {
  const headers = new Headers(response.headers);
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  // The relay answers on BB's origin; never let upstream grant it to others.
  const grants: string[] = [];
  headers.forEach((_value, name) => {
    if (name.startsWith("access-control-allow-")) grants.push(name);
  });
  for (const name of grants) headers.delete(name);
  if (options.html) {
    // The embedded document is served by BB's origin and receives our inline
    // transport bootstrap. Upstream CSP/frame headers would otherwise block
    // the intentionally thin embedding adapter. Upstream's sandbox on author
    // HTML stays: opened in its own tab, it must not run on BB's origin.
    if (!headers.get("content-security-policy")?.toLowerCase().includes("sandbox")) {
      headers.delete("content-security-policy");
    }
    headers.delete("content-security-policy-report-only");
    headers.delete("x-frame-options");
  } else if (isScriptableImage(headers.get("content-type") ?? undefined)) {
    // Here the image's script would run on BB's own origin.
    headers.append("content-security-policy", scriptableImagePolicy(options.upstreamPathname));
    headers.set("x-content-type-options", "nosniff");
  }
  const location = headers.get("location");
  if (location) {
    headers.set(
      "location",
      relayLocation(
        location,
        options.upstreamBaseUrl,
        options.relayPath,
        options.sessionId,
      ),
    );
  }
  return headers;
}

/** The request body, or null once it is over `limit` bytes. */
async function readCappedBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function buildUpstreamUrl(baseUrl: string, path: string): string | null {
  if (!isSafeUpstreamPath(path)) return null;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") return null;
    const target = new URL(path, base);
    if (target.origin !== base.origin) return null;
    return target.toString();
  } catch {
    return null;
  }
}

function isHtmlResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/html");
}

/**
 * Add transport only. The upstream app still owns the complete document and
 * all review behavior; this script keeps its root-relative requests on BB's
 * one remotely published origin.
 */
export function injectRelayBootstrap(
  html: string,
  relayPath: string,
  sessionId: string,
): string {
  const script = `<script data-bb-plannotator-relay>
(() => {
  "use strict";
  const relayPath = ${JSON.stringify(relayPath)};
  const sessionId = ${JSON.stringify(sessionId)};

  const rewrite = (value) => {
    if (typeof value !== "string") return value;
    let url;
    try {
      url = new URL(value, window.location.href);
    } catch {
      return value;
    }
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/")) {
      return value;
    }
    if (url.pathname === relayPath || url.pathname.startsWith(relayPath + "/")) {
      return value;
    }
    const relay = new URL(relayPath, window.location.href);
    relay.searchParams.set("sessionId", sessionId);
    relay.searchParams.set("path", url.pathname + url.search);
    return relay.toString();
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (input instanceof Request) {
      return nativeFetch(new Request(rewrite(input.url), input), init);
    }
    return nativeFetch(rewrite(String(input)), init);
  };

  try {
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(...args) {
      args[1] = rewrite(String(args[1]));
      return nativeOpen.apply(this, args);
    };
  } catch {}

  try {
    const NativeEventSource = window.EventSource;
    const RelayEventSource = function(url, config) {
      return new NativeEventSource(rewrite(String(url)), config);
    };
    RelayEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = RelayEventSource;
  } catch {}

  const rewriteElement = (element) => {
    for (const attribute of ["src", "href", "action"]) {
      const value = element.getAttribute?.(attribute);
      if (value && value.startsWith("/") && !value.startsWith("//")) {
        element.setAttribute(attribute, rewrite(value));
      }
    }
  };
  const scan = (root = document) => {
    root.querySelectorAll?.("[src], [href], [action]").forEach(rewriteElement);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scan(), { once: true });
  } else {
    scan();
  }
  try {
    // React inserts whole subtrees and later changes attributes in place.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          rewriteElement(record.target);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          rewriteElement(node);
          scan(node);
        }
      }
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "href", "action"],
    });
  } catch {}
})();
</script>`;
  // Do not search for the first closing </head>. The upstream bundle is an
  // inline script and contains HTML template strings such as `</head>`; an
  // index-based insertion at that occurrence corrupts the module before the
  // browser can execute it. Place the bootstrap immediately after the real
  // opening head tag, before the deferred upstream module starts.
  const headStart = html.match(/<head\b[^>]*>/iu);
  if (!headStart || headStart.index === undefined) return `${script}${html}`;
  const insertAt = headStart.index + headStart[0].length;
  return `${html.slice(0, insertAt)}${script}${html.slice(insertAt)}`;
}

/**
 * Origins a page on BB may write from: the bb page's when it is known. Only
 * when it is not, the origin of the Host the request names, which a rebound
 * DNS name could also claim.
 */
function relayOrigins(host: string | undefined, bbOrigin: string | undefined): string[] {
  if (bbOrigin) return [bbOrigin];
  return host ? [`https://${host}`, `http://${host}`] : [];
}

export function createPlannotatorRelayHandler(
  sessions: RelaySessionMap,
  relayPath = PLANNOTATOR_RELAY_PATH,
  fetchImpl: FetchLike = fetch,
  bbOrigin: () => string | undefined = () => undefined,
): PluginHttpHandler {
  return async (context: RelayContext) => {
    const sessionId = context.req.query("sessionId")?.trim() ?? "";
    const path = context.req.query("path") ?? "/";
    const session = sessions.get(sessionId);
    if (!sessionId || !session) {
      return errorResponse("Unknown or expired Plannotator session", 404);
    }
    const upstreamBaseUrl = session.url;

    const requestedUrl = buildUpstreamUrl(upstreamBaseUrl, path);
    if (!requestedUrl) return errorResponse("Invalid Plannotator path", 400);

    const request = context.req.raw;
    // The same filter as the review proxy on a Mac. The relay always reaches
    // Plannotator with a loopback Host (fetch derives it from the URL), so the
    // filter's loopback-Host rewrite needs no action here: the bridge,
    // host-control and update endpoints that check Host are denied, and the
    // relay never forwards an Authorization header.
    const decision = await session.filter({
      method: request.method,
      url: new URL(requestedUrl),
      origin: request.headers.get("origin") ?? undefined,
      secFetchSite: request.headers.get("sec-fetch-site") ?? undefined,
      upgrade: request.headers.has("upgrade"),
      allowedOrigins: relayOrigins(request.headers.get("host") ?? undefined, bbOrigin()),
    });
    if (!decision.allowed) {
      if ("json" in decision) {
        return new Response(request.method === "HEAD" ? null : decision.json, {
          status: decision.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      return errorResponse(decision.message, decision.status);
    }
    const targetUrl = decision.url.toString();
    // A decision that did not reach Plannotator, or that it refused, leaves the session's decision open.
    const refused = (response: Response) => {
      decision.releaseDecision?.();
      return response;
    };

    const requestHeaders = new Headers(request.headers);
    for (const header of [
      "authorization",
      "connection",
      "content-length",
      "cookie",
      "host",
      "origin",
      "referer",
      "transfer-encoding",
      "upgrade",
      "x-forwarded-host",
      "x-forwarded-proto",
    ]) {
      requestHeaders.delete(header);
    }
    requestHeaders.set("accept-encoding", "identity");

    // The relay runs in the bb server: it never buffers a body it does not
    // need to read, and stops reading a decision at its limit.
    let body: Uint8Array | ReadableStream<Uint8Array> | undefined;
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      if (decision.decisionBody) {
        let raw: Uint8Array | null;
        try {
          raw = await readCappedBody(request, MAX_DECISION_BODY_BYTES);
        } catch {
          // The browser dropped the connection mid-upload.
          return refused(errorResponse("Could not read the request body.", 400));
        }
        if (!raw) return refused(errorResponse("Request body too large.", 413));
        const rewritten = rewriteDecisionBody(raw);
        if (!rewritten) return refused(errorResponse("Decision body must be a JSON object.", 400));
        body = rewritten;
        requestHeaders.set("content-type", "application/json");
      } else {
        body = request.body;
      }
    }

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetchImpl(targetUrl, {
        method: request.method,
        headers: requestHeaders,
        ...(body instanceof ReadableStream
          ? { body, duplex: "half" }
          : body && body.byteLength > 0
            ? { body: new Uint8Array(body) }
            : {}),
        redirect: "manual",
      } as RequestInit);
    } catch (error) {
      return refused(
        errorResponse(`Plannotator upstream unavailable: ${error instanceof Error ? error.message : String(error)}`, 502),
      );
    }
    if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) decision.releaseDecision?.();

    const html = isHtmlResponse(upstreamResponse);
    const headers = copyResponseHeaders(upstreamResponse, {
      upstreamBaseUrl,
      upstreamPathname: decision.url.pathname,
      relayPath,
      sessionId,
      html,
    });

    if (html && request.method !== "HEAD") {
      const document = await upstreamResponse.text();
      const embedded = injectRelayBootstrap(document, relayPath, sessionId);
      return new Response(embedded, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }

    if (
      decision.sessionBridgeLabel &&
      isRelabelableCapabilities(
        upstreamResponse.status,
        upstreamResponse.headers.get("content-type") ?? undefined,
        upstreamResponse.headers.get("content-encoding") ?? undefined,
      )
    ) {
      const raw = new Uint8Array(await upstreamResponse.arrayBuffer());
      const relabelled =
        raw.byteLength <= MAX_CAPABILITIES_BODY_BYTES
          ? relabelCapabilitiesBody(raw, decision.sessionBridgeLabel)
          : null;
      return new Response(relabelled ? new Uint8Array(relabelled) : raw, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers,
      });
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    });
  };
}

export function registerPlannotatorRelayRoutes(
  bb: BbPluginApi,
  sessions: RelaySessionMap,
  bbOrigin: () => string | undefined = () => undefined,
): void {
  const handler = createPlannotatorRelayHandler(sessions, PLANNOTATOR_RELAY_PATH, fetch, bbOrigin);
  for (const method of [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ]) {
    // The random session capability is the auth boundary. BB's local auth
    // intentionally rejects a Tailscale Host/Origin, while token auth would
    // require the remote browser to know a plugin secret.
    bb.http.route(method, PLANNOTATOR_RELAY_ROUTE, handler, { auth: "none" });
  }
}
