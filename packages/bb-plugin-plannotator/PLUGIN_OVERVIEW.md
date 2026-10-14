Review a plan in Plannotator without keeping an agent tool call open while you decide.

## What you get

- **Plan review:** an agent calls `plannotator_review_plan`; you approve or annotate the plan.
- **Code review:** review the thread's worktree changes (all changes since the default branch by default) with `plannotator_review_changes` or from the panel.
- **Annotate a document:** annotate a Markdown or HTML file from the worktree with `plannotator_annotate_file` or the panel's file picker.
- **Annotate a reply:** annotate the agent's last reply, or any message from its action bar, with `plannotator_annotate_reply`.

The Plannotator panel and three palette commands start code reviews and annotations yourself. Feedback you send arrives in the thread as a new message; closing without feedback sends nothing.

## How it works

When an agent calls `plannotator_review_plan`, the plugin opens the official Plannotator app in the BB thread panel. The tool returns a review ID promptly so the agent can end its turn. Approve the plan or send annotated feedback in Plannotator. The plugin sends that decision as a new message in the same thread and wakes the agent.

If the agent misses a result, it can check `plannotator_review_status` with the review ID. The plugin retains decisions for recovery and retries temporary message delivery failures. A review interrupted by a plugin restart sends a cancellation message.

## Requirements

On the BB server machine, the plugin downloads a pinned official Plannotator binary on first use and caches it locally. You can configure another binary in the plugin settings. Threads on other machines run `plannotator` from that machine's `PATH` in the thread's worktree, published with Tailscale Serve, so those machines need Plannotator and the Tailscale CLI installed. Reviews are optional and remain separate from an agent provider's native Plan mode.
