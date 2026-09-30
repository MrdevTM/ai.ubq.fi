// `/v1/live` dispatch: authenticate once, then route to call creation or the
// sideband bridge.

import { authenticateClient } from "../auth/index.ts";
import { withCors } from "../http.ts";
import { normalizePath, withRequestId } from "../handler/http.ts";
import { handleLiveCallCreate } from "./calls.ts";
import { liveRouteForRequest } from "./routes.ts";
import { handleLiveSideband } from "./sideband.ts";

/**
 * Serves the Codex realtime voice relay; null when the request is not a
 * `/v1/live` route.
 *
 * The two JSON arms receive the standard `withCors`/`withRequestId`
 * decorations here instead of in `src/handler/index.ts`, because the sideband's
 * 101 upgrade response must be returned exactly as `Deno.upgradeWebSocket`
 * produced it: wrapping it in a new `Response` drops the associated socket.
 * Authentication runs before either arm, and before the sideband upgrade reads
 * nothing but headers - reading the request body would fail the handshake.
 */
export const handleLiveRoute = async (req: Request, requestId: string): Promise<Response | null> => {
  const route = liveRouteForRequest(req.method, normalizePath(new URL(req.url).pathname));
  if (route === null) return null;

  const authResult = await authenticateClient(req);
  if (!authResult.ok) return withRequestId(withCors(authResult.response, req), requestId);

  const response = route.kind === "call" ? await handleLiveCallCreate(req) : await handleLiveSideband(req, route.callId);
  if (response.status === 101) return response;
  return withRequestId(withCors(response, req), requestId);
};
