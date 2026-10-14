# bb-plugin-plannotator

This is a thin BB adapter around the official [Plannotator](https://github.com/backnotprop/plannotator) runtime. Plannotator owns the review experience; BB launches it in the thread's right panel and sends the decision to the agent as a new thread message.

## Staged preview

![Live BB screenshot of Plannotator settings](assets/staged-preview.png)

Captured from the running BB application with the bundled runtime selected.

## Install

```sh
bb plugin install /Users/patrick/workingdir/bb-plugins/packages/bb-plugin-plannotator --yes
bb plugin reload plannotator
```

There is no separate Plannotator installation. On the first review, the plugin downloads the pinned official Plannotator release for the current OS/CPU, verifies its SHA-256 digest, and caches it under BB's plugin data directory. Later reviews use the cached runtime.

For development, offline use, or an independently updated upstream build, set **Plannotator binary** under BB → Extensions → Plannotator or set `PLANNOTATOR_BIN` for the BB server. Use `bundled` to restore the default.

Start a new agent session after installing or reloading. When the agent explicitly calls `plannotator_review_plan`, BB opens the upstream UI as a persistent right-panel tab. The tool returns a review ID promptly, and the agent ends its turn. Approve or annotate in the tab. BB then closes it and sends the decision as a new message in the same thread, which wakes the agent. The message is queued if the agent is still working. There is no BB review deadline or hidden interaction countdown: the review remains open until Plannotator returns a decision or you use **Cancel review** in the tab. Plannotator is optional, and its approval is not a permission grant. The child receives the current BB provider identity explicitly, rather than inferring it from unrelated host environment variables.

Only one review can be pending per thread. If you close its tab, open the **Plannotator** thread panel action to bring the pending review back. A second `plannotator_review_plan` call while a review is pending returns `status: "already_active"` with the pending review ID; it does not start a new review and is not a cancellation.

BB stores the review state until it delivers the decision. If the plugin restarts during a review, it sends a cancellation message after restarting. If delivery fails temporarily, it retries. The agent can call `plannotator_review_status` with the review ID to recover a missing result; it does not need to poll during a normal review.

Plannotator's plan history and configuration are stored under the plugin's BB data directory. Local child sessions use BB's session-scoped same-origin relay, and BB acknowledges the current upstream look-and-feel announcement before mounting the iframe, so the standalone setup wizard does not interrupt each review. The upstream plan UI remains otherwise unmodified. **Open externally** is available as a fallback, but external browser tabs may have a separate cookie jar from the BB panel.

## Remote BB and Tailscale access

When BB is configured with a non-loopback `BB_APP_URL` (for example, its
Tailscale hostname), or with `BB_SERVER_BIND_HOST=0.0.0.0`, the plugin starts
Plannotator in its supported remote mode. The upstream listener binds beyond
loopback and selects a port from `19432-19441`. The embedded panel uses a
session-scoped same-origin relay for local child listeners over both HTTP and
HTTPS, so a one-port Tailscale Serve endpoint is enough and the browser never
has to reach the upstream port directly. Local-only BB sessions use the same
relay while the review is open; **Open externally** can still use the direct
upstream port when the network allows it.

If you choose **Open externally** over plain HTTP, allow the `19432-19441` port
range between the Tailscale client and the BB machine. With the recommended
Tailscale Serve setup, no additional Plannotator port mapping is required; this
plugin does not modify the machine's Tailscale configuration.

## Threads on other machines

A review runs where the thread runs, in the thread's worktree, so linked
documents, repository info, and plan history come from that checkout.

- **Server machine:** the plugin starts Plannotator in the BB server process,
  as above, with the worktree as its working directory.
- **Any other bb host:** the plugin's `bb.host` entry starts `plannotator`
  from that host's `PATH` (never the bundled download), bound to loopback on
  a port in `19500-19509`. It publishes the port with
  `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` and the panel
  iframes `https://<host MagicDNS name>:<port>` directly. The host needs the
  `tailscale` CLI on `PATH` or at `/usr/local/bin/tailscale`, signed in with
  MagicDNS and HTTPS certificates enabled. Without it, the tool returns an
  error; it does not fall back to the server.

The host entry removes the serve mapping and stops Plannotator when the
review ends, is cancelled, or its worker stops. On worker start it removes
mappings left by a crashed worker, but only mappings in `19500-19509` that
proxy to `http://127.0.0.1:<same port>`. It never touches other serve
mappings. It never uses `tailscale funnel`. Decisions arrive by host signal,
backed by status polling; if the host disconnects or its worker dies, the
thread receives a cancellation message. Plan history on each host lives in the
plugin's host data directory.

Anyone who can reach the host's tailnet name can use the review while it is
open, as with BB itself on a tailnet.

## Boundary

BB does not intercept arbitrary provider text or require a plan review before
edits. The `plannotator_review_plan` tool is optional and opens the upstream UI
only when explicitly chosen. Native provider Plan mode is separate and remains
provider-controlled. Skipping or cancelling Plannotator does not authorize or
prohibit implementation.

The default runtime is pinned to the release listed in `src/bridge.ts`; upstream updates arrive through a plugin update. The upstream project is dual-licensed under Apache-2.0 or MIT, and the plugin does not copy or reimplement its UI.

The large platform binaries are intentionally provisioned on first use instead of committed to this repository. This keeps the plugin source and BB's own plugin artifacts manageable while preserving a one-plugin installation experience.
