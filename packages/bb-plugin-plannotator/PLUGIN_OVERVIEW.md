Review a plan in Plannotator without keeping an agent tool call open while you decide.

## How it works

When an agent calls `plannotator_review_plan`, the plugin opens the official Plannotator app in the BB thread panel. The tool returns a review ID promptly so the agent can end its turn. Approve the plan or send annotated feedback in Plannotator. The plugin sends that decision as a new message in the same thread and wakes the agent.

If the agent misses a decision, it can check `plannotator_review_status` with the review ID. The plugin retains decisions for recovery and retries temporary message delivery failures. A review interrupted by a plugin restart sends a cancellation message.

## Requirements

On the BB server machine, the plugin downloads a pinned official Plannotator binary on first use and caches it locally. You can configure another binary in the plugin settings. Threads on other machines run `plannotator` from that machine's `PATH` in the thread's worktree, published with Tailscale Serve, so those machines need Plannotator and the Tailscale CLI installed. Reviews are optional and remain separate from an agent provider's native Plan mode.
