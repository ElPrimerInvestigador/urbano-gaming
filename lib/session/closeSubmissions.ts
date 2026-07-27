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
 * Slice 001 (Session / Interaction separation): scope moves from the
 * session's own state to the session's current interaction instance.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is LOBBY_LOCKED and its current
 * interaction instance is PROMPT_ACTIVE, and atomically transitions
 * that interaction instance to SUBMISSIONS_CLOSED, persisting a
 * SUBMISSIONS_CLOSED event. Host-triggered only — no timers, no
 * background jobs, no automatic closure in this MVP.
 *
 * Host-token, session-state, and interaction-state authority: the
 * getSessionById / getInteractionInstancesForSession lookups below
 * are a fast-path check for immediate rejection — they are NOT the
 * sole guarantee, the same way every other command's lookup isn't.
 * The repository's closeSubmissions call is the authoritative check.
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

  const interactionInstances = await repo.getInteractionInstancesForSession(
    sessionId
  );
  const currentInteraction =
    interactionInstances.length > 0
      ? interactionInstances[interactionInstances.length - 1]
      : null;

  if (
    session.state !== "LOBBY_LOCKED" ||
    !currentInteraction ||
    currentInteraction.state !== "PROMPT_ACTIVE"
  ) {
    throw new PromptNotActiveError(currentInteraction?.state);
  }

  const event: SubmissionsClosedEventRecord = {
    sessionId: session.sessionId,
    eventType: "SUBMISSIONS_CLOSED",
    payload: {},
  };

  const result = await repo.closeSubmissions(session.sessionId, hostToken, event);

  return {
    sessionId: session.sessionId,
    interactionInstanceId: result.interactionInstanceId,
    state: result.state,
  };
}
