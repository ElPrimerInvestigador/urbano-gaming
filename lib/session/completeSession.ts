import type {
  SessionRepository,
  SessionCompletedEventRecord,
} from "./db/sessionRepository";
import type { CompleteSessionResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
} from "./types";

/**
 * COMPLETE_SESSION command handler — Interpretation 2 (administrative
 * termination): the host can end a session at any point, not only at
 * the natural conclusion of its content. This is deliberate: no later
 * lifecycle state (SESSION_INTRO, PROMPT_ACTIVE, RESULT_REVEAL, ...) is
 * reachable yet, so a "natural end" interpretation would be unreachable
 * through any real code path today. See the accompanying design
 * clarification for the full reasoning.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is not already SESSION_COMPLETE, and
 * atomically transitions it to SESSION_COMPLETE, incrementing
 * state_version and persisting a SESSION_COMPLETED event. Nothing else.
 *
 * Host-token and session-state authority: the getSessionById lookup
 * below is a fast-path check for immediate rejection (nonexistent
 * session, wrong host token, already-complete session) — it is NOT the
 * sole guarantee, the same way LOCK_LOBBY's lookup isn't. The
 * repository's completeSession call is the authoritative check,
 * re-verifying both the host token and the session state inside the
 * same atomic operation that performs the transition.
 */
export async function completeSession(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string
): Promise<CompleteSessionResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state === "SESSION_COMPLETE") {
    throw new SessionAlreadyCompleteError();
  }

  const event: SessionCompletedEventRecord = {
    sessionId: session.sessionId,
    eventType: "SESSION_COMPLETED",
    payload: {},
  };

  const result = await repo.completeSession(session.sessionId, hostToken, event);

  return {
    sessionId: session.sessionId,
    state: result.state,
    stateVersion: result.stateVersion,
  };
}
