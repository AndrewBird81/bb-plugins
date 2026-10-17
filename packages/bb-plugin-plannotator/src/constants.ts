export const PANEL_ACTION_ID = "plannotator-review";
/** The panel tab's title while it shows the launcher. */
export const PANEL_TITLE = "Plannotator";
export const PLANNOTATOR_RELAY_PATH =
  "/api/v1/plugins/plannotator/http/review";
export const PLANNOTATOR_REALTIME_CHANNEL = "review-opened";
/** Upstream's per-message cap for annotate-last. */
export const MAX_ANNOTATE_MARKDOWN = 2 * 1024 * 1024;
/** Why no session starts in an archived thread: it takes no messages. */
export const ARCHIVED_THREAD_MESSAGE =
  "This thread is archived, so Plannotator feedback could not reach it. Unarchive the thread to start a session.";
