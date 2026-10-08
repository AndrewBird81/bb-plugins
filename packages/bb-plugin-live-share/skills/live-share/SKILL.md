---
name: live-share
description: Explain or troubleshoot BB Live Share, which shares a thread and its workbench through a password-protected, end-to-end encrypted link that opens in any browser. Use when the user asks how to share a thread, join a share, change share access, or why a share link does not work.
---

# Live Share

Live Share lets a person share one BB thread with someone through a link that
opens in any browser. The guest needs no BB install. The guest page looks like
BB: the conversation plus a right panel that mirrors the host's tabs (Info,
Diff, open files, and a read-only mirror of the host's studio-code VS Code). Both people
see each other's cursors and text selections, in the conversation and in the
right panel.

## Where things are

- Host: open the thread, then choose **Share** in the thread header. The menu
  holds the access level, the password, the link, the people list, and
  **Stop sharing**. Guest cursors appear on the thread itself.
- Follow: a guest clicks an avatar to follow that person's view; the host
  chooses **Follow** next to a guest in the **Live** menu. Scrolling or
  clicking stops following.
- Guest: open the link in a browser, enter a name, then choose **Join**. The
  copied link carries the password in its `#p=` fragment, which never reaches
  a server. A link copied without the password also asks for it.

## Access levels

- `read`: watch only.
- `message`: also send messages. They wait in the queue if the agent is busy.
- `full`: also stop the agent.

## Settings

```sh
bb plugin config live-share                  # show settings
bb plugin config live-share set displayName "Ana"
bb plugin config live-share set exposure local   # loopback only, no public URL
bb plugin config live-share set exposure opentunnel
```

## Troubleshooting

- **No link yet.** The tunnel is still connecting. The first connection on a
  machine takes about 40 seconds. The Share menu shows the tunnel state.
- **"Wrong link or password."** Check both. After eight failures in ten
  minutes, sign-in for that share is locked until the ten minutes pass.
- **"Your session ended."** The host changed the password, removed the
  person, stopped sharing, or restarted BB. Enter the password again.
- **Link only works on the host's machine.** `exposure` is `local`. Set it to
  `opentunnel`.

Never ask the user for a share password, and never put one in a thread
message. The host sends it to the guest directly.
