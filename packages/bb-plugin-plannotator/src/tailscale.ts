// Pure parsers and argv builders for the `tailscale` CLI. Nothing here spawns
// a process; the host runtime runs these argv lists without a shell.

/** Used when `tailscale` is not on the daemon's PATH (the macOS app's CLI). */
export const TAILSCALE_FALLBACK_PATH = "/usr/local/bin/tailscale";

export type PortRange = { readonly first: number; readonly last: number };

type ServeHandler = { Proxy?: unknown };
type ServeStatus = {
  TCP?: Record<string, unknown> | null;
  Web?: Record<string, { Handlers?: Record<string, ServeHandler> } | null> | null;
  Foreground?: Record<string, { TCP?: Record<string, unknown> | null } | null> | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The local URL a published port proxies to. This is the one place that
 * decides what `tailscale serve` points at; ownership checks use it too.
 */
export function serveTarget(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function serveArgs(port: number): string[] {
  return ["serve", "--bg", `--https=${port}`, serveTarget(port)];
}

export function serveOffArgs(port: number): string[] {
  return ["serve", `--https=${port}`, "off"];
}

/**
 * This machine's MagicDNS name from `tailscale status --json`, or null when
 * Tailscale is not running or reports no name.
 */
export function parseStatusDnsName(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.BackendState !== "Running") return null;
  const self = parsed.Self;
  if (!isRecord(self) || typeof self.DNSName !== "string") return null;
  const name = self.DNSName.trim().replace(/\.+$/u, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/iu.test(name) ? name.toLowerCase() : null;
}

/**
 * Parse `tailscale serve status --json`. Returns null for output we do not
 * recognize so callers fail closed instead of assuming a port is free.
 */
export function parseServeStatus(stdout: string): ServeStatus | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  // `null` and `{}` both mean there is no serve configuration.
  if (parsed === null) return {};
  if (!isRecord(parsed)) return null;
  for (const key of ["TCP", "Web", "Foreground"] as const) {
    const value = parsed[key];
    if (value !== undefined && value !== null && !isRecord(value)) return null;
  }
  return parsed as ServeStatus;
}

/** Whether any background or foreground serve config already uses this port. */
export function servePortInUse(status: ServeStatus, port: number): boolean {
  const key = String(port);
  if (status.TCP && key in status.TCP) return true;
  for (const session of Object.values(status.Foreground ?? {})) {
    if (session?.TCP && key in session.TCP) return true;
  }
  return false;
}

/**
 * Background mappings in `range` that look exactly like the ones this plugin
 * creates: HTTPS on port P with a single `/` handler proxying to
 * `serveTarget(P)`. Anything else, including other ports, is not ours.
 */
export function ownedServePorts(status: ServeStatus, range: PortRange): number[] {
  const owned: number[] = [];
  for (const [key, tcp] of Object.entries(status.TCP ?? {})) {
    const port = Number(key);
    if (!Number.isInteger(port) || port < range.first || port > range.last) continue;
    if (!isRecord(tcp) || tcp.HTTPS !== true) continue;
    const webEntries = Object.entries(status.Web ?? {}).filter(([hostPort]) =>
      hostPort.endsWith(`:${port}`),
    );
    if (webEntries.length === 0) continue;
    const expectedProxy = serveTarget(port);
    const allOurs = webEntries.every(([, web]) => {
      const handlers = web?.Handlers;
      if (!isRecord(handlers)) return false;
      const paths = Object.keys(handlers);
      return (
        paths.length === 1 &&
        paths[0] === "/" &&
        isRecord(handlers["/"]) &&
        handlers["/"].Proxy === expectedProxy
      );
    });
    if (allOurs) owned.push(port);
  }
  return owned.sort((left, right) => left - right);
}
