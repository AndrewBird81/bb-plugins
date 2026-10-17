---
name: plan-review
description: Optional upstream Plannotator review UI for plans in BB.
---

# Optional Plannotator plan review

This is opt-in reference material. Plannotator is never an authorization gate
in BB: agents may edit, implement, or continue work without opening it. Do not
invoke `plannotator_review_plan` unless the user explicitly asks for
Plannotator or a plan review.

Native provider Plan mode is a separate provider-controlled workflow. This
reference does not enable it, replace it, or require either workflow.

When the user does request Plannotator, call `plannotator_review_plan` with the
complete Markdown plan. A review is informational and collaborative; its
approval is not a permission grant, and cancellation or omission never blocks
implementation.

The tool opens the upstream Plannotator app in BB's right panel and returns a
pending review ID. End the turn and wait for BB to send the decision as a new
message in the same thread. Do not poll for the decision. Use
`plannotator_review_status` with the review ID only to recover a missing result.

The decision message has one of these results:

- `decision=approved`: report the approval and continue as appropriate.
- `decision=changes_requested`: revise the plan to address the feedback, then
  call `plannotator_review_plan` again with the whole revised plan.
- `decision=cancelled`: report the cancellation, then continue normally unless
  the user specifically asked to stop.

If the tool returns `status=already_active`, no new review started and nothing
was cancelled. Tell the user a review is still pending (give its `reviewId`)
and that they can reopen it from the Plannotator thread panel action.

Do not claim a review decision from the presence of a panel or the pending
tool result alone. Only the later decision message describes what happened in
Plannotator; it does not authorize or prohibit file changes.

## Code review and annotation

The same rules apply to `plannotator_review_changes` (the worktree changes),
`plannotator_annotate_file` (a Markdown or HTML file in the worktree) and
`plannotator_annotate_reply` (the last reply, or `markdown` you pass, such as
text from the current turn). Use them only when the user asks. Each returns a
pending review ID; end the turn and wait for the result message. A result with
annotations is the user's feedback to address; approval or dismissal with no
annotations means no changes were requested. The user can also start these
from the bb panel; those results arrive as messages only when they contain
feedback.
