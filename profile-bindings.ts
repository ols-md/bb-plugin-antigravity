import { createHash } from "node:crypto";

const PROFILE_ID_PREFIX = "antigravity-profile:";
const PROFILE_ID_VERSION = "1:";

export const ANTIGRAVITY_PROFILE_MISMATCH_MESSAGE =
  "Cannot continue this Antigravity session on a different profile. Re-enable profile routing and restore the original profile, or start a new thread.";

export const ANTIGRAVITY_INVALID_PROFILE_MESSAGE =
  "Cannot bind this Antigravity session to a profile. Check the profile directory settings and try again.";

export function hashAntigravityProfile(profile: string[]): string {
  return digest(profile);
}

function digest(values: string[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

export function encodeProfileSessionId(threadId: string, sessionId: string, profileHash: string): string {
  return PROFILE_ID_PREFIX + PROFILE_ID_VERSION + digest([threadId, sessionId, profileHash]) + ":" + sessionId;
}

// undefined is a legacy/default ID; null is a malformed or unsupported routing marker.
export function decodeProfileSessionId(value: unknown): { binding: string; sessionId: string } | null | undefined {
  if (typeof value !== "string" || !value.startsWith(PROFILE_ID_PREFIX)) return undefined;
  const payload = value.slice(PROFILE_ID_PREFIX.length);
  if (!payload.startsWith(PROFILE_ID_VERSION)) return null;
  const match = /^([a-f0-9]{64}):([\s\S]+)$/.exec(payload.slice(PROFILE_ID_VERSION.length));
  return match ? { binding: match[1], sessionId: match[2] } : null;
}

export function matchesProfileSessionId(
  threadId: string,
  id: { binding: string; sessionId: string },
  profileHash: string,
): boolean {
  return id.binding === digest([threadId, id.sessionId, profileHash]);
}
