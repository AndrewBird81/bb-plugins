// Access levels, kept free of runtime dependencies so the guest page can
// import them without bundling zod.
export const accessLevels = ["read", "message", "full"] as const;
export type Access = (typeof accessLevels)[number];

export const accessLabels: Record<Access, string> = {
  read: "Read only",
  message: "Send messages",
  full: "Full access",
};

/** How the guest page names the guest's own access. */
export const guestAccessLabels: Record<Access, string> = {
  read: "View only",
  message: "Can send messages",
  full: "Full access",
};

export const accessDescriptions: Record<Access, string> = {
  read: "Watch the conversation and changes.",
  message: "Also send messages to the agent.",
  full: "Also stop the agent mid-turn.",
};

export function canSend(access: Access): boolean {
  return access === "message" || access === "full";
}

export function canControl(access: Access): boolean {
  return access === "full";
}
