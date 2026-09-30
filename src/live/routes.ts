// Pure route matcher for the Codex realtime voice relay (`/v1/live`).

/** `call` is the multipart SDP call creation; `sideband` is the call's socket join. */
export type LiveRoute = Readonly<{ kind: "call" }> | Readonly<{ kind: "sideband"; callId: string }>;

/**
 * `POST /v1/live` creates one realtime call and `GET /v1/live/<call_id>` joins
 * its sideband. Callers pass the normalized path (`normalizePath` strips
 * trailing slashes) and the call id must be exactly one path segment, because
 * the Codex client appends the id from the call-creation `Location` as a single
 * percent-encoded segment and itself rejects `.` and `..`.
 */
export const liveRouteForRequest = (method: string, path: string): LiveRoute | null => {
  if (method === "POST" && path === "/v1/live") return { kind: "call" };
  if (method !== "GET") return null;
  const match = /^\/v1\/live\/([^/]+)$/.exec(path);
  if (!match) return null;
  let callId: string;
  try {
    callId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (callId === "" || callId === "." || callId === "..") return null;
  return { kind: "sideband", callId };
};
