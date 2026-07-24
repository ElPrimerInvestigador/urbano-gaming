import type {
  SessionRepository,
  SubmissionsClosedEventRecord,
} from "./db/sessionRepository";
import type { CloseSubmissionsResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  PromptNotActiveError,
} from "./types";

/**
 * CLOSE_SUBMISSIONS command handler.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is PROMPT_ACTIVE, and atomically
 * transitions it to SUBMISSIONS_CLOSED, incrementing state_version and
 * persisting a SUBMISSIONS_CLOSED event. Host-triggered only — no
 * timers, no background jobs, no automatic closure in this MVP.
 *
 * Host-token and session-state authority: the getSessionById lookup
 * below is a fast-path check for immediate rejection — it is NOT the
 * sole guarantee, the same way every other command's lookup isn't. The
 * repository's closeSubmissions call is the authoritative check.
 */
export async function closeSubmissions(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string
): Promise<CloseSubmissionsResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state !== "PROMPT_ACTIVE") {
    throw new PromptNotActiveError(session.state);
  }

  const event: SubmissionsClosedEventRecord = {
    sessionId: session.sessionId,
    eventType: "SUBMISSIONS_CLOSED",
    payload: {},
  };

  const result = await repo.closeSubmissions(session.sessionId, hostToken, event);

  return {
    sessionId: session.sessionId,
    state: result.state,
    stateVersion: result.stateVersion,
  };
}
