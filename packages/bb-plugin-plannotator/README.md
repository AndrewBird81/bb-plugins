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

Known limitation: an HTML file that sets no colors of its own can show black
text on Plannotator's dark background. Plannotator leaves the styling of
arbitrary HTML to the document, so give such a page its own background color.

## Remote BB and Tailscale access

On the BB server machine, Plannotator always binds loopback. When BB is
configured with a non-loopback `BB_APP_URL` (for example, its Tailscale
hostname), or with `BB_SERVER_BIND_HOST=0.0.0.0`, it picks a port from
`19432-19441`. Browsers reach it only through BB's session-scoped same-origin
relay, so a one-port Tailscale Serve endpoint for BB is enough. The relay
applies the same request filter as the proxy on other hosts (below): writes
only from the bb page's origin, the same endpoint denylist and worktree path
checks, no WebSocket upgrades, and it never forwards a browser's
`Authorization` header or cookies. Sessions on the BB server also run with
Plannotator's sharing (paste service uploads) disabled. A session for a thread
without a worktree on the server machine runs in an empty temporary
directory, never the BB server's own working directory. Known limitation: an
annotated HTML file's relative assets (images, stylesheets) do not load
through the relay, because its `<base>` points at BB's own origin and BB's
plugin routes are exact-match. The plugin changes
Tailscale configuration only on other hosts, as described below.

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
  MagicDNS and HTTPS certificates enabled. Plannotator 0.28.20 and later
  answer only loopback Hosts and the names in `PLANNOTATOR_ALLOWED_HOSTS`,
  so the plugin sets it to exactly the host's MagicDNS name, which the proxy
  forwards (no wildcard); earlier versions ignore it.

The setting **Run reviews on** chooses where a session runs:

- `auto` (default): on the thread's machine when it is not the BB server and
  can publish with tailscale serve (plannotator on `PATH`, tailscale signed
  in); otherwise on the BB server, as before this feature.
- `thread`: always on the thread's machine; an error if it cannot publish.
- `server`: always on the BB server.

The tool result reports where the session runs (`runsOn`) and why
(`runsOnReason`). On the BB server, a session for a thread on another machine
cannot read that thread's worktree, so code review and file annotation need
the thread's machine.

The host entry removes the serve mapping and stops Plannotator when the
review ends, is cancelled, or its worker stops. It records every process and
serve mapping it creates; a new worker removes recorded leftovers that still
proxy to `http://127.0.0.1:<same port>`, and never touches other serve
mappings. If a review moves to the next free port, a foreign mapping is left
alone. It never uses `tailscale funnel`. Decisions arrive by host signal,
backed by status polling; if the host disconnects or its worker dies, the
thread receives a cancellation message. If the BB server restarts during a
review, a decision the host kept is still delivered once the host answers,
but a review that is still open is cancelled: its panel cannot be reattached.
Plan history on each host lives in the plugin's host data directory.

Known limitations, from how Plannotator stores its data: plan versions,
history and annotation drafts are shared by every thread whose sessions run on
the same host (the BB server counts as one). Plannotator finds a plan's
earlier version by repository name and plan heading, so a thread's first plan
can show up as version 2 of another thread's plan with the same heading, and
it keys drafts by content, so two sessions of the same file offer each
other's draft. A plain link to a repository file that is not a document (such
as `pic.svg`) does not open the file on any host.

The tailnet is the trust boundary, as for BB itself: anyone who can reach the
host's tailnet name can use the review while it is open. The proxy answers
only requests addressed to `<MagicDNS name>:<port>` (blocking DNS rebinding)
and accepts writes only from that origin (blocking cross-site requests from
other web pages), and lets only the bb page frame the review. It also denies
upstream endpoints a review never needs from another device (host control,
editor and note-app integrations, open-in-app, PR actions, the call-flow
runtime installer, Plannotator's self-update, file reads outside the worktree,
custom save paths). It refuses a second approve or deny of a plan review,
which Plannotator would answer as sent and then drop, and serves SVG and other
XML with an empty sandbox policy, so an image opened in its own tab cannot run
script on the review's origin (the relay does the same on BB's origin). It
answers the open-in-app list itself, as Plannotator does for a remote
session (none available), so that control stays hidden.
Plannotator's own random loopback port is not published, but, as with stock
local Plannotator, a web page in a browser on that host can still send it
requests, skipping the proxy's checks. What that page can do depends on the
host's plannotator:

