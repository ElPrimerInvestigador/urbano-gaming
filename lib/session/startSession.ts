import type { SessionRepository } from "./db/sessionRepository";
import type { StartSessionResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
} from "./types";

/**
 * START_SESSION command handler.
 *
 * Scope: authenticates the caller as the session's host via the stored
 * host token, verifies the session is LOBBY_LOCKED, and atomically
 * transitions it to PROMPT_ACTIVE, selecting a prompt, incrementing
 * state_version, and persisting a SESSION_STARTED event. Nothing else —
 * no SESSION_INTRO (excluded from the MVP until it has defined product
 * meaning), no submissions, no rounds.
 *
 * current_prompt_id is an explicit MVP optimization, not a commitment
 * to the long-term gameplay model — a future "rounds" concept may
 * eventually own prompt selection instead of the session row directly.
 *
 * Host-token and session-state authority: the getSessionById lookup
 * below is a fast-path check for immediate rejection (nonexistent
 * session, wrong host token, obviously-not-locked session) — it is NOT
 * the sole guarantee, the same way LOCK_LOBBY's lookup isn't. The
 * repository's startSession call is the authoritative check,
 * re-verifying both the host token and the session state — and
 * selecting the prompt — inside the same atomic operation that performs
 * the transition.
 */
export async function startSession(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string
): Promise<StartSessionResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state !== "LOBBY_LOCKED") {
    throw new LobbyNotLockedError(session.state);
  }

  const result = await repo.startSession(session.sessionId, hostToken);

  return {
    sessionId: session.sessionId,
    state: result.state,
    stateVersion: result.stateVersion,
    currentPromptId: result.currentPromptId,
  };
}
