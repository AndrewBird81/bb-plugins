# bb-plugin-plannotator

This is a thin BB adapter around the official [Plannotator](https://github.com/backnotprop/plannotator) runtime. Plannotator owns the review experience; BB launches it in the thread's right panel and sends the decision to the agent as a new thread message.

## Staged preview

![Live BB screenshot of Plannotator settings](assets/staged-preview.png)

Captured from the running BB application with the bundled runtime selected.

## Install

```sh
bb plugin install git:https://github.com/AndrewBird81/bb-plugins.git@main --subdirectory packages/bb-plugin-plannotator
```

There is no separate Plannotator installation. On the first review, the plugin downloads the pinned official Plannotator release for the current OS/CPU, verifies its SHA-256 digest, and caches it under BB's plugin data directory. Later reviews use the cached runtime.

For development, offline use, or an independently updated upstream build, set **Plannotator binary** under BB → Extensions → Plannotator or set `PLANNOTATOR_BIN` for the BB server. Use `bundled` to restore the default.

Start a new agent session after installing or reloading. When the agent explicitly calls `plannotator_review_plan`, BB opens the upstream UI as a persistent right-panel tab. The tool returns a review ID promptly, and the agent ends its turn. Approve or annotate in the tab. BB then closes it and sends the decision as a new message in the same thread, which wakes the agent. The message is queued if the agent is still working. There is no BB review deadline or hidden interaction countdown: the review remains open until Plannotator returns a decision or you use **Cancel review** in the tab. Plannotator is optional, and its approval is not a permission grant. The child receives the current BB provider identity explicitly, rather than inferring it from unrelated host environment variables.

Only one review can be pending per thread. If you close its tab, open the **Plannotator** thread panel action to bring the pending review back. A second `plannotator_review_plan` call while a review is pending returns `status: "already_active"` with the pending review ID; it does not start a new review and is not a cancellation.

BB stores the review state until it delivers the decision. If the plugin restarts during a review, it sends a cancellation message after restarting. If delivery fails temporarily, it retries. The agent can call `plannotator_review_status` with the review ID to recover a missing result; it does not need to poll during a normal review.

Plannotator's plan history and configuration are stored under the plugin's BB data directory. Local child sessions use BB's session-scoped same-origin relay, and BB acknowledges the current upstream look-and-feel announcement before mounting the iframe, so the standalone setup wizard does not interrupt each review. The upstream plan UI remains otherwise unmodified. **Open externally** is available as a fallback, but external browser tabs may have a separate cookie jar from the BB panel.

## Code review and annotation

Besides plan review, the plugin opens three other Plannotator sessions. Each
runs where the thread runs, in its worktree, and one session is open per
thread at a time.

| Session | Agent tool | From BB |
|---|---|---|
| Code review of the worktree changes (default: all changes since the default branch, including uncommitted and untracked files) | `plannotator_review_changes` (`diffType`, `base`) | Panel: **Review changes** with a diff-type menu; palette: *Plannotator: Review changes* |
| Annotate a `.md`/`.markdown`/`.html`/`.htm` file inside the worktree | `plannotator_annotate_file` (`path`) | Panel: **Annotate file…** picker; palette: *Plannotator: Annotate file…* |
| Annotate a reply | `plannotator_annotate_reply` (`markdown`, default the thread's last reply) | Panel: **Annotate last reply**; message action **Annotate in Plannotator** (uses selected text when there is a selection); palette: *Plannotator: Annotate last reply* |

Plannotator writes each result to a file the plugin reads
(`PLANNOTATOR_HOST_RESULT_FILE`), so these sessions need plannotator 0.28.6 or
later. An agent's session always answers with a thread message. A session you
start yourself sends a message only when you send feedback; approving with no
notes, closing or cancelling sends nothing.

The plugin refuses to publish an annotation session whose agent terminal (a
shell in the browser) is on, or does not report its state. Code review runs
with `--no-git-remote-check`, so it compares against local refs. Sessions on
the BB server in remote mode run with sharing disabled.

## Remote BB and Tailscale access

When BB is configured with a non-loopback `BB_APP_URL` (for example, its
Tailscale hostname), or with `BB_SERVER_BIND_HOST=0.0.0.0`, the plugin starts
Plannotator in its supported remote mode. The upstream listener binds beyond
loopback and selects a port from `19432-19441`. The embedded panel uses a
session-scoped same-origin relay for local child listeners over both HTTP and
HTTPS, so a one-port Tailscale Serve endpoint is enough and the browser never
has to reach the upstream port directly. The relay accepts writes only from
the bb page's own origin, and never forwards a browser's `Authorization`
header or cookies. Local-only BB sessions use the same
relay while the review is open; **Open externally** can still use the direct
upstream port when the network allows it.

If you choose **Open externally** over plain HTTP, allow the `19432-19441` port
range between the Tailscale client and the BB machine. With the recommended
Tailscale Serve setup, no additional Plannotator port mapping is required on
the BB server machine; the plugin changes Tailscale configuration only on
other hosts, as described below.

## Threads on other machines

A review runs where the thread runs, in the thread's worktree, so linked
documents, repository info, and plan history come from that checkout.

- **Server machine:** the plugin starts Plannotator in the BB server process,
  as above, with the worktree as its working directory.
- **Any other bb host:** the plugin's `bb.host` entry starts `plannotator`
  from that host's `PATH` (never the bundled download) on a random loopback
  port, and a small proxy in the host worker on a loopback port in
  `19500-19509`. It publishes the proxy with
  `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` and the panel
  iframes `https://<host MagicDNS name>:<port>` directly. The host needs the
  `tailscale` CLI on `PATH` or at `/usr/local/bin/tailscale`, signed in with
  MagicDNS and HTTPS certificates enabled. Without it, the tool returns an
  error; it does not fall back to the server.

The host entry removes the serve mapping and stops Plannotator when the
review ends, is cancelled, or its worker stops. It records every process and
serve mapping it creates; a new worker removes recorded leftovers that still
proxy to `http://127.0.0.1:<same port>`, and never touches other serve
mappings. If a review moves to the next free port, a foreign mapping is left
alone. It never uses `tailscale funnel`. Decisions arrive by host signal,
backed by status polling; if the host disconnects or its worker dies, the
thread receives a cancellation message. Plan history on each host lives in the
plugin's host data directory.

The tailnet is the trust boundary, as for BB itself: anyone who can reach the
host's tailnet name can use the review while it is open. The proxy answers
only requests addressed to `<MagicDNS name>:<port>` (blocking DNS rebinding)
and accepts writes only from that origin (blocking cross-site requests from
other web pages), and lets only the bb page frame the review. It also denies
upstream endpoints a review never needs from another device (host control,
editor and note-app integrations, open-in-app, PR actions, the call-flow
runtime installer, file reads outside the worktree, custom save paths).
Plannotator's own random loopback port is not published, but, as with stock
local Plannotator, a web page in a browser on that host could still reach it
and use endpoints the proxy denies, such as open-in-app (which opens a repo
file with its default handler) and agent jobs. Browsers that block public
pages from reaching localhost, such as Brave by default, stop this.

## Boundary

BB does not intercept arbitrary provider text or require a plan review before
edits. The `plannotator_review_plan` tool is optional and opens the upstream UI
only when explicitly chosen. Native provider Plan mode is separate and remains
provider-controlled. Skipping or cancelling Plannotator does not authorize or
prohibit implementation.

The default runtime is pinned to the release listed in `src/bridge.ts`; upstream updates arrive through a plugin update. The upstream project is dual-licensed under Apache-2.0 or MIT, and the plugin does not copy or reimplement its UI.

The large platform binaries are intentionally provisioned on first use instead of committed to this repository. This keeps the plugin source and BB's own plugin artifacts manageable while preserving a one-plugin installation experience.
