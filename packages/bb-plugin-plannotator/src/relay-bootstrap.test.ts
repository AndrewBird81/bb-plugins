// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://bb.example/api/v1/plugins/plannotator/http/review?sessionId=session-1&path=%2F" }
import { describe, expect, it } from "vitest";
import { injectRelayBootstrap } from "./relay";

const RELAY_PATH = "/api/v1/plugins/plannotator/http/review";
const relayed = (path: string) =>
  `https://bb.example${RELAY_PATH}?sessionId=session-1&path=${encodeURIComponent(path)}`;

/** Run the bootstrap in this document, as the relayed app page does. */
function runBootstrap(): void {
  const html = injectRelayBootstrap("<head></head>", RELAY_PATH, "session-1");
  const script = /<script data-bb-plannotator-relay>([\s\S]*)<\/script>/u.exec(html)![1]!;
  // The bootstrap wraps fetch, which this environment does not provide.
  (window as unknown as { fetch: unknown }).fetch ??= () => undefined;
  window.eval(script);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("relay bootstrap", () => {
  it("rewrites root-relative URLs in the page, in subtrees React inserts later, and in changed attributes", async () => {
    document.body.innerHTML = '<img id="initial" src="/favicon.png">';
    runBootstrap();
    expect(document.getElementById("initial")!.getAttribute("src")).toBe(relayed("/favicon.png"));

    const tree = document.createElement("div");
    tree.innerHTML = '<p><img src="/api/image?path=a.png"><a href="/api/doc?path=b.md">b</a><a href="notes.md">c</a></p>';
    document.body.append(tree);
    await settle();
    expect(tree.querySelector("img")!.getAttribute("src")).toBe(relayed("/api/image?path=a.png"));
    expect(tree.querySelector("a")!.getAttribute("href")).toBe(relayed("/api/doc?path=b.md"));
    expect(tree.querySelectorAll("a")[1]!.getAttribute("href")).toBe("notes.md");

    tree.querySelector("img")!.setAttribute("src", "/api/image?path=c.png");
    await settle();
    expect(tree.querySelector("img")!.getAttribute("src")).toBe(relayed("/api/image?path=c.png"));
  });
});
