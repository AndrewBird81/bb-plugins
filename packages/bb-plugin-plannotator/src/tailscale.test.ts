import { describe, expect, it } from "vitest";
import {
  ownedServePorts,
  parseServeStatus,
  parseStatusDnsName,
  serveArgs,
  serveOffArgs,
  servePortInUse,
} from "./tailscale";

const range = { first: 19500, last: 19509 };

// Shapes copied from `tailscale serve status --json` on tailscale 1.104.
function webMapping(host: string, port: number, proxy: string) {
  return { [`${host}:${port}`]: { Handlers: { "/": { Proxy: proxy } } } };
}

describe("tailscale CLI parsing", () => {
  it("builds serve argv without a shell", () => {
    expect(serveArgs(19500)).toEqual([
      "serve",
      "--bg",
      "--https=19500",
      "http://127.0.0.1:19500",
    ]);
    expect(serveOffArgs(19500)).toEqual(["serve", "--https=19500", "off"]);
  });

  it("reads the MagicDNS name only from a running backend", () => {
    expect(
      parseStatusDnsName(
        JSON.stringify({ BackendState: "Running", Self: { DNSName: "Mac.tailnet-example.ts.net." } }),
      ),
    ).toBe("mac.tailnet-example.ts.net");
    expect(
      parseStatusDnsName(
        JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "mac.tailnet-example.ts.net." } }),
      ),
    ).toBeNull();
    expect(parseStatusDnsName(JSON.stringify({ BackendState: "Running", Self: {} }))).toBeNull();
    expect(parseStatusDnsName("not json")).toBeNull();
  });

  it("fails closed on unrecognized serve status", () => {
    expect(parseServeStatus("")).toBeNull();
    expect(parseServeStatus("[]")).toBeNull();
    expect(parseServeStatus('{"TCP":[]}')).toBeNull();
    expect(parseServeStatus("null")).toEqual({});
    expect(parseServeStatus("{}")).toEqual({});
  });

  it("detects background and foreground use of a port", () => {
    const status = parseServeStatus(
      JSON.stringify({
        TCP: { "33757": { HTTPS: true } },
        Foreground: { session: { TCP: { "19501": { HTTPS: true } } } },
      }),
    )!;
    expect(servePortInUse(status, 33757)).toBe(true);
    expect(servePortInUse(status, 19501)).toBe(true);
    expect(servePortInUse(status, 19500)).toBe(false);
  });

  it("claims only exact loopback mappings in its own range", () => {
    const host = "mac.tailnet-example.ts.net";
    const status = parseServeStatus(
      JSON.stringify({
        TCP: {
          "33757": { HTTPS: true },
          "8447": { HTTPS: true },
          "19500": { HTTPS: true },
          "19501": { HTTPS: true },
          "19502": { HTTPS: true },
          "19503": { HTTPS: true },
        },
        Web: {
          ...webMapping(host, 33757, "http://127.0.0.1:33757"),
          ...webMapping(host, 8447, "http://127.0.0.1:8000"),
          ...webMapping(host, 19500, "http://127.0.0.1:19500"),
          // In range, but proxies somewhere else: not ours.
          ...webMapping(host, 19501, "http://127.0.0.1:3000"),
          // In range, extra handler: not ours.
          [`${host}:19502`]: {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:19502" },
              "/api": { Proxy: "http://127.0.0.1:4000" },
            },
          },
          ...webMapping(host, 19503, "http://127.0.0.1:19503"),
        },
      }),
    )!;
    expect(ownedServePorts(status, range)).toEqual([19500, 19503]);
  });
});