- **0.28.20 and later:** Plannotator refuses any Host other than loopback and
  the allowed MagicDNS name, so DNS rebinding fails and the page cannot read
  Plannotator's responses. Without them it cannot find an Ask AI session, so
  it cannot reach the thread's agent. It can still send blind `text/plain`
  POSTs to `http://127.0.0.1:<port>`: Plannotator checks their Origin only for
  config and source-save writes, so a forged approve or deny, open-in-app
  (which opens a repo file with its default handler) and agent jobs remain
  reachable.
- **Earlier versions:** the page can also use DNS rebinding to read session
  ids and, in `thread` mode, ask Ask AI, which runs the thread's agent in a
  hidden fork with its tools (see [Ask AI](#ask-ai)).

Browsers that block public pages from reaching localhost, such as Brave by
default, stop all of this.

## Ask AI

Plannotator's **Ask AI** panel can be answered by the thread's own agent. The
setting **Ask AI answers from** chooses:

- `thread` (default): each Ask AI chat is answered in a hidden fork of the
  thread, which has the whole conversation and works in the same worktree. A
  follow-up in the same chat goes to the same fork. The user's thread is never
  interrupted or waited on. When the session ends, its forks are stopped and
  archived. The plugin records each fork it creates in its own storage and
  stops or archives a thread only when it is recorded there and bb reports it
  as this plugin's hidden fork of that thread; recorded forks a crash left
  behind are archived when the plugin next starts. The result message the
  agent receives lists the questions and answers (a few KB at most) as a
  quoted block labelled as reviewer Q&A data, not instructions. This needs a
  thread provider that can fork; for one that can't, or when the plugin cannot
  look the provider up, the session uses `local` instead, and the tool result
  says so (`askAiAnswersFrom`, `askAiReason`).
- `local`: the AI tools installed on the thread's machine (Claude, Codex, Pi,
  OpenCode), which start without the conversation. This is Plannotator's own
  behaviour.

In `thread` mode the plugin starts Plannotator with its "Ask this session" pull
bridge (`PLANNOTATOR_SESSION_BRIDGE_*`). The bridge's token is generated where
Plannotator runs and never reaches a browser; the plugin server reaches the
bridge directly on the BB server, and through the host entry's `bridgeFetch`
on other hosts. Upstream's bridge knows only Claude Code, Pi, OpenCode and T3
Code, and names that host in the provider's label, so a Codex thread runs the
bridge as OpenCode. The review proxy and the relay replace that label in
`GET /api/ai/capabilities` with the thread's provider as BB names it ("Ask this
session · Codex"), or plain "Ask this session" when BB gives no name. An answer can take up to 10 minutes before the fork is stopped.

Security: in `thread` mode, anyone who can reach an open review can make the
thread's agent run, in a hidden fork with its tools, in the worktree.
Plannotator's Ask AI header asks the agent not to edit files, but that is
guidance, not a sandbox. Upstream disables this bridge for sessions reachable
over a network ("anyone who can reach the session URL could type into the agent
session"). BB differs because BB itself has no authentication on a tailnet:
anyone who can reach a review can already reach BB and message the thread
directly, so the bridge adds no new trust boundary. Choose `local` if that does
not hold for your setup.

The reviewed document is a second way in. Plannotator puts the text a user
selects into the Ask AI question verbatim, so a document with instructions in
it (for example "run this command before answering") reaches the fork's agent
when a user selects that text and asks about it. The fork keeps the thread's
permission mode, because a hidden fork cannot show approval prompts, so it can
act on them as the thread could. A hostile document cannot ask on its own: the
user has to select the text and ask. The answers then reach the thread in the
result message, quoted and labelled as data rather than instructions, which
lowers but does not remove the chance the thread's agent follows them. Don't
use Ask AI on text from documents you don't trust.

## Boundary

BB does not intercept arbitrary provider text or require a plan review before
edits. The `plannotator_review_plan` tool is optional and opens the upstream UI
only when explicitly chosen. Native provider Plan mode is separate and remains
provider-controlled. Skipping or cancelling Plannotator does not authorize or
prohibit implementation.

The default runtime is pinned to the release listed in `src/bridge.ts`; upstream updates arrive through a plugin update. The upstream project is dual-licensed under Apache-2.0 or MIT, and the plugin does not copy or reimplement its UI.

The large platform binaries are intentionally provisioned on first use instead of committed to this repository. This keeps the plugin source and BB's own plugin artifacts manageable while preserving a one-plugin installation experience.
